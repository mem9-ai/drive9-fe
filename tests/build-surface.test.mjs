import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { changedBuildSurface, privilegedBuildSurface, UNCHANGED } from '../scripts/build-surface.mjs';

test('the privileged surface is exactly what the deploy build can execute', () => {
  for (const path of [
    'netlify.toml',
    'site/netlify.toml',
    'scripts/prepare-studio.mjs',
    'scripts/netlify-ignore.mjs',
    '.github/workflows/studio-publication.yml',
    'package.json',
    'package-lock.json',
    'site/package.json',
    'site/package-lock.json',
  ]) {
    assert.ok(privilegedBuildSurface(path), path);
  }
  for (const path of ['site/index.html', 'tests/build-surface.test.mjs', 'vendor/studio/index.html', 'README.md']) {
    assert.ok(!privilegedBuildSurface(path), path);
  }
});

test('changedBuildSurface reports only the privileged subset of a candidate diff', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'build-surface-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init');
  await mkdir(join(directory, 'site'), { recursive: true });
  await mkdir(join(directory, 'scripts'), { recursive: true });
  await writeFile(join(directory, 'site/index.html'), '<!doctype html>');
  await writeFile(join(directory, 'README.md'), 'baseline');
  git('add', '-A');
  git('commit', '-m', 'baseline');
  const baseline = git('rev-parse', 'HEAD');

  await writeFile(join(directory, 'README.md'), 'site-only change');
  await writeFile(join(directory, 'site/index.html'), '<!doctype html><title>site</title>');
  git('add', '-A');
  git('commit', '-m', 'site only');
  assert.deepEqual(changedBuildSurface(directory, baseline, git('rev-parse', 'HEAD')), []);

  await writeFile(join(directory, 'scripts/evil.mjs'), 'console.log("candidate code");');
  git('add', '-A');
  git('commit', '-m', 'surface change');
  assert.deepEqual(changedBuildSurface(directory, baseline, git('rev-parse', 'HEAD')), ['scripts/evil.mjs']);

  await writeFile(join(directory, 'site/package.json'), '{"scripts":{"prepare":"node evil.mjs"}}');
  git('add', '-A');
  git('commit', '-m', 'manifest change');
  assert.deepEqual(changedBuildSurface(directory, baseline, git('rev-parse', 'HEAD')).sort(), [
    'scripts/evil.mjs',
    'site/package.json',
  ]);
});

test('the CLI prints the pinned sentinel and one path per line', () => {
  const cli = new URL('../scripts/build-surface.mjs', import.meta.url);
  const run = input => spawnSync(process.execPath, [cli.pathname, '--stdin'], { input, encoding: 'utf8' });
  const unchanged = run('site/index.html\nREADME.md\n');
  assert.equal(unchanged.status, 0);
  assert.equal(unchanged.stdout.trim(), UNCHANGED);
  assert.equal(UNCHANGED, 'Build surface unchanged.');
  const changed = run('scripts/evil.mjs\nsite/index.html\nsite/package.json\n');
  assert.equal(changed.status, 0);
  assert.deepEqual(changed.stdout.trim().split('\n'), ['scripts/evil.mjs', 'site/package.json']);
});

test('CODEOWNERS covers the whole enforced surface', () => {
  const entries = readFileSync(new URL('../.github/CODEOWNERS', import.meta.url), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.split(/\s+/)[0].replace(/^\//, ''));
  const covers = path => entries.some(pattern =>
    pattern.endsWith('/') ? path.startsWith(pattern) : path === pattern);
  for (const path of [
    'netlify.toml',
    'site/netlify.toml',
    'scripts/prepare-studio.mjs',
    '.github/workflows/studio-publication.yml',
    'package.json',
    'package-lock.json',
    'site/package.json',
    'site/package-lock.json',
  ]) {
    assert.ok(privilegedBuildSurface(path), path);
    assert.ok(covers(path), `CODEOWNERS must cover ${path}`);
  }
});
