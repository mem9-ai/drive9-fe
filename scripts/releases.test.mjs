import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const site = new URL('../site/', import.meta.url);

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

for (const [os, arch, artifact] of [
  ['Linux', 'x86_64', 'drive9-linux-amd64'],
  ['Linux', 'aarch64', 'drive9-linux-arm64'],
  ['Darwin', 'x86_64', 'drive9-darwin-amd64'],
  ['Darwin', 'arm64', 'drive9-darwin-arm64'],
  ['Linux', 'x86_64', 'download failure'],
  ['Linux', 'unsupported', 'unsupported architecture'],
]) {
  test(`shell installer uses the release origin: ${os}/${arch}/${artifact}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'drive9-install-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of ['tools', 'install', 'home', 'tmp']) await mkdir(join(root, name));
    const target = join(root, 'install', 'drive9');
    const original = '#!/bin/sh\necho drive9 old\n';
    await writeFile(target, original, { mode: 0o755 });
    const log = join(root, 'requests.jsonl');
    await writeFile(join(root, 'tools', 'uname'), `#!/bin/sh\ncase "$1" in -s) echo '${os}';; -m) echo '${arch}';; esac\n`, { mode: 0o755 });
    const payload = '#!/bin/sh\necho drive9 new\n';
    // Never use the network or the real install/config directories.
    await writeFile(join(root, 'tools', 'curl'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith('https://'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(url) + '\\n');
if (url === 'https://releases.drive9.ai/latest/version') { process.stdout.write('new\\n'); process.exit(0); }
if (${JSON.stringify(artifact)} === 'download failure') process.exit(22);
if (url !== 'https://releases.drive9.ai/latest/${artifact}') process.exit(22);
fs.writeFileSync(args[args.indexOf('-o') + 1], ${JSON.stringify(payload)});
`, { mode: 0o755 });
    let error;
    try {
      await exec('/bin/sh', [new URL('install.sh', site).pathname], {
        env: { ...process.env, PATH: `${join(root, 'tools')}:${process.env.PATH}`, HOME: join(root, 'home'),
          TMPDIR: join(root, 'tmp'), DRIVE9_INSTALL_DIR: join(root, 'install') },
        timeout: 10_000,
      });
    } catch (cause) { error = cause; }
    const fails = artifact === 'download failure' || artifact === 'unsupported architecture';
    assert.equal(Boolean(error), fails, error?.stderr);
    assert.equal(await readFile(target, 'utf8'), fails ? original : payload);
    if (arch !== 'unsupported') {
      const requests = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(requests[0], 'https://releases.drive9.ai/latest/version');
      assert.ok(requests.every(url => url.startsWith('https://releases.drive9.ai/latest/')));
    }
  });
}

test('PowerShell installer downloads and verifies both Windows artifacts', async t => {
  const powershell = process.env.PWSH || 'pwsh';
  try { await exec(powershell, ['--version']); }
  catch (error) {
    if (error.code === 'ENOENT') { t.skip('PowerShell is not installed; run with PWSH to verify Windows installer functions'); return; }
    throw error;
  }
  await exec(powershell, ['-NoProfile', '-File', new URL('./install-windows.test.ps1', import.meta.url).pathname], { timeout: 30_000 });
});
