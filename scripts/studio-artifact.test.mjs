import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { studioHashes, verifyStudioArtifact } from './studio-artifact.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-artifact-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'console');
  const manifestPath = join(root, 'manifest.json');
  await mkdir(join(directory, 'assets'), { recursive: true });
  await writeFile(join(directory, 'index.html'), '<script src="/studio/assets/app.js"></script>');
  await writeFile(join(directory, 'assets/app.js'), '/* fixture */');
  await writeFile(join(directory, 'config.json'), '{"apiOrigin":"","apiPathPrefix":"/studio"}\n');
  const manifest = {
    repository: 'https://github.com/mem9-ai/tidb.ai',
    commit: 'a'.repeat(40),
    node: '24.22.1',
    npm: '11.6.2',
    build: 'npm ci && npm run build:console -- --base=/studio/',
    files: await studioHashes(directory),
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, directory, manifestPath, manifest };
}

test('valid artifact verifies; modified, missing and extra assets fail', async t => {
  const { directory, manifestPath } = await fixture(t);
  await verifyStudioArtifact(directory, manifestPath);
  await writeFile(join(directory, 'assets/app.js'), 'changed');
  await assert.rejects(verifyStudioArtifact(directory, manifestPath), /checksums/);
  await rm(join(directory, 'assets/app.js'));
  await assert.rejects(verifyStudioArtifact(directory, manifestPath), /checksums/);
  await writeFile(join(directory, 'assets/app.js'), '/* fixture */');
  await writeFile(join(directory, 'assets/extra.js'), 'unexpected');
  await assert.rejects(verifyStudioArtifact(directory, manifestPath), /checksums/);
});

test('rejects source maps, private files, directories and symlinks', async t => {
  const { directory } = await fixture(t);
  for (const name of ['assets/app.js.map', '.env', 'server.mjs']) {
    await writeFile(join(directory, name), 'not publishable');
    await assert.rejects(studioHashes(directory), /unexpected/);
    await rm(join(directory, name));
  }
  await mkdir(join(directory, 'server'));
  await assert.rejects(studioHashes(directory), /unexpected/);
  await rm(join(directory, 'server'), { recursive: true });
  await symlink(join(directory, 'index.html'), join(directory, 'assets/link.js'));
  await assert.rejects(studioHashes(directory), /unexpected/);
});

test('rejects missing or invalid provenance and non-Studio runtime configuration', async t => {
  const { directory, manifestPath, manifest } = await fixture(t);
  await rm(manifestPath);
  await assert.rejects(verifyStudioArtifact(directory, manifestPath), { code: 'ENOENT' });
  await writeFile(manifestPath, 'null');
  await assert.rejects(verifyStudioArtifact(directory, manifestPath), /metadata/);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, commit: 'main' }));
  await assert.rejects(verifyStudioArtifact(directory, manifestPath), /metadata/);
  await writeFile(join(directory, 'config.json'), '{"apiOrigin":"http://127.0.0.1:4318"}');
  await writeFile(manifestPath, JSON.stringify({ ...manifest, files: await studioHashes(directory) }));
  await assert.rejects(verifyStudioArtifact(directory, manifestPath), /same-origin/);
});

test('maintenance import normalizes config, removes stale assets and rejects invalid input', async t => {
  const { root, directory, manifest } = await fixture(t);
  const script = join(root, 'scripts/studio-artifact.mjs');
  await mkdir(join(root, 'scripts'));
  await cp(new URL('./studio-artifact.mjs', import.meta.url), script);
  const destination = join(root, 'vendor/studio');
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'old.js'), 'stale');
  await writeFile(join(directory, 'config.json'), '{"apiOrigin":"http://127.0.0.1:4318"}');
  execFileSync(process.execPath, [script, directory, manifest.commit]);
  await verifyStudioArtifact(destination, join(root, 'vendor/studio-build.json'));
  await assert.rejects(readFile(join(destination, 'old.js')), { code: 'ENOENT' });
  const before = await studioHashes(destination);
  assert.notEqual(spawnSync(process.execPath, [script, destination, manifest.commit]).status, 0);
  assert.notEqual(spawnSync(process.execPath, [script, directory, 'main']).status, 0);
  await writeFile(join(directory, 'index.html'), '<script src="/assets/app.js"></script>');
  assert.notEqual(spawnSync(process.execPath, [script, directory, manifest.commit]).status, 0);
  assert.deepEqual(await studioHashes(destination), before);
});

test('checked-in artifact passes integrity checks', async () => {
  await verifyStudioArtifact(fileURLToPath(new URL('../vendor/studio', import.meta.url)),
    fileURLToPath(new URL('../vendor/studio-build.json', import.meta.url)));
});


test('rejects wrong build provenance even when file checksums match', async t => {
  const { directory, manifestPath, manifest } = await fixture(t);
  for (const change of [{ repository: 'https://example.invalid/source' }, { node: '22' }, { npm: 'latest' }, { build: 'npm run build' }]) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, ...change }));
    await assert.rejects(verifyStudioArtifact(directory, manifestPath), /metadata|provenance/);
  }
});

test('credential markers and inline source maps fail even with matching manifest hashes', async t => {
  const { directory, manifestPath, manifest } = await fixture(t);
  for (const marker of ['-----BEGIN PRIVATE KEY-----', `ghp_${'x'.repeat(36)}`, `github_pat_${'x'.repeat(30)}`, `AKIA${'A'.repeat(16)}`, '//# sourceMappingURL=data:application/json;base64,e30=']) {
    await writeFile(join(directory, 'assets/app.js'), marker);
    await writeFile(manifestPath, JSON.stringify({ ...manifest, files: await studioHashes(directory) }));
    await assert.rejects(verifyStudioArtifact(directory, manifestPath), error => {
      assert.match(error.message, /credential marker|source map/);
      assert.ok(!error.message.includes(marker));
      return true;
    });
  }
});
