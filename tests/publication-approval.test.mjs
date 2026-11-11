import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { approvedLogins, changedPaths } from '../scripts/publication-approval.mjs';

const HEAD = 'a'.repeat(40);
const review = (login, state, commit = HEAD, at = '2026-11-10T10:00:00Z', association = 'MEMBER') => ({
  user: login === null ? null : { login },
  state,
  commit_id: commit,
  submitted_at: at,
  author_association: association,
});

test('only a maintainer approval of this exact head counts', () => {
  assert.deepEqual(approvedLogins([review('mornyx', 'APPROVED')], HEAD), ['mornyx']);
  assert.deepEqual(approvedLogins([review('mornyx', 'APPROVED', 'b'.repeat(40))], HEAD), []);
  assert.deepEqual(approvedLogins([review('outsider', 'APPROVED', HEAD, '2026-11-10T10:00:00Z', 'CONTRIBUTOR')], HEAD), []);
  assert.deepEqual(approvedLogins([review('mornyx', 'CHANGES_REQUESTED')], HEAD), []);
  assert.deepEqual(approvedLogins([], HEAD), []);
});

test('a comment after an approval does not revoke it', () => {
  const reviews = [
    review('mornyx', 'APPROVED', HEAD, '2026-11-10T10:00:00Z'),
    review('mornyx', 'COMMENTED', HEAD, '2026-11-10T11:00:00Z'),
  ];
  assert.deepEqual(approvedLogins(reviews, HEAD), ['mornyx']);
});

test('approve then request changes revokes the approval', () => {
  const reviews = [
    review('mornyx', 'APPROVED', HEAD, '2026-11-10T10:00:00Z'),
    review('mornyx', 'CHANGES_REQUESTED', HEAD, '2026-11-10T11:00:00Z'),
  ];
  assert.deepEqual(approvedLogins(reviews, HEAD), []);
});

test('paginated page arrays and null users are handled', () => {
  const reviews = [
    [review(null, 'APPROVED')],
    [review('qiffang', 'COMMENTED', HEAD, '2026-11-10T09:00:00Z'), review('qiffang', 'APPROVED', HEAD, '2026-11-10T10:00:00Z')],
  ];
  assert.deepEqual(approvedLogins(reviews, HEAD), ['qiffang']);
});

test('changed paths include both sides of a rename and require a complete list', () => {
  const files = [[
    { filename: 'docs/notes.md', previous_filename: 'scripts/prepare-studio.mjs' },
    { filename: 'site/index.html', previous_filename: null },
  ]];
  const pull = { changed_files: 2, head: { sha: HEAD } };
  assert.deepEqual(changedPaths(files, pull, HEAD), ['docs/notes.md', 'scripts/prepare-studio.mjs', 'site/index.html']);
  assert.throws(() => changedPaths(files, { ...pull, changed_files: 3001 }, HEAD), /Cannot verify every changed file/);
  assert.throws(() => changedPaths(files, { ...pull, head: { sha: 'b'.repeat(40) } }, HEAD), /retry the run/);
  assert.throws(() => changedPaths(files, { changed_files: 2 }, HEAD), /changed_files or head\.sha/);
});

test('the CLI fails closed on approvals and reports the parsed paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'publication-approval-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../scripts/publication-approval.mjs', import.meta.url));
  const reviewsFile = join(directory, 'reviews.json');
  const filesFile = join(directory, 'files.json');
  const pullFile = join(directory, 'pull.json');
  await writeFile(filesFile, JSON.stringify([[{ filename: 'scripts/x.mjs' }]]));
  await writeFile(pullFile, JSON.stringify({ changed_files: 1, head: { sha: HEAD } }));

  await writeFile(reviewsFile, JSON.stringify([review('mornyx', 'APPROVED')]));
  const approved = spawnSync(process.execPath, [cli, 'approvals', '--reviews', reviewsFile, '--head', HEAD], { encoding: 'utf8' });
  assert.equal(approved.status, 0);
  assert.equal(approved.stdout.trim(), 'mornyx');

  await writeFile(reviewsFile, JSON.stringify([review('mornyx', 'CHANGES_REQUESTED')]));
  const rejected = spawnSync(process.execPath, [cli, 'approvals', '--reviews', reviewsFile, '--head', HEAD], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /needs an approving review/);

  const paths = spawnSync(process.execPath, [cli, 'changed-paths', '--files', filesFile, '--pull', pullFile, '--head', HEAD], { encoding: 'utf8' });
  assert.equal(paths.status, 0);
  assert.equal(paths.stdout.trim(), 'scripts/x.mjs');
});
