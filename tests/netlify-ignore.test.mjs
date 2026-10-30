import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

test('Netlify ignore from site includes outside-base inputs and builds without reliable history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'drive9-netlify-ignore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['site', 'scripts', 'vendor/studio', 'tests']) await mkdir(join(root, path), { recursive: true });
  await cp(new URL('../scripts/netlify-ignore.mjs', import.meta.url), join(root, 'scripts/netlify-ignore.mjs'));
  const config = await readFile(new URL('../site/netlify.toml', import.meta.url), 'utf8');
  const command = JSON.parse(config.match(/^\s*ignore = (".*")$/m)[1]);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const commit = () => {
    git('add', '-A');
    git('commit', '--allow-empty', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const ignore = (before, after) => spawnSync('/bin/sh', ['-c', command], {
    cwd: join(root, 'site'), env: { ...env, CACHED_COMMIT_REF: before, COMMIT_REF: after },
    encoding: 'utf8', timeout: 15_000,
  });
  git('init');
  let previous = commit();
  for (const [path, expected] of [
    ['README.md', 0],
    ['vendor/studio/index.html', 1],
    ['vendor/studio-build.json', 1],
    ['scripts/prepare-studio.mjs', 1],
    ['site/index.html', 1],
    ['site/netlify.toml', 1],
    ['tests/netlify-build.test.mjs', 1],
  ]) {
    await writeFile(join(root, path), `changed ${path}`);
    const next = commit();
    const result = ignore(previous, next);
    assert.equal(result.status, expected, `${path}: ${result.stdout}${result.stderr}`);
    previous = next;
  }
  assert.equal(ignore(previous, previous).status, 0);
  await rm(join(root, 'vendor/studio/index.html'));
  const deletion = commit();
  assert.equal(ignore(previous, deletion).status, 1, 'Artifact deletion must rebuild.');
  for (const [before, after] of [['', deletion], ['0'.repeat(40), deletion], [deletion, ''], ['--help', deletion]]) {
    const result = ignore(before, after);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
  const noGit = spawnSync(process.execPath, [join(root, 'scripts/netlify-ignore.mjs')], {
    cwd: join(root, 'site'), env: { PATH: dirname(process.execPath), CACHED_COMMIT_REF: deletion, COMMIT_REF: deletion },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(noGit.status, 1, 'An unavailable Git command must rebuild.');
});
