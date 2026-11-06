import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const site = new URL('../site/', import.meta.url);
const releaseBase = 'https://releases.drive9.ai/latest';

test('legacy release paths override old static assets without redirecting the installer or Studio', async () => {
  const config = await readFile(new URL('netlify.toml', site), 'utf8');
  const rules = config.split('[[redirects]]').slice(1).map(block => block.split(/\n\s*\[/)[0]);
  const rule = rules.find(block => /from\s*=\s*"\/releases\/\*"/.test(block));
  assert.ok(rule, 'old CLI download paths must remain available');
  const destination = rule.match(/to\s*=\s*"([^"]+)"/)[1];
  assert.match(rule, /status\s*=\s*302\b/);
  assert.match(rule, /force\s*=\s*true\b/, 'checked-in files must not shadow the new release');
  for (const name of ['version', 'checksums.txt', 'SHA256SUMS', 'drive9-linux-amd64',
    'drive9-windows-arm64.exe', 'kubectl-drive9-migration-linux-arm64', 'migration-kube-plugin-checksums.txt']) {
    assert.equal(destination.replace(':splat', name), `https://releases.drive9.ai/latest/${name}`);
  }
  assert.ok(!rules.some(block => /from\s*=\s*"\/\*"/.test(block)));
  assert.ok(!rules.some(block => /from\s*=\s*"\/(install|studio)/.test(block)));
});

const oldPayload = '#!/bin/sh\necho drive9 old\n';
const newPayload = '#!/bin/sh\necho drive9 new\n';

// Runs site/install.sh with mocked `uname` and `curl` binaries, so no network
// request leaves the test and nothing outside the fixture is touched.
// installDir: 'allowlisted' ($HOME/.local/bin), 'non-allowlisted' (outside the
// allowlist) or 'symlinked' (allowlisted path that resolves elsewhere).
async function runShellInstaller(t, {
  os = 'Linux',
  arch = 'x86_64',
  artifact = 'drive9-linux-amd64',
  downloadFails = false,
  checksums = 'valid',
  installDir = 'allowlisted',
  homeName = 'home',
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'drive9-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['tools', 'tmp']) await mkdir(join(root, name));
  const homeDir = join(root, homeName);
  await mkdir(homeDir);

  const homeBin = join(homeDir, '.local', 'bin');
  let targetDir;
  if (installDir === 'non-allowlisted') {
    targetDir = join(root, 'install');
    await mkdir(targetDir);
  } else if (installDir === 'symlinked') {
    const outside = join(root, 'outside');
    await mkdir(join(homeDir, '.local'), { recursive: true });
    await mkdir(outside);
    await symlink(outside, homeBin);
    targetDir = homeBin;
  } else {
    await mkdir(homeBin, { recursive: true });
    targetDir = homeBin;
  }

  const target = join(targetDir, 'drive9');
  await writeFile(target, oldPayload, { mode: 0o755 });

  const sha = createHash('sha256').update(newPayload).digest('hex');
  const manifest = checksums === 'missing-manifest' ? null
    : checksums === 'missing-entry' ? `${sha}  drive9-some-other-artifact\n`
      : checksums === 'tampered' ? `${'0'.repeat(64)}  ${artifact}\n`
        : `${sha}  ${artifact}\n`;

  const log = join(root, 'requests.jsonl');
  await writeFile(join(root, 'tools', 'uname'), `#!/bin/sh\ncase "$1" in -s) echo '${os}';; -m) echo '${arch}';; esac\n`, { mode: 0o755 });
  await writeFile(join(root, 'tools', 'curl'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith('https://'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(url) + '\\n');
const out = args[args.indexOf('-o') + 1];
if (url === ${JSON.stringify(`${releaseBase}/version`)}) { process.stdout.write('new\\n'); process.exit(0); }
if (url === ${JSON.stringify(`${releaseBase}/checksums.txt`)}) {
  if (${JSON.stringify(manifest)} === null) process.exit(22);
  fs.writeFileSync(out, ${JSON.stringify(manifest)});
  process.exit(0);
}
if (url === ${JSON.stringify(`${releaseBase}/`)} + ${JSON.stringify(artifact)}) {
  if (${downloadFails}) process.exit(22);
  fs.writeFileSync(out, ${JSON.stringify(newPayload)});
  process.exit(0);
}
process.exit(22);
`, { mode: 0o755 });

  let error;
  try {
    await exec('/bin/sh', [new URL('install.sh', site).pathname], {
      // The Netlify build test restricts its own PATH to Node. This shell
      // fixture also needs standard Unix utilities, with our mocks first.
      env: {
        ...process.env,
        PATH: `${join(root, 'tools')}:/usr/bin:/bin`,
        HOME: homeDir,
        TMPDIR: join(root, 'tmp'),
        DRIVE9_INSTALL_DIR: targetDir,
      },
      timeout: 10_000,
    });
  } catch (cause) {
    error = cause;
  }

  const requests = existsSync(log)
    ? (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  return { error, root, target, requests };
}

for (const [os, arch, artifact] of [
  ['Linux', 'x86_64', 'drive9-linux-amd64'],
  ['Linux', 'aarch64', 'drive9-linux-arm64'],
  ['Darwin', 'x86_64', 'drive9-darwin-amd64'],
  ['Darwin', 'arm64', 'drive9-darwin-arm64'],
  ['Linux', 'x86_64', 'download failure'],
  ['Linux', 'unsupported', 'unsupported architecture'],
]) {
  test(`shell installer uses the release origin: ${os}/${arch}/${artifact}`, async t => {
    const downloadFails = artifact === 'download failure';
    const { error, target, requests } = await runShellInstaller(t, {
      os,
      arch,
      artifact: downloadFails ? 'drive9-linux-amd64' : artifact,
      downloadFails,
    });
    const fails = downloadFails || artifact === 'unsupported architecture';
    assert.equal(Boolean(error), fails, error?.stderr);
    assert.equal(await readFile(target, 'utf8'), fails ? oldPayload : newPayload);
    if (arch === 'unsupported') {
      assert.equal(requests.length, 0, 'unsupported architectures fail before any request');
      return;
    }
    assert.equal(requests[0], `${releaseBase}/version`);
    assert.ok(requests.every(url => url.startsWith(`${releaseBase}/`)));
  });
}

test('shell installer rejects a tampered release checksum', async t => {
  const { error, target, requests } = await runShellInstaller(t, { checksums: 'tampered' });
  assert.ok(error, 'installer must fail on a tampered artifact');
  assert.match(String(error.stderr), /Checksum mismatch for drive9-linux-amd64/);
  assert.equal(await readFile(target, 'utf8'), oldPayload);
  assert.ok(requests.includes(`${releaseBase}/drive9-linux-amd64`));
});

test('shell installer rejects a manifest without the platform artifact', async t => {
  const { error, target } = await runShellInstaller(t, { checksums: 'missing-entry' });
  assert.ok(error, 'installer must fail when the manifest has no entry for the artifact');
  assert.match(String(error.stderr), /No SHA-256 entry for drive9-linux-amd64/);
  assert.equal(await readFile(target, 'utf8'), oldPayload);
});

test('shell installer fails closed when the manifest is unavailable', async t => {
  const { error, target, requests } = await runShellInstaller(t, { checksums: 'missing-manifest' });
  assert.ok(error, 'installer must fail when the manifest cannot be downloaded');
  assert.match(String(error.stderr), /refusing to install an unverified binary/);
  assert.equal(await readFile(target, 'utf8'), oldPayload);
  assert.ok(!requests.includes(`${releaseBase}/drive9-linux-amd64`), 'artifact must not be downloaded without a manifest');
});

for (const homeName of ['home with spaces', "home's & co"]) {
  test(`shell installer accepts an allowlisted directory under "${homeName}"`, async t => {
    const { error, target } = await runShellInstaller(t, { homeName });
    assert.equal(Boolean(error), false, error?.stderr);
    assert.equal(await readFile(target, 'utf8'), newPayload);
  });
}

test('shell installer refuses a DRIVE9_INSTALL_DIR outside the allowlist', async t => {
  const { error, target, requests } = await runShellInstaller(t, { installDir: 'non-allowlisted' });
  assert.ok(error, 'installer must reject a non-allowlisted install directory');
  assert.match(String(error.stderr), /not an allowed install directory/);
  assert.equal(requests.length, 0, 'the install directory must be validated before any request');
  assert.equal(await readFile(target, 'utf8'), oldPayload, 'nothing may be installed outside the allowlist');
});

test('shell installer refuses an allowlisted path that resolves elsewhere', async t => {
  const { error, requests } = await runShellInstaller(t, { installDir: 'symlinked' });
  assert.ok(error, 'installer must reject an allowlisted path that is a symlink elsewhere');
  assert.match(String(error.stderr), /is not an allowed install directory/);
  assert.equal(requests.length, 0);
});

async function runPowerShellFixture(t, scriptName) {
  const powershell = process.env.PWSH || 'pwsh';
  try {
    await exec(powershell, ['--version']);
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('PowerShell is not installed; run with PWSH to verify the Windows installer');
      return;
    }
    throw error;
  }
  await exec(powershell, ['-NoProfile', '-File', new URL(scriptName, import.meta.url).pathname], { timeout: 30_000 });
}

test('PowerShell installer downloads and verifies both Windows artifacts', async t => {
  await runPowerShellFixture(t, './install-windows.test.ps1');
});

test('PowerShell installer enforces the install-directory allowlist', async t => {
  await runPowerShellFixture(t, './install-windows-allowlist.test.ps1');
});
