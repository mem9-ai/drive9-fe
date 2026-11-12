import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

test('the gate decides every outcome and tells the caller when to retry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'publication-gate-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../scripts/publication-approval.mjs', import.meta.url));
  const files = join(directory, 'files.json');
  const pull = join(directory, 'pull.json');
  const reviews = join(directory, 'reviews.json');
  await writeFile(reviews, JSON.stringify([review('mornyx', 'APPROVED')]));
  const pathsOut = join(directory, 'changed-paths.txt');
  const run = async (changeFiles, { authorType = 'User', authorLogin = 'srstack', head = HEAD, pullHead = HEAD, reviewsPath = reviews } = {}) => {
    await writeFile(files, JSON.stringify([changeFiles.map(filename => ({ filename }))]));
    await writeFile(pull, JSON.stringify({ changed_files: changeFiles.length, head: { sha: pullHead } }));
    return spawnSync(process.execPath, [cli, 'gate', '--files', files, '--pull', pull, '--reviews', reviewsPath,
      '--head', head, '--author-type', authorType, '--author-login', authorLogin,
      '--paths-out', pathsOut], { encoding: 'utf8' });
  };

  // Nothing privileged changed: pass without looking at reviews, and still hand
  // the validation step the full changed-file list.
  const unchanged = await run(['site/index.html']);
  assert.equal(unchanged.status, 0);
  assert.equal(unchanged.stdout.trim(), 'Build surface unchanged.');
  assert.equal(await readFile(pathsOut, 'utf8'), 'site/index.html\n');

  // Privileged change with an approval on this head: pass.
  const approved = await run(['scripts/build-surface.mjs']);
  assert.equal(approved.status, 0);
  assert.match(approved.stdout, /Approved by mornyx/);

  // Privileged change without an approval: fail with the recovery hint.
  const none = join(directory, 'empty.json');
  await writeFile(none, '[]');
  const rejected = spawnSync(process.execPath, [cli, 'gate', '--files', files, '--pull', pull,
    '--reviews', none, '--head', HEAD,
    '--author-type', 'User', '--author-login', 'srstack'], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /needs an approving review/);
  assert.match(rejected.stderr, /does not re-run this check automatically/);

  // Publisher app shipping only the artifact: pass without an approval, and the
  // list written for validation keeps every path, not just the privileged ones.
  const exempt = await run(['vendor/studio/index.html', 'vendor/studio-build.json'],
    { authorType: 'Bot', authorLogin: 'mem9-studio-publisher[bot]' });
  assert.equal(exempt.status, 0);
  assert.match(exempt.stdout, /maintainer approval is not required/);
  assert.equal(await readFile(pathsOut, 'utf8'), 'vendor/studio/index.html\nvendor/studio-build.json\n');

  // The same files from any other app, or mixed with code: approval required.
  const otherApp = await run(['vendor/studio/index.html'], { authorType: 'Bot', authorLogin: 'dependabot[bot]', reviewsPath: none });
  assert.equal(otherApp.status, 1);
  const mixed = await run(['vendor/studio/index.html', 'scripts/build-surface.mjs'],
    { authorType: 'Bot', authorLogin: 'mem9-studio-publisher[bot]', reviewsPath: none });
  assert.equal(mixed.status, 1);

  // A listing that does not match the head asked for: retry (3), never a verdict.
  const stale = await run(['scripts/build-surface.mjs'], { pullHead: 'b'.repeat(40) });
  assert.equal(stale.status, 3);
  assert.match(stale.stderr, /retry the run/);

  // An incomplete listing is also retryable, not a pass.
  await writeFile(files, JSON.stringify([[{ filename: 'scripts/build-surface.mjs' }]]));
  await writeFile(pull, JSON.stringify({ changed_files: 2, head: { sha: HEAD } }));
  const truncated = spawnSync(process.execPath, [cli, 'gate', '--files', files, '--pull', pull, '--reviews', reviews,
    '--head', HEAD, '--author-type', 'User', '--author-login', 'srstack'], { encoding: 'utf8' });
  assert.equal(truncated.status, 3);
  assert.match(truncated.stderr, /Cannot verify every changed file/);

  // Anything but the gate subcommand is a usage error.
  const usage = spawnSync(process.execPath, [cli, 'approvals', '--head', HEAD], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /gate --files/);
});

test('the workflow keeps only fetching and one gate invocation', () => {
  const workflow = readFileSync(new URL('../.github/workflows/studio-publication.yml', import.meta.url), 'utf8');
  assert.match(workflow, /PR_AUTHOR_TYPE: \$\{\{ github\.event\.pull_request\.user\.type \}\}/);
  assert.match(workflow, /PR_AUTHOR_LOGIN: \$\{\{ github\.event\.pull_request\.user\.login \}\}/);
  assert.match(workflow, /publication-approval\.mjs gate/);
  assert.match(workflow, /--author-type "\$PR_AUTHOR_TYPE" --author-login "\$PR_AUTHOR_LOGIN"/);
  // The validation step consumes this file; the gate must be what produces it.
  assert.match(workflow, /--paths-out "\$RUNNER_TEMP\/changed-paths\.txt"/);
  // The decision must not be re-implemented in shell any more.
  assert.doesNotMatch(workflow, /build-surface\.mjs --stdin/);
  assert.doesNotMatch(workflow, /bot-artifact/);
  assert.doesNotMatch(workflow, /case "\$changed" in/);
});

test('only the publisher app publishing nothing but the artifact skips the approval requirement', () => {
  const artifact = ['vendor/studio/index.html', 'vendor/studio-build.json'];
  assert.equal(botArtifactOnlyPublication(artifact, 'Bot', 'mem9-studio-publisher[bot]'), true);
  // "Bot" is not a principal: every installed GitHub App authors as `Bot`.
  for (const login of ['dependabot[bot]', 'github-actions[bot]', 'renovate[bot]', 'app/mem9-studio-publisher', 'mem9-studio-publisher', 'mem9-studio-publisher[bot] ']) {
    assert.equal(botArtifactOnlyPublication(artifact, 'Bot', login), false, login);
  }
  assert.equal(botArtifactOnlyPublication(artifact, 'Bot', undefined), false);
  assert.equal(botArtifactOnlyPublication(artifact, 'User', 'mem9-studio-publisher[bot]'), false);
  // Mixing one line of code into a release disqualifies it.
  assert.equal(botArtifactOnlyPublication([...artifact, 'scripts/prepare-studio.mjs'], 'Bot', 'mem9-studio-publisher[bot]'), false);
  assert.equal(botArtifactOnlyPublication([...artifact, 'netlify.toml'], 'Bot', 'mem9-studio-publisher[bot]'), false);
  // A human PR is never exempt, even when it only touches the artifact.
  assert.equal(botArtifactOnlyPublication(artifact, 'User', 'srstack'), false);
  assert.equal(botArtifactOnlyPublication(artifact, 'Organization', 'mem9-ai'), false);
  assert.equal(botArtifactOnlyPublication(artifact, 'bot', 'mem9-studio-publisher[bot]'), false);
  // Prefix lookalikes are not the artifact directory.
  assert.equal(botArtifactOnlyPublication(['vendor/studio-evil/index.html'], 'Bot', 'mem9-studio-publisher[bot]'), false);
  assert.equal(botArtifactOnlyPublication(['vendor/studio'], 'Bot', 'mem9-studio-publisher[bot]'), false);
  assert.equal(botArtifactOnlyPublication([], 'Bot', 'mem9-studio-publisher[bot]'), false);
});
