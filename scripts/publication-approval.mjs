import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { changedSurface, isConsoleArtifactPath, UNCHANGED } from './build-surface.mjs';

// Trusted decisions for the Studio publication gate. This logic used to live as
// inline jq in `.github/workflows/studio-publication.yml`, where no test could
// reach it; every defect found in earlier reviews lived exactly there.

const ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Write access is the bar, not an association. `author_association` says MEMBER
// for anyone in the owning organization (who may have no access to this
// repository) and COLLABORATOR for invited read-only users, so on its own it
// admits approvals GitHub does not count towards the required review. The
// collaborators listing is the same source GitHub uses for that decision.
export function permissionMap(collaborators) {
  const map = {};
  for (const entry of flattenPages(collaborators)) {
    if (!entry || typeof entry.login !== 'string' || !entry.permissions) continue;
    const { admin, maintain, push } = entry.permissions;
    if (admin === true || maintain === true || push === true) map[entry.login] = true;
  }
  return map;
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

// `gh api --paginate --slurp` returns one array per page; flatten it.
export const flattenPages = value => (Array.isArray(value) ? value.flat() : []);

// Logins whose latest state-carrying review approves this exact head. An
// ordinary comment after an approval does not revoke it, an approval of an
// earlier commit does not count, and only someone with write access qualifies.
// `permissions` comes from permissionMap; a login missing from it fails closed.
export function approvedLogins(reviews, head, permissions = {}) {
  const latest = new Map();
  for (const review of flattenPages(reviews)) {
    if (!review || !review.user || typeof review.user.login !== 'string') continue;
    if (review.state === 'COMMENTED') continue;
    const current = latest.get(review.user.login);
    if (!current || String(review.submitted_at) >= String(current.submitted_at)) {
      latest.set(review.user.login, review);
    }
  }
  return [...latest.values()]
    .filter(review =>
      review.state === 'APPROVED' &&
      review.commit_id === head &&
      ASSOCIATIONS.has(review.author_association) &&
      permissions[review.user.login] === true)
    .map(review => review.user.login)
    .sort();
}

// The required check is identified by name, and a workflow in the candidate's own
// branch can post a run with the same name. The workflow asks for `filter=latest`,
// which is the single run GitHub evaluates for that name, and this asserts that
// the run is the one the workflow registered. A malformed page, an empty listing,
// a missing own run or any other id is a failure, not a pass: this check is the
// only place that name is trusted, so it cannot ignore what it does not recognise.
// It cannot see a run posted after this one completes, which is the residual the
// README documents and why the required review is the other gate.
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

// The Console publisher app opens artifact-only pull requests and merges them
// itself (24 of them in the week before this gate was written, every one merged
// by the app with no review). Requiring a maintainer to approve a minified
// bundle would not add a real control, and it would stop that pipeline: the
// honest control for those releases is the artifact path allowlist, the manifest
// checksum check and the credential scan that still run.
//
// The principal is the publisher app itself, not "any bot": GitHub enforces no
// such thing as a single `Bot` type — every GitHub App installed on the
// repository (Dependabot-class apps, anything an administrator adds later, or an
// installed app that gets compromised) authors pull requests with
// `user.type == 'Bot'`. The login is server-provided and cannot be chosen by the
// PR author, so the exemption requires both, plus every changed path being the
// artifact, which makes it impossible to smuggle code in with a release.
export const CONSOLE_PUBLISHER_LOGIN = 'mem9-studio-publisher[bot]';

export function botArtifactOnlyPublication(paths, authorType, authorLogin) {
  return authorType === 'Bot' &&
    authorLogin === CONSOLE_PUBLISHER_LOGIN &&
    paths.length > 0 &&
    paths.every(path => isConsoleArtifactPath(path));
}

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
// objects and calls this; it no longer interprets the outcome itself.
//   'unchanged'   — nothing privileged changed
//   'exempt'      — the publisher app shipped nothing but the artifact
//   'approved'    — a maintainer approved this exact head
//   'approval'    — a privileged change without an approval: advisory
//   'unverifiable'— the file list cannot be trusted yet, retry
//
// The approval outcome is advisory: this check never goes red for a missing
// review, so CI is never blocked by one. Everything the review half of this
// module computes (`permissionMap`, `approvedLogins`, the collaborator fetch) is
// **report-only** — it is printed, and it never changes the exit status. The
// merge gate is the repository's required reviews on the latest head
// (`dismiss_stale_reviews`, `require_last_push_approval`, and Code Owners so the
// approval is human-only), which GitHub clears the moment a reviewer approves,
// so no re-run is needed.
//
// The exact-head requirement is still reported here (`approvedLogins` rejects an
// approval of an earlier commit and the hint names the head), which keeps the
// mismatch visible instead of silent. This check stays fail-closed where it is
// the only guard: an untrustworthy listing, malformed metadata, the artifact-only
// path rule, and a foreign check run with the same name.
// A stale head, a truncated listing or malformed pull metadata is an expected
// condition, not an exception: `gate` returns `unverifiable` with the reason, so
// a programmatic caller never has to catch to learn "retry".
// `paths` is the full changed-file list, not just the privileged subset: the
// validation step consumes it to prove an artifact publication changed nothing
// else, and it must not be reconstructed from a second definition of "changed".
export function gate({ files, pull, reviews, collaborators, head, authorType, authorLogin }) {
  let paths;
  try {
    paths = changedPaths(files, pull, head);
  } catch (error) {
    return { outcome: 'unverifiable', reason: error.message, paths: [], changed: [], approved: [] };
  }
  const changed = changedSurface(paths);
  if (changed.length === 0) return { outcome: 'unchanged', paths, changed, approved: [] };
  if (botArtifactOnlyPublication(paths, authorType, authorLogin)) {
    return { outcome: 'exempt', paths, changed, approved: [] };
  }
  const approved = approvedLogins(reviews, head, permissionMap(collaborators));
  return { outcome: approved.length === 0 ? 'approval' : 'approved', paths, changed, approved };
}

export const APPROVAL_HINT = [
  'Build-surface change: the repository requires an approving review on this exact head.',
  'Advisory here: GitHub blocks the merge until that review exists and lets it through when it '
    + 'does, so this check needs no re-run.',
];

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
    console.error('usage: publication-approval.mjs gate --files F --pull P --reviews R '
      + '--collaborators C --head SHA --author-type T --author-login LOGIN [--paths-out F]');
    console.error('       publication-approval.mjs foreign-check --check-runs F --check-id ID');
    process.exitCode = 2;
  } else {
    try {
      const result = gate({
        files: readJson(option(args, '--files')),
        pull: readJson(option(args, '--pull')),
        reviews: readJson(option(args, '--reviews')),
        // Absent collaborator data yields no eligible approver: fail closed.
        collaborators: option(args, '--collaborators') ? readJson(option(args, '--collaborators')) : [],
        head: option(args, '--head'),
        authorType: option(args, '--author-type'),
        authorLogin: option(args, '--author-login'),
      });
      if (result.outcome === 'unverifiable') {
        // Expected, retryable: the caller loops on exit 3.
        console.error(result.reason);
        process.exitCode = 3;
      } else {
        const pathsOut = option(args, '--paths-out');
        if (pathsOut) {
          // The validation step runs after this exits 0 and needs the same
          // changed-file list the gate just verified, not one reconstructed from a
          // second definition of "changed".
          writeFileSync(pathsOut, `${result.paths.join('\n')}\n`);
        }
        if (result.outcome === 'unchanged') {
          console.log(UNCHANGED);
        } else {
          console.log(`Build surface changed (${result.outcome}):`);
          for (const path of result.changed) console.log(path);
          if (result.outcome === 'exempt') {
            console.log(`Artifact-only publication by ${option(args, '--author-login')}: no maintainer approval is required.`);
          } else if (result.outcome === 'approved') {
            console.log(`Approved by ${result.approved.join(', ')} on this head.`);
          } else {
            // Advisory by design: a missing review must never block CI.
            for (const line of APPROVAL_HINT) console.error(line);
          }
        }
      }
    } catch (error) {
      // Malformed inputs or a bug in a helper: retry once, then fail closed.
      console.error(error.message);
      process.exitCode = 3;
    }
  }
}
