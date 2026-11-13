import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile, rename, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateStudioPublication } from '../scripts/validate-studio-publication.mjs';
import { studioHashes } from '../scripts/studio-artifact.mjs';
import { signManifest } from '../scripts/studio-signature.mjs';

async function fixture(t, { signWith } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-pr-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  await cp(new URL('../vendor', import.meta.url), join(directory, 'vendor'), { recursive: true });
  // Rollout independence: once the publisher signs, the checkout this fixture
  // copies already carries vendor/studio-build.json.sig. Every fixture starts
  // from a known state; the tests that need a signature write their own.
  await rm(join(directory, 'vendor/studio-build.json.sig'), { force: true });
  if (signWith) {
    // A baseline that already carries a signature, as `main` does once #153 lands.
    await writeFile(
      join(directory, 'vendor/studio-build.json.sig'),
      signManifest(await readFile(join(directory, 'vendor/studio-build.json')), signWith),
    );
  }
  await mkdir(join(directory, '.github/workflows'), { recursive: true });
  await mkdir(join(directory, 'scripts'));
  for (const path of ['.github/workflows/studio-publication.yml', 'scripts/validate-studio-publication.mjs']) {
    await writeFile(join(directory, path), 'baseline trusted code');
  }
  const commit = () => { git('add', '-A'); git('commit', '--allow-empty', '-m', 'fixture'); return git('rev-parse', 'HEAD'); };
  const baseline = commit();
  // Production input is GitHub's pull request file list, which reports both sides
  // of a rename. The fixture builds the same shape from its own repository.
  // The list lives outside the fixture repository: a list written inside it would
  // be committed and would show up as a candidate change.
  const lists = await mkdtemp(join(tmpdir(), 'studio-changed-'));
  t.after(() => rm(lists, { recursive: true, force: true }));
  let listCount = 0;
  const changedList = async () => {
    const head = git('rev-parse', 'HEAD');
    const paths = git('diff', '--name-only', '--no-renames', baseline, head).split('\n').filter(Boolean);
    const file = join(lists, `changed-paths-${listCount++}.txt`);
    await writeFile(file, paths.join('\n'));
    return file;
  };
  // `''` is an explicit "no pinned key": the default must not be `undefined`,
  // which would fall back to the production pin and make the suite pass only
  // while that pin is empty. Tests that exercise verification pass a key.
  const gate = async (only = true, publicKey = '') =>
    validateStudioPublication(directory, git('rev-parse', 'HEAD'), only, await changedList(), publicKey);
  // The production path: no key argument, so the pinned constant is used.
  const gateDefault = async (only = true) =>
    validateStudioPublication(directory, git('rev-parse', 'HEAD'), only, await changedList());
  return { directory, git, commit, baseline, gate, gateDefault, changedList };
}

test('trusted validator accepts artifacts and rejects empty, unrelated and renamed paths', async t => {
  const { directory, git, commit, baseline, gate } = await fixture(t);
  await assert.rejects(gate(), /Empty publication/);
  const index = join(directory, 'vendor/studio/index.html');
  await writeFile(index, (await readFile(index, 'utf8')) + '\n<!-- changed artifact -->');
  await writeFile(join(directory, 'vendor/studio/assets/workspace-agent.mjs'), 'export const agent = true;');
  await mkdir(join(directory, 'vendor/studio/skills/drive9-workspace'), { recursive: true });
  await writeFile(join(directory, 'vendor/studio/skills/drive9-workspace/SKILL.md'), '# Workspace skill\n');
  for (const name of ['install.py', 'report.py', 'private_csv.py']) {
    await writeFile(join(directory, 'vendor/studio/skills/drive9-workspace', name), '# Reviewed report helper');
  }
  const manifestPath = join(directory, 'vendor/studio-build.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files = await studioHashes(join(directory, 'vendor/studio'));
  await writeFile(manifestPath, JSON.stringify(manifest));
  commit();
  await gate();
  await writeFile(join(directory, 'README.md'), 'unrelated');
  commit();
  await assert.rejects(gate(), /only Console/);
  git('reset', '--hard', baseline);
  await rename(index, join(directory, 'outside.html'));
  commit();
  await assert.rejects(gate(), /only Console/);
});

test('trusted validator rejects any additional skill file', async t => {
  const { directory, commit, gate } = await fixture(t);
  const folder = join(directory, 'vendor/studio/skills/drive9-workspace');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'unexpected.md'), 'not allowed');
  commit();
  await assert.rejects(gate(), /artifact path or Git mode/);
});

test('complete discovery artifact passes the trusted gate without admitting private pages', async t => {
  const { directory, commit, gate } = await fixture(t);
  const consoleDirectory = join(directory, 'vendor/studio');
  for (const page of ['', 'get-started/', 'analyze-sales-data/', 'api/', 'privacy/']) {
    const folder = join(consoleDirectory, 'discover', page);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'index.html'), '<!doctype html><html><head></head><body>Workspace guide</body></html>');
  }
  for (const name of ['robots.txt', 'sitemap.xml', 'llms.txt']) {
    await writeFile(join(consoleDirectory, name), 'Public discovery index');
  }
  const manifestPath = join(directory, 'vendor/studio-build.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files = await studioHashes(consoleDirectory);
  await writeFile(manifestPath, JSON.stringify(manifest));
  commit();
  await gate();
  const privatePage = join(consoleDirectory, 'discover/private');
  await mkdir(privatePage);
  await writeFile(join(privatePage, 'index.html'), 'Not a public entry point');
  commit();
  await assert.rejects(gate(), /artifact path or Git mode/);
});

