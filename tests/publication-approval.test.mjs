import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { approvedLogins, botArtifactOnlyPublication, changedPaths } from '../scripts/publication-approval.mjs';

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
  // The check turns red on approval alone, so the failure has to say how to recover,
  // and it has to read as standing behaviour rather than as a note about git history.
  assert.match(rejected.stderr, /does not re-run this check automatically/);
  assert.match(rejected.stderr, /re-run "Trusted Studio publication validation"/);

  const paths = spawnSync(process.execPath, [cli, 'changed-paths', '--files', filesFile, '--pull', pullFile, '--head', HEAD], { encoding: 'utf8' });
  assert.equal(paths.status, 0);
  assert.equal(paths.stdout.trim(), 'scripts/x.mjs');
});

test('only a bot publishing nothing but the artifact skips the approval requirement', () => {
  const artifact = ['vendor/studio/index.html', 'vendor/studio-build.json'];
  assert.equal(botArtifactOnlyPublication(artifact, 'Bot'), true);
  // Mixing one line of code into a release disqualifies it.
  assert.equal(botArtifactOnlyPublication([...artifact, 'scripts/prepare-studio.mjs'], 'Bot'), false);
  assert.equal(botArtifactOnlyPublication([...artifact, 'netlify.toml'], 'Bot'), false);
  // A human PR is never exempt, even when it only touches the artifact.
  assert.equal(botArtifactOnlyPublication(artifact, 'User'), false);
  assert.equal(botArtifactOnlyPublication(artifact, 'Organization'), false);
  assert.equal(botArtifactOnlyPublication(artifact, undefined), false);
  assert.equal(botArtifactOnlyPublication(artifact, 'bot'), false);
  // Prefix lookalikes are not the artifact directory.
  assert.equal(botArtifactOnlyPublication(['vendor/studio-evil/index.html'], 'Bot'), false);
  assert.equal(botArtifactOnlyPublication(['vendor/studio'], 'Bot'), false);
  assert.equal(botArtifactOnlyPublication([], 'Bot'), false);
});

test('the bot-artifact CLI fails closed and the workflow passes the author type', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'publication-bot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../scripts/publication-approval.mjs', import.meta.url));
  const pathsFile = join(directory, 'changed-paths.txt');

  await writeFile(pathsFile, 'vendor/studio/index.html\nvendor/studio-build.json\n');
  const exempt = spawnSync(process.execPath, [cli, 'bot-artifact', '--paths', pathsFile, '--author-type', 'Bot'], { encoding: 'utf8' });
  assert.equal(exempt.status, 0);
  assert.match(exempt.stdout, /approval is not required/);

  const human = spawnSync(process.execPath, [cli, 'bot-artifact', '--paths', pathsFile, '--author-type', 'User'], { encoding: 'utf8' });
  assert.equal(human.status, 1);

  await writeFile(pathsFile, 'vendor/studio/index.html\nscripts/build-surface.mjs\n');
  const mixed = spawnSync(process.execPath, [cli, 'bot-artifact', '--paths', pathsFile, '--author-type', 'Bot'], { encoding: 'utf8' });
  assert.equal(mixed.status, 1);

  // The exemption is only safe because the workflow reads the author type from
  // the pull request itself: a branch name or the sender would be forgeable.
  const workflow = readFileSync(new URL('../.github/workflows/studio-publication.yml', import.meta.url), 'utf8');
  assert.match(workflow, /PR_AUTHOR_TYPE: \$\{\{ github\.event\.pull_request\.user\.type \}\}/);
  assert.match(workflow, /bot-artifact \\\n\s+--paths "\$RUNNER_TEMP\/changed-paths\.txt" --author-type "\$PR_AUTHOR_TYPE"/);
});
