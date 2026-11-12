import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isConsoleArtifactPath, PRIVILEGED_EXAMPLES, privilegedBuildSurface, UNCHANGED } from '../scripts/build-surface.mjs';

test('the privileged surface is exactly what the project ships or executes', () => {
  for (const path of PRIVILEGED_EXAMPLES) {
    assert.ok(privilegedBuildSurface(path), path);
  }
  for (const path of ['site/index.html', 'site/skill.md', 'tests/build-surface.test.mjs', 'README.md']) {
    assert.ok(!privilegedBuildSurface(path), path);
  }
});

test('the CLI prints the pinned sentinel and one path per line', () => {
  const cli = fileURLToPath(new URL('../scripts/build-surface.mjs', import.meta.url));
  const run = input => spawnSync(process.execPath, [cli, '--stdin'], { input, encoding: 'utf8' });
  const unchanged = run('site/index.html\nREADME.md\n');
  assert.equal(unchanged.status, 0);
  assert.equal(unchanged.stdout.trim(), UNCHANGED);
  assert.equal(UNCHANGED, 'Build surface unchanged.');
  const changed = run('scripts/evil.mjs\nsite/index.html\nsite/package.json\n');
  assert.equal(changed.status, 0);
  assert.deepEqual(changed.stdout.trim().split('\n'), ['scripts/evil.mjs', 'site/package.json']);
});

test('renames of privileged files are visible to the gate', () => {
  const cli = fileURLToPath(new URL('../scripts/build-surface.mjs', import.meta.url));
  // GitHub reports both the new and the previous name for a rename.
  const renamed = spawnSync(process.execPath, [cli, '--stdin'], {
    input: 'docs/notes.md\nscripts/prepare-studio.mjs\n',
    encoding: 'utf8',
  });
  assert.equal(renamed.status, 0);
  assert.equal(renamed.stdout.trim(), 'scripts/prepare-studio.mjs');
});

test('the CLI refuses to run without the stdin contract', () => {
  const cli = fileURLToPath(new URL('../scripts/build-surface.mjs', import.meta.url));
  const bare = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /--stdin/);
});

test('CODEOWNERS covers the whole enforced surface', () => {
  const entries = readFileSync(new URL('../.github/CODEOWNERS', import.meta.url), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.split(/\s+/)[0].replace(/^\//, ''));
  const covers = path => entries.some(pattern =>
    pattern.endsWith('/') ? path.startsWith(pattern) : path === pattern);
  for (const path of PRIVILEGED_EXAMPLES) {
    assert.ok(privilegedBuildSurface(path), path);
    assert.ok(covers(path), `CODEOWNERS must cover ${path}`);
  }
});

test('every console-artifact path is also a privileged build path', () => {
  // The exemption waves a publisher PR through before the surface check runs, so
  // a path accepted here but missing from the surface would be published with
  // neither a maintainer approval nor artifact validation.
  for (const path of ['vendor/studio/index.html', 'vendor/studio/assets/app.js', 'vendor/studio/skills/tidb-agent-workspace/SKILL.md', 'vendor/studio-build.json']) {
    assert.ok(isConsoleArtifactPath(path), path);
    assert.ok(privilegedBuildSurface(path), `${path} must also be in the privileged surface`);
  }
  // ...and the artifact set stays inside the vendor tree.
  assert.equal(isConsoleArtifactPath('vendor/studio-config.json'), false);
  assert.equal(isConsoleArtifactPath('site/install.sh'), false);
});
