import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { changedSurface, UNCHANGED } from './build-surface.mjs';

// The trusted half of the publication gate: does the changed-file listing match
// the pull request, and which of those paths belong to the build surface?
//
// Nothing here decides whether a merge may happen. The repository requires a
// review (with a code-owner rule, so the approval is human) and the two required
// checks; this check reports the surface change and fails closed only where it is
// the only guard: an untrustworthy listing, malformed pull metadata, and a newest
// check run that is not the one this workflow registered.

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

// `gh api --paginate --slurp` returns one array per page; flatten it.
export const flattenPages = value => (Array.isArray(value) ? value.flat() : []);

// Every path the candidate touched, both sides of a rename. The listing is
// compared with the pull request's own count because the files endpoint caps at
// 3000 entries and silently truncates: an incomplete list must not be trusted.
export function changedPaths(files, pull, head) {
  if (!pull || typeof pull.changed_files !== 'number' || !pull.head || typeof pull.head.sha !== 'string') {
    throw new Error('Pull request metadata is missing changed_files or head.sha.');
  }
  if (pull.head.sha !== head) {
    throw new Error(`Pull request head is ${pull.head.sha}, expected ${head}; retry the run.`);
  }
  const entries = flattenPages(files).filter(entry => entry && typeof entry.filename === 'string');
  if (entries.length !== pull.changed_files) {
    throw new Error(`Cannot verify every changed file (${entries.length} listed, ${pull.changed_files} reported).`);
  }
  const paths = new Set();
  for (const entry of entries) {
    paths.add(entry.filename);
    if (entry.previous_filename) paths.add(entry.previous_filename);
  }
  return [...paths];
}

// The whole gate decision, in one tested place. The workflow fetches GitHub's
// objects and calls this; it does not interpret the outcome itself.
//   'unchanged'    — nothing privileged changed
//   'changed'      — privileged paths changed; the report lists them
//   'unverifiable' — the file list cannot be trusted yet, retry
// A stale head, a truncated listing or malformed metadata is an expected
// condition, not an exception: it comes back as `unverifiable` with the reason.
// `paths` is the full changed-file list, not just the privileged subset: the
// validation step consumes it to prove an artifact publication changed nothing
// else, and it must not be reconstructed from a second definition of "changed".
export function gate({ files, pull, head }) {
  let paths;
  try {
    paths = changedPaths(files, pull, head);
  } catch (error) {
    return { outcome: 'unverifiable', reason: error.message, paths: [], changed: [] };
  }
  const changed = changedSurface(paths);
  return { outcome: changed.length === 0 ? 'unchanged' : 'changed', paths, changed };
}

// The required check is identified by name, and a workflow in the candidate's own
// branch can post a run with the same name. The workflow asks for `filter=latest`,
// which is the newest run per check suite and name, and this asserts that the run
// is the one the workflow registered. A malformed page, an empty listing, a
// missing own run or any other id is a failure, not a pass: this check is the only
// place that name is trusted, so it cannot ignore what it does not recognise.
// It cannot see a run posted after this listing is read — including one posted
// while validation and the report still run, when its own run can end `success` —
// which is the residual the README documents.
export function foreignCheckRuns(pages, ownId) {
  if (String(ownId ?? '').trim() === '') throw new Error('No check-run id was provided.');
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('Check-run listing is missing.');
  const runs = [];
  for (const page of pages) {
    if (!page || !Array.isArray(page.check_runs)) throw new Error('Check-run listing is malformed.');
    runs.push(...page.check_runs);
  }
  if (runs.length === 0) throw new Error('Check-run listing is empty.');
  for (const run of runs) {
    if (!run || typeof run.id !== 'number') throw new Error('Check-run listing is malformed.');
  }
  if (!runs.some(run => run.id === Number(ownId))) {
    throw new Error(`This workflow's own check run (${ownId}) is absent from the listing.`);
  }
  return runs.filter(run => run.id !== Number(ownId));
}

const invokedDirectly = () => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) === import.meta.filename : false;
  } catch {
    return false;
  }
};

const option = (args, name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

if (invokedDirectly()) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'foreign-check') {
    try {
      const runs = foreignCheckRuns(readJson(option(args, '--check-runs')), option(args, '--check-id'));
      if (runs.length === 0) {
        console.log('The latest required check run on this head is the one this workflow registered.');
      } else {
        for (const run of runs) {
          console.error(
            `Foreign check run ${run.id} (${run.conclusion ?? run.status ?? 'unknown'}) on this head: `
              + 'the required check must come from this workflow.',
          );
        }
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Refusing to trust the check-run listing: ${error.message}`);
      process.exitCode = 1;
    }
  } else if (command !== 'gate') {
    console.error('usage: publication-check.mjs gate --files F --pull P --head SHA [--paths-out F]');
    console.error('       publication-check.mjs foreign-check --check-runs F --check-id ID');
    process.exitCode = 2;
  } else {
    try {
      const result = gate({
        files: readJson(option(args, '--files')),
        pull: readJson(option(args, '--pull')),
        head: option(args, '--head'),
      });
      if (result.outcome === 'unverifiable') {
        // Expected, retryable: the caller loops on exit 3.
        console.error(result.reason);
        process.exitCode = 3;
      } else {
        const pathsOut = option(args, '--paths-out');
        if (pathsOut) {
          // The validation step runs after this exits 0 and needs the same
          // changed-file list this check just verified.
          writeFileSync(pathsOut, `${result.paths.join('\n')}\n`);
        }
        if (result.outcome === 'unchanged') {
          console.log(UNCHANGED);
        } else {
          console.log('Build surface changed:');
          for (const path of result.changed) console.log(path);
        }
      }
    } catch (error) {
      // Malformed inputs or a bug in a helper: retry once, then fail closed. The
      // reason is prefixed because an unreadable file would otherwise surface the
      // Node wording without saying which input the gate refused.
      console.error(`Cannot read the gate inputs: ${error.message}`);
      process.exitCode = 3;
    }
  }
}
