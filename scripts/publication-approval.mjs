import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { changedSurface, isConsoleArtifactPath, UNCHANGED } from './build-surface.mjs';

// Trusted decisions for the Studio publication gate. This logic used to live as
// inline jq in `.github/workflows/studio-publication.yml`, where no test could
// reach it; every defect found in earlier reviews lived exactly there.

const ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

// `gh api --paginate --slurp` returns one array per page; flatten it.
export const flattenPages = value => (Array.isArray(value) ? value.flat() : []);

// Logins whose latest state-carrying review approves this exact head. An
// ordinary comment after an approval does not revoke it, an approval of an
// earlier commit does not count, and only repository maintainers qualify.
export function approvedLogins(reviews, head) {
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
      ASSOCIATIONS.has(review.author_association))
    .map(review => review.user.login)
    .sort();
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
//   'unchanged'   — nothing privileged changed, pass
//   'exempt'      — the publisher app shipped nothing but the artifact, pass
//   'approved'    — a maintainer approved this exact head, pass
//   'approval'    — a privileged change without an approval, fail
//   'unverifiable'— the file list cannot be trusted yet, retry
// Any other shape is a bug in this module, not in the workflow.
// `paths` is the full changed-file list, not just the privileged subset: the
// validation step consumes it to prove an artifact publication changed nothing
// else, and it must not be reconstructed from a second definition of "changed".
export function gate({ files, pull, reviews, head, authorType, authorLogin }) {
  const paths = changedPaths(files, pull, head);
  const changed = changedSurface(paths);
  if (changed.length === 0) return { outcome: 'unchanged', paths, changed, approved: [] };
  if (botArtifactOnlyPublication(paths, authorType, authorLogin)) {
    return { outcome: 'exempt', paths, changed, approved: [] };
  }
  const approved = approvedLogins(reviews, head);
  return { outcome: approved.length === 0 ? 'approval' : 'approved', paths, changed, approved };
}

export const APPROVAL_HINT = [
  'Build-surface change needs an approving review from a maintainer on this exact head.',
  'Submitting an approval does not re-run this check automatically; '
    + 're-run "Trusted Studio publication validation" for this branch to re-evaluate.',
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
  if (command !== 'gate') {
    console.error('usage: publication-approval.mjs gate --files F --pull P --reviews R --head SHA '
      + '--author-type T --author-login LOGIN [--paths-out F]');
    process.exitCode = 2;
  } else {
    try {
      const result = gate({
        files: readJson(option(args, '--files')),
        pull: readJson(option(args, '--pull')),
        reviews: readJson(option(args, '--reviews')),
        head: option(args, '--head'),
        authorType: option(args, '--author-type'),
        authorLogin: option(args, '--author-login'),
      });
      const pathsOut = option(args, '--paths-out');
      if (pathsOut) {
        // Written before the verdict matters: the validation step needs the same
        // changed-file list the gate just verified, including the pass outcomes.
        writeFileSync(pathsOut, `${result.paths.join('\n')}\n`);
      }
      if (result.outcome === 'unchanged') {
        console.log(UNCHANGED);
      } else {
        console.log(`Build surface changed (${result.outcome}):`);
        for (const path of result.changed) console.log(path);
        if (result.outcome === 'exempt') {
          console.log(`Artifact-only publication by ${option(args, '--author-login')}: a maintainer approval is not required.`);
        } else if (result.outcome === 'approved') {
          console.log(`Approved by ${result.approved.join(', ')} on this head.`);
        } else {
          for (const line of APPROVAL_HINT) console.error(line);
          process.exitCode = 1;
        }
      }
    } catch (error) {
      // The listing or the head is not trustworthy yet: tell the caller to retry,
      // so the retry decision is not left to the shell.
      console.error(error.message);
      process.exitCode = 3;
    }
  }
}