test('candidate cannot modify or delete the workflow or trusted validator', async t => {
  const { directory, git, commit, baseline, gate } = await fixture(t);
  for (const path of ['.github/workflows/studio-publication.yml', 'scripts/validate-studio-publication.mjs']) {
    for (const remove of [false, true]) {
      git('reset', '--hard', baseline);
      if (remove) await rm(join(directory, path));
      else await writeFile(join(directory, path), 'process.exit(0); // fake success');
      commit();
      await assert.rejects(gate(), /only Console/);
    }
  }
});

test('candidate scripts are never executed, even when a human PR may change code', async t => {
  const { directory, commit, gate } = await fixture(t);
  const marker = join(directory, 'executed');
  await writeFile(join(directory, 'scripts/validate-studio-publication.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  commit();
  await gate(false);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('candidate symlinks, missing files and corrupt hashes fail', async t => {
  const { directory, git, commit, baseline, gate } = await fixture(t);
  const index = join(directory, 'vendor/studio/index.html');
  await rm(index);
  await symlink('/etc/passwd', index);
  commit();
  await assert.rejects(gate(), /Git mode/);
  git('reset', '--hard', baseline);
  await rm(index);
  commit();
  await assert.rejects(gate(), /checksums/);
  git('reset', '--hard', baseline);
  await writeFile(index, 'corrupt bytes');
  commit();
  await assert.rejects(gate(), /checksums/);
});

test('the artifact restriction is author-independent', async t => {
  const { directory, commit, gate } = await fixture(t);
  const index = join(directory, 'vendor/studio/index.html');
  await writeFile(index, (await readFile(index, 'utf8')) + '\n<!-- changed artifact -->');
  const manifestPath = join(directory, 'vendor/studio-build.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files = await studioHashes(join(directory, 'vendor/studio'));
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(directory, 'README.md'), 'unrelated');
  commit();
  // A human PR that publishes an artifact may not smuggle in other changes.
  await assert.rejects(gate(false), /only Console/);
});

test('a pinned publisher key makes the manifest signature mandatory (#147)', async t => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pinned = publicKey.export({ type: 'spki', format: 'pem' });
  const { directory, commit, git, gate } = await fixture(t);
  const manifestPath = join(directory, 'vendor/studio-build.json');
  const signaturePath = join(directory, 'vendor/studio-build.json.sig');

  // No signature at all: refused once a key is pinned, even though the artifact
  // change itself would otherwise pass.
  const consoleDirectory = join(directory, 'vendor/studio');
  const index = join(consoleDirectory, 'index.html');
  await writeFile(index, `${await readFile(index, 'utf8')}<!-- republished -->`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files = await studioHashes(consoleDirectory);
  await writeFile(manifestPath, JSON.stringify(manifest));
  commit();
  await assert.rejects(gate(true, pinned), /signature is missing/);

  // A signature from the pinned key: accepted.
  const manifestBytes = await readFile(manifestPath);
  await writeFile(signaturePath, signManifest(manifestBytes, privateKey));
  commit();
  await gate(true, pinned);

  // A signature over different bytes: refused.
  await writeFile(signaturePath, signManifest(Buffer.from('{"files":{}}'), privateKey));
  commit();
  await assert.rejects(gate(true, pinned), /does not match the pinned publisher key/);

  // A signature from a different key: refused.
  const other = generateKeyPairSync('ed25519');
  await writeFile(signaturePath, signManifest(manifestBytes, other.privateKey));
  commit();
  await assert.rejects(gate(true, pinned), /does not match the pinned publisher key/);

  // Without a pinned key the signature is not consulted, so this change cannot
  // break a release before the pipeline signs (#147 provisioning step).
  await writeFile(signaturePath, signManifest(Buffer.from('{"files":{}}'), privateKey));
  commit();
  await gate(true);
  git('reset', '--hard', 'HEAD');
});

test('a non-artifact change passes against a signed baseline with a pinned key (#147 activation)', async t => {
  const { generateKeyPairSync } = await import('node:crypto');
  const pair = generateKeyPairSync('ed25519');
  const pinned = pair.publicKey.export({ type: 'spki', format: 'pem' });
  // main's baseline carries a signature (see #153), so an unrelated change
  // inherits a valid artifact and must not be dragged into the signature rules.
  const { directory, commit, gate } = await fixture(t, { signWith: pair.privateKey });
  await writeFile(join(directory, 'README.md'), 'documentation only\n');
  commit();
  await gate(false, pinned);
});

test('the production default pin is consulted when the caller supplies no key', async t => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { signatureConfigured } = await import('../scripts/studio-signature.mjs');
  const other = generateKeyPairSync('ed25519');
  const { directory, commit, gateDefault } = await fixture(t, { signWith: other.privateKey });
  await writeFile(join(directory, 'README.md'), 'change\n');
  commit();
  // No key argument: the workflow/CLI path, which resolves the pinned constant.
  // With a pin it must reject a signature from any other key; with the rollback
  // (empty pin) the signature is not consulted at all.
  if (signatureConfigured()) {
    await assert.rejects(gateDefault(false), /does not match the pinned publisher key/);
  } else {
    await gateDefault(false);
  }
});
