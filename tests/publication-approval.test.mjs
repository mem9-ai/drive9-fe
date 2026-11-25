import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { approvedLogins, botArtifactOnlyPublication, changedPaths, gate, permissionMap } from '../scripts/publication-approval.mjs';

const HEAD = 'a'.repeat(40);
const WRITE = { mornyx: true, qiffang: true };
const review = (login, state, commit = HEAD, at = '2026-11-10T10:00:00Z', association = 'MEMBER') => ({
  user: login === null ? null : { login },
  state,
  commit_id: commit,
  submitted_at: at,
  author_association: association,
});

test('only a maintainer approval of this exact head counts', () => {
  assert.deepEqual(approvedLogins([review('mornyx', 'APPROVED')], HEAD, WRITE), ['mornyx']);
  assert.deepEqual(approvedLogins([review('mornyx', 'APPROVED', 'b'.repeat(40))], HEAD, WRITE), []);
  assert.deepEqual(approvedLogins([review('outsider', 'APPROVED', HEAD, '2026-11-10T10:00:00Z', 'CONTRIBUTOR')], HEAD, WRITE), []);
  assert.deepEqual(approvedLogins([review('mornyx', 'CHANGES_REQUESTED')], HEAD, WRITE), []);
  assert.deepEqual(approvedLogins([], HEAD, WRITE), []);
});

test('authorization is write access, not an association', () => {
  // A read-only collaborator and an org member with no repository access both
  // report an association that looks like a maintainer; neither may approve.
  assert.deepEqual(approvedLogins([review('readonly', 'APPROVED')], HEAD, { mornyx: true }), []);
  assert.deepEqual(approvedLogins([review('member', 'APPROVED')], HEAD, { member: false }), []);
  // No collaborator data at all: fail closed.
  assert.deepEqual(approvedLogins([review('mornyx', 'APPROVED')], HEAD), []);
  assert.deepEqual(approvedLogins([review('mornyx', 'APPROVED')], HEAD, { mornyx: true }), ['mornyx']);
});

test('the collaborator map keeps only push-capable logins', () => {
  const pages = [[
    { login: 'admin', permissions: { admin: true, maintain: true, push: true } },
    { login: 'maintain', permissions: { admin: false, maintain: true, push: true } },
    { login: 'writer', permissions: { admin: false, maintain: false, push: true } },
    { login: 'readonly', permissions: { admin: false, maintain: false, push: false } },
    { login: 'triage', permissions: { admin: false, maintain: false, push: false, triage: true } },
    { login: 'unknown' },
  ]];
  assert.deepEqual(permissionMap(pages), { admin: true, maintain: true, writer: true });
});

test('a comment after an approval does not revoke it', () => {
  const reviews = [
    review('mornyx', 'APPROVED', HEAD, '2026-11-10T10:00:00Z'),
    review('mornyx', 'COMMENTED', HEAD, '2026-11-10T11:00:00Z'),
  ];
  assert.deepEqual(approvedLogins(reviews, HEAD, WRITE), ['mornyx']);
});

test('approve then request changes revokes the approval', () => {
  const reviews = [
    review('mornyx', 'APPROVED', HEAD, '2026-11-10T10:00:00Z'),
    review('mornyx', 'CHANGES_REQUESTED', HEAD, '2026-11-10T11:00:00Z'),
  ];
  assert.deepEqual(approvedLogins(reviews, HEAD, WRITE), []);
});

