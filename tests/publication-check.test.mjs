import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import * as module from '../scripts/publication-check.mjs';
import { changedPaths, flattenPages, foreignCheckRuns, gate } from '../scripts/publication-check.mjs';

const HEAD = 'a'.repeat(40);
const cli = fileURLToPath(new URL('../scripts/publication-check.mjs', import.meta.url));
const workflow = readFileSync(new URL('../.github/workflows/studio-publication.yml', import.meta.url), 'utf8');

test('the module is exactly the listing check and the probe', () => {
  // The approval counting, permission mapping and artifact-only exemption are
  // deliberately gone: GitHub's required review is the merge gate, and that data
  // could only change a log line while still failing the check when its read
  // failed. This pin is what keeps them from growing back.
  assert.deepEqual(Object.keys(module).sort(), ['changedPaths', 'flattenPages', 'foreignCheckRuns', 'gate']);
});

test('paginated pages flatten to one list', () => {
  assert.deepEqual(flattenPages([[{ filename: 'a' }], [{ filename: 'b' }]]), [{ filename: 'a' }, { filename: 'b' }]);
  // A single page object is not a page list; callers must not treat it as one.
  assert.deepEqual(flattenPages({ changed_files: 1 }), []);
  assert.deepEqual(flattenPages(undefined), []);
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
  // A page of entries without filenames cannot stand in for the reported count.
  assert.throws(() => changedPaths([[{ nope: true }]], { changed_files: 1, head: { sha: HEAD } }, HEAD), /Cannot verify/);
});

test('gate reports an untrustworthy listing as an outcome instead of throwing', () => {
  const files = [[{ filename: 'scripts/build-surface.mjs' }]];
  // A head mismatch and an incomplete listing are expected conditions the caller
  // has to retry on, so they are values, not exceptions.
  const stale = gate({ files, pull: { changed_files: 1, head: { sha: 'b'.repeat(40) } }, head: HEAD });
  assert.equal(stale.outcome, 'unverifiable');
  assert.match(stale.reason, /retry the run/);
  assert.deepEqual(stale.paths, []);
  assert.deepEqual(stale.changed, []);
  const truncated = gate({ files, pull: { changed_files: 2, head: { sha: HEAD } }, head: HEAD });
  assert.equal(truncated.outcome, 'unverifiable');
  assert.match(truncated.reason, /Cannot verify every changed file/);
  // Malformed metadata is the same class: the caller retries rather than guessing.
  const malformed = gate({ files: [], pull: {}, head: HEAD });
  assert.equal(malformed.outcome, 'unverifiable');
  assert.match(malformed.reason, /changed_files or head\.sha/);
});

test('gate names the changed surface and keeps the whole path list', () => {
  // The approval outcome is gone, so a privileged change is a report: it passes,
  // because the repository's required review is what gates the merge.
  const result = gate({
    files: [[{ filename: 'docs/notes.md' }, { filename: 'scripts/prepare-studio.mjs' }]],
    pull: { changed_files: 2, head: { sha: HEAD } },
    head: HEAD,
  });
  assert.equal(result.outcome, 'changed');
  assert.deepEqual(result.changed, ['scripts/prepare-studio.mjs']);
  // Validation consumes the full list to prove an artifact publication changed
  // nothing else, so it must not be narrowed to the privileged subset.
  assert.deepEqual(result.paths, ['docs/notes.md', 'scripts/prepare-studio.mjs']);

  const unchanged = gate({
    files: [[{ filename: 'docs/notes.md' }]],
    pull: { changed_files: 1, head: { sha: HEAD } },
    head: HEAD,
  });
  assert.equal(unchanged.outcome, 'unchanged');
  assert.deepEqual(unchanged.changed, []);
});

test('the gate CLI reports, retries the unverifiable listing, and writes the path list', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'publication-check-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = join(directory, 'files.json');
  const pull = join(directory, 'pull.json');
  const pathsOut = join(directory, 'changed-paths.txt');
  const run = async (changeFiles, { head = HEAD, pullHead = HEAD, pullBody } = {}) => {
    await writeFile(files, JSON.stringify([changeFiles.map(filename => ({ filename }))]));
    await writeFile(pull, JSON.stringify(pullBody ?? { changed_files: changeFiles.length, head: { sha: pullHead } }));
    return spawnSync(process.execPath,
      [cli, 'gate', '--files', files, '--pull', pull, '--head', head, '--paths-out', pathsOut], { encoding: 'utf8' });
  };

  // Nothing privileged changed: pass, and still hand the validation step the
  // full changed-file list.
  const unchanged = await run(['docs/notes.md']);
  assert.equal(unchanged.status, 0);
  assert.equal(unchanged.stdout.trim(), 'Build surface unchanged.');
  assert.equal(unchanged.stderr, '');
  assert.equal(await readFile(pathsOut, 'utf8'), 'docs/notes.md\n');

  // A privileged change passes too and names what changed; there is no approval
  // outcome to report any more.
  const changed = await run(['scripts/build-surface.mjs']);
  assert.equal(changed.status, 0);
  assert.equal(changed.stdout.trim(), 'Build surface changed:\nscripts/build-surface.mjs');
  assert.equal(await readFile(pathsOut, 'utf8'), 'scripts/build-surface.mjs\n');
  assert.doesNotMatch(changed.stdout, /approval/i);

  // A listing that does not match the head asked for: retry (3), never a verdict.
  const stale = await run(['scripts/build-surface.mjs'], { pullHead: 'b'.repeat(40) });
  assert.equal(stale.status, 3);
  assert.match(stale.stderr, /retry the run/);

  // An incomplete listing is also retryable, not a pass.
  const truncated = await run(['scripts/build-surface.mjs'], { pullBody: { changed_files: 2, head: { sha: HEAD } } });
  assert.equal(truncated.status, 3);
  assert.match(truncated.stderr, /Cannot verify every changed file/);

  // Malformed metadata and an unreadable file are the same retryable class.
  const malformed = await run([], { pullBody: {} });
  assert.equal(malformed.status, 3);
  assert.match(malformed.stderr, /changed_files or head\.sha/);
  const broken = join(directory, 'broken.json');
  await writeFile(broken, 'not json');
  const unreadable = spawnSync(process.execPath,
    [cli, 'gate', '--files', broken, '--pull', pull, '--head', HEAD], { encoding: 'utf8' });
  assert.equal(unreadable.status, 3);
  assert.match(unreadable.stderr, /Cannot read the gate inputs/);

  // Anything but the two subcommands is a usage error.
  const usage = spawnSync(process.execPath, [cli, 'approvals', '--head', HEAD], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /gate --files/);
  assert.match(usage.stderr, /foreign-check --check-runs/);
});

