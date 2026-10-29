import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the actual publication gate accepts artifact diffs and rejects empty, unrelated and renamed paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-pr-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  await mkdir(join(directory, 'vendor/studio'), { recursive: true });
  await writeFile(join(directory, 'vendor/studio/index.html'), 'baseline');
  git('add', '.');
  git('commit', '-m', 'fixture');
  const baseline = git('rev-parse', 'HEAD');
  const workflow = await readFile(new URL('../.github/workflows/studio-artifact.yml', import.meta.url), 'utf8');
  const script = workflow.match(/node --input-type=module <<'JS'\n([\s\S]*?)\n\s+JS\n/)[1];
  const gate = () => spawnSync(process.execPath, ['--input-type=module'], {
    cwd: directory, input: script, encoding: 'utf8',
    env: { ...process.env, BASE_SHA: baseline, HEAD_SHA: git('rev-parse', 'HEAD') },
  }).status;
  assert.notEqual(gate(), 0, 'Empty publication must fail.');
  await writeFile(join(directory, 'vendor/studio/index.html'), 'updated');
  git('add', '.');
  git('commit', '-m', 'artifact');
  assert.equal(gate(), 0);
  await writeFile(join(directory, 'README.md'), 'unrelated');
  git('add', '.');
  git('commit', '-m', 'unrelated');
  assert.notEqual(gate(), 0);
  git('reset', '--hard', 'HEAD~1');
  await rename(join(directory, 'vendor/studio/index.html'), join(directory, 'outside.html'));
  git('add', '-A');
  git('commit', '-m', 'rename out');
  assert.notEqual(gate(), 0);
});