test('gate reports an untrustworthy listing as an outcome instead of throwing', () => {
  const files = [[{ filename: 'scripts/build-surface.mjs' }]];
  // A head mismatch and an incomplete listing are expected conditions the caller
  // has to retry on, so they are values, not exceptions.
  const stale = gate({ files, pull: { changed_files: 1, head: { sha: 'b'.repeat(40) } }, reviews: [],
    head: HEAD, authorType: 'User', authorLogin: 'srstack' });
  assert.equal(stale.outcome, 'unverifiable');
  assert.match(stale.reason, /retry the run/);
  const truncated = gate({ files, pull: { changed_files: 2, head: { sha: HEAD } }, reviews: [],
    head: HEAD, authorType: 'User', authorLogin: 'srstack' });
  assert.equal(truncated.outcome, 'unverifiable');
  assert.match(truncated.reason, /Cannot verify every changed file/);
  // Malformed metadata is the same class: the caller retries rather than guessing.
  const malformed = gate({ files: [], pull: {}, reviews: [], head: HEAD, authorType: 'User', authorLogin: 'srstack' });
  assert.equal(malformed.outcome, 'unverifiable');
  assert.match(malformed.reason, /changed_files or head\.sha/);
});

test('paginated page arrays and null users are handled', () => {
  const reviews = [
    [review(null, 'APPROVED')],
    [review('qiffang', 'COMMENTED', HEAD, '2026-11-10T09:00:00Z'), review('qiffang', 'APPROVED', HEAD, '2026-11-10T10:00:00Z')],
  ];
  assert.deepEqual(approvedLogins(reviews, HEAD, WRITE), ['qiffang']);
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

test('an approval of an earlier commit does not authorize the new head', () => {
  // Approve-A-then-push-B: the exact-head check must not treat A's approval as
  // B's. GitHub also dismisses stale approvals and requires one after the last
  // push, so the gate reports the approval-required outcome instead of "approved"
  // — that is the regression signal if a setting is removed.
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const result = gate({
    files: [[{ filename: 'site/index.html' }]],
    pull: { changed_files: 1, head: { sha: B } },
    reviews: [review('qiffang', 'APPROVED', A)],
    collaborators: [[{ login: 'qiffang', permissions: { push: true } }]],
    head: B,
    authorType: 'User',
    authorLogin: 'srstack',
  });
  assert.equal(result.outcome, 'approval');
  assert.deepEqual(result.approved, []);
});

test('the gate reports every outcome, retries the unverifiable one, and never fails on approval', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'publication-gate-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../scripts/publication-approval.mjs', import.meta.url));
  const files = join(directory, 'files.json');
  const pull = join(directory, 'pull.json');
  const reviews = join(directory, 'reviews.json');
  await writeFile(reviews, JSON.stringify([review('mornyx', 'APPROVED')]));
  const collaborators = join(directory, 'collaborators.json');
  await writeFile(collaborators, JSON.stringify([[{ login: 'mornyx', permissions: { push: true } }]]));
  const pathsOut = join(directory, 'changed-paths.txt');
  const run = async (changeFiles, { authorType = 'User', authorLogin = 'srstack', head = HEAD, pullHead = HEAD, reviewsPath = reviews } = {}) => {
    await writeFile(files, JSON.stringify([changeFiles.map(filename => ({ filename }))]));
    await writeFile(pull, JSON.stringify({ changed_files: changeFiles.length, head: { sha: pullHead } }));
    return spawnSync(process.execPath, [cli, 'gate', '--files', files, '--pull', pull, '--reviews', reviewsPath,
      '--collaborators', collaborators, '--head', head, '--author-type', authorType, '--author-login', authorLogin,
      '--paths-out', pathsOut], { encoding: 'utf8' });
  };

  // Nothing privileged changed: pass without looking at reviews, and still hand
  // the validation step the full changed-file list.
  const unchanged = await run(['docs/notes.md']);
  assert.equal(unchanged.status, 0);
  assert.equal(unchanged.stdout.trim(), 'Build surface unchanged.');
  assert.equal(await readFile(pathsOut, 'utf8'), 'docs/notes.md\n');

  // Privileged change with an approval on this head: pass.
  const approved = await run(['scripts/build-surface.mjs']);
  assert.equal(approved.status, 0);
  assert.match(approved.stdout, /Approved by mornyx/);

  // Privileged change without an approval: advisory. GitHub's required review is
  // the merge gate and clears itself on approval, so CI must not block here.
  const none = join(directory, 'empty.json');
  await writeFile(none, '[]');
  const rejected = spawnSync(process.execPath, [cli, 'gate', '--files', files, '--pull', pull,
    '--reviews', none, '--collaborators', collaborators, '--head', HEAD,
    '--author-type', 'User', '--author-login', 'srstack', '--paths-out', pathsOut], { encoding: 'utf8' });
  assert.equal(rejected.status, 0);
  assert.match(rejected.stdout, /Build surface changed \(approval\)/);
  assert.match(rejected.stderr, /requires an approving review on this exact head/);
  assert.match(rejected.stderr, /needs no re-run/);

  // Publisher app shipping only the artifact: pass without an approval, and the
  // list written for validation keeps every path, not just the privileged ones.
  const exempt = await run(['vendor/studio/index.html', 'vendor/studio-build.json'],
    { authorType: 'Bot', authorLogin: 'mem9-studio-publisher[bot]' });
  assert.equal(exempt.status, 0);
  assert.match(exempt.stdout, /no maintainer approval is required/);
  assert.equal(await readFile(pathsOut, 'utf8'), 'vendor/studio/index.html\nvendor/studio-build.json\n');

  // The same files from any other app, or mixed with code: not exempt, so the
  // outcome is the advisory approval one rather than a pass through the exemption.
  const otherApp = await run(['vendor/studio/index.html'], { authorType: 'Bot', authorLogin: 'dependabot[bot]', reviewsPath: none });
  assert.equal(otherApp.status, 0);
  assert.match(otherApp.stdout, /Build surface changed \(approval\)/);
  const mixed = await run(['vendor/studio/index.html', 'scripts/build-surface.mjs'],
    { authorType: 'Bot', authorLogin: 'mem9-studio-publisher[bot]', reviewsPath: none });
  assert.equal(mixed.status, 0);
  assert.match(mixed.stdout, /Build surface changed \(approval\)/);

  // A listing that does not match the head asked for: retry (3), never a verdict.
  const stale = await run(['scripts/build-surface.mjs'], { pullHead: 'b'.repeat(40) });
  assert.equal(stale.status, 3);
  assert.match(stale.stderr, /retry the run/);

  // An incomplete listing is also retryable, not a pass.
  await writeFile(files, JSON.stringify([[{ filename: 'scripts/build-surface.mjs' }]]));
  await writeFile(pull, JSON.stringify({ changed_files: 2, head: { sha: HEAD } }));
  const truncated = spawnSync(process.execPath, [cli, 'gate', '--files', files, '--pull', pull, '--reviews', reviews,
    '--collaborators', collaborators, '--head', HEAD, '--author-type', 'User', '--author-login', 'srstack'],
  { encoding: 'utf8' });
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
  // Approver authorization needs GitHub's write-access data, not an association.
  assert.match(workflow, /collaborators\?affiliation=all/);
  assert.match(workflow, /--collaborators "\$RUNNER_TEMP\/collaborators\.json"/);
  // The decision must not be re-implemented in shell any more.
  assert.doesNotMatch(workflow, /build-surface\.mjs --stdin/);
  assert.doesNotMatch(workflow, /bot-artifact/);
  assert.doesNotMatch(workflow, /case "\$changed" in/);
  // Identity tripwire: artifact-only validation stays pinned to the publisher app
  // and must never widen back to "any Bot" (the exact principal-confusion #145
  // fixed). These two assertions used to live in the deleted bot-artifact test.
  assert.match(workflow, /ARTIFACT_ONLY: \$\{\{ github\.event\.pull_request\.user\.login == 'mem9-studio-publisher\[bot\]' \}\}/);
  assert.doesNotMatch(workflow, /ARTIFACT_ONLY: \$\{\{ github\.event\.pull_request\.user\.type == 'Bot'/);
  // The branch name is candidate-controlled, so it must not select artifact-only
  // validation (or anything else) any more.
  assert.doesNotMatch(workflow, /automation\/studio-console/);
  // Exactly one decision call, and its exit code is forwarded rather than swallowed.
  assert.equal(workflow.match(/publication-approval\.mjs gate/g).length, 1);
  assert.match(workflow, /if \[ "\$status" -ne 3 \]; then/);
  assert.match(workflow, /exit "\$status"/);
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

test('the probe trusts only the latest required check run it registered', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'publication-foreign-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../scripts/publication-approval.mjs', import.meta.url));
  const file = join(directory, 'check-runs.json');
  // `gh api --paginate --slurp` on this endpoint wraps a page *object*:
  // [{"total_count": n, "check_runs": [...]}]. The command is asked for
  // filter=latest, so exactly one run is expected.
  const listing = runs => JSON.stringify([{ total_count: runs.length, check_runs: runs }]);
  const run = async (body, ownId = '111') => {
    await writeFile(file, body);
    return spawnSync(process.execPath, [cli, 'foreign-check', '--check-runs', file, '--check-id', String(ownId)], { encoding: 'utf8' });
  };

  // Our own run is the latest: pass.
  const own = await run(listing([{ id: 111, status: 'in_progress' }]));
  assert.equal(own.status, 0);
  assert.match(own.stdout, /is the one this workflow registered/);

  // A foreign run is the latest run GitHub would evaluate: fail.
  const foreign = await run(listing([{ id: 222, conclusion: 'success' }]));
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /own check run \(111\) is absent/);

  // Our own run present but another run in the same listing: still fail.
  const both = await run(listing([{ id: 111 }, { id: 222, conclusion: 'success' }]));
  assert.equal(both.status, 1);
  assert.match(both.stderr, /Foreign check run 222/);

  // Fail closed on every unreadable shape rather than reporting "no foreign run".
  for (const body of [
    '[]',
    JSON.stringify([{}]),
    JSON.stringify([{ total_count: 0, check_runs: [] }]),
    JSON.stringify([{ check_runs: [{ id: 'not-a-number' }] }]),
    'not json',
  ]) {
    const rejected = await run(body);
    assert.equal(rejected.status, 1, body);
    assert.match(rejected.stderr, /Refusing to trust the check-run listing/, body);
  }

  // A missing file and a missing/empty id are failures, not passes.
  const missingFile = spawnSync(process.execPath, [cli, 'foreign-check', '--check-runs', join(directory, 'absent.json'), '--check-id', '111'], { encoding: 'utf8' });
  assert.equal(missingFile.status, 1);
  for (const ownId of ['', '  ', 'abc']) {
    const noId = await run(listing([{ id: 111 }]), ownId);
    assert.equal(noId.status, 1, `ownId=${JSON.stringify(ownId)}`);
  }
});

test('the workflow pins the probe to filter=latest and fails the check when validation is skipped', () => {
  const workflow = readFileSync(new URL('../.github/workflows/studio-publication.yml', import.meta.url), 'utf8');
  // `filter=latest` returns the newest run per check suite and name, so this
  // workflow's own earlier attempts never reach the probe; the query is pinned
  // because that property lives in the API, not in the reader.
  assert.match(workflow, /check-runs\?check_name=Studio%20artifact&filter=latest/);
  assert.doesNotMatch(workflow, /filter=all/);
  assert.match(workflow, /publication-approval\.mjs foreign-check/);
  assert.match(workflow, /--check-id "\$CHECK_ID"/);
  // The probe fails the required check because the report step takes its
  // conclusion from the validation outcome and validation follows the probe.
  assert.ok(workflow.indexOf('foreign-check') < workflow.indexOf('Validate candidate data with trusted code'));
  assert.match(workflow, /CONCLUSION: \$\{\{ steps\.validate\.outcome == 'success' && 'success' \|\| 'failure' \}\}/);
  assert.match(workflow, /if: always\(\) && steps\.check\.outputs\.id != ''/);
});