test('the workflow keeps only fetching, one gate invocation and the probe', () => {
  // No author identity reaches the decision any more.
  assert.doesNotMatch(workflow, /PR_AUTHOR/);
  assert.match(workflow, /publication-check\.mjs gate/);
  // The validation step consumes this file; the gate must be what produces it.
  assert.match(workflow, /--paths-out "\$RUNNER_TEMP\/changed-paths\.txt"/);
  // Reviews and collaborators are not read at all any more: nothing in the check
  // may depend on data that no longer decides anything.
  assert.doesNotMatch(workflow, /\/reviews\?/);
  assert.doesNotMatch(workflow, /collaborators\?affiliation/);
  assert.doesNotMatch(workflow, /--reviews|--collaborators|--author-type|--author-login/);
  // The decision must not be re-implemented in shell any more.
  assert.doesNotMatch(workflow, /build-surface\.mjs --stdin/);
  assert.doesNotMatch(workflow, /bot-artifact/);
  assert.doesNotMatch(workflow, /case "\$changed" in/);
  // Identity tripwire: artifact-only validation stays pinned to the publisher app
  // and must never widen back to "any Bot" (the exact principal-confusion #145
  // fixed).
  assert.match(workflow, /ARTIFACT_ONLY: \$\{\{ github\.event\.pull_request\.user\.login == 'mem9-studio-publisher\[bot\]' \}\}/);
  assert.doesNotMatch(workflow, /ARTIFACT_ONLY: \$\{\{ github\.event\.pull_request\.user\.type == 'Bot'/);
  // The branch name is candidate-controlled, so it must not select artifact-only
  // validation (or anything else) any more.
  assert.doesNotMatch(workflow, /automation\/studio-console/);
  // Exactly one decision call, and its exit code is forwarded rather than swallowed.
  assert.equal(workflow.match(/publication-check\.mjs gate/g).length, 1);
  assert.match(workflow, /if \[ "\$status" -ne 3 \]; then/);
  assert.match(workflow, /exit "\$status"/);
});

test('the probe trusts only the latest required check run it registered', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'publication-foreign-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'check-runs.json');
  // `gh api --paginate --slurp` on this endpoint wraps a page *object*:
  // [{"total_count": n, "check_runs": [...]}]. The command is asked for
  // filter=latest, so exactly one run is expected.
  const listing = runs => JSON.stringify([{ total_count: runs.length, check_runs: runs }]);
  const run = async (body, ownId = '111') => {
    await writeFile(file, body);
    return spawnSync(process.execPath, [cli, 'foreign-check', '--check-runs', file, '--check-id', String(ownId)], { encoding: 'utf8' });
  };

  // The reader itself, without the CLI: it cannot ignore what it does not know.
  assert.deepEqual(foreignCheckRuns([{ check_runs: [{ id: 1 }, { id: 2 }] }], '1'), [{ id: 2 }]);
  assert.throws(() => foreignCheckRuns([], '1'), /listing is missing/);
  assert.throws(() => foreignCheckRuns([{ check_runs: [] }], '1'), /listing is empty/);
  assert.throws(() => foreignCheckRuns([{ check_runs: [{ id: 2 }] }], '1'), /own check run \(1\) is absent/);

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
  const missingFile = spawnSync(process.execPath,
    [cli, 'foreign-check', '--check-runs', join(directory, 'absent.json'), '--check-id', '111'], { encoding: 'utf8' });
  assert.equal(missingFile.status, 1);
  for (const ownId of ['', '  ', 'abc']) {
    const noId = await run(listing([{ id: 111 }]), ownId);
    assert.equal(noId.status, 1, `ownId=${JSON.stringify(ownId)}`);
  }
});

test('the workflow pins the probe to filter=latest and fails the check when validation is skipped', () => {
  // `filter=latest` returns the newest run per check suite and name, so this
  // workflow's own earlier attempts never reach the probe; the query is pinned
  // because that property lives in the API, not in the reader.
  assert.match(workflow, /check-runs\?check_name=Studio%20artifact&filter=latest/);
  assert.doesNotMatch(workflow, /filter=all/);
  assert.match(workflow, /publication-check\.mjs foreign-check/);
  assert.match(workflow, /--check-id "\$CHECK_ID"/);
  // The probe fails the required check because the report step takes its
  // conclusion from the validation outcome and validation follows the probe.
  assert.ok(workflow.indexOf('foreign-check') < workflow.indexOf('Validate candidate data with trusted code'));
  assert.match(workflow, /CONCLUSION: \$\{\{ steps\.validate\.outcome == 'success' && 'success' \|\| 'failure' \}\}/);
  assert.match(workflow, /if: always\(\) && steps\.check\.outputs\.id != ''/);
});
