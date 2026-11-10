import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile, rename, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateStudioPublication } from '../scripts/validate-studio-publication.mjs';
import { studioHashes } from '../scripts/studio-artifact.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-pr-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  await cp(new URL('../vendor', import.meta.url), join(directory, 'vendor'), { recursive: true });
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
  const gate = async (only = true) =>
    validateStudioPublication(directory, baseline, git('rev-parse', 'HEAD'), only, await changedList());
  return { directory, git, commit, baseline, gate, changedList };
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
