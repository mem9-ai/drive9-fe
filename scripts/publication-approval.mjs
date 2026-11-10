import { readFileSync, realpathSync } from 'node:fs';

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
  const head = option(args, '--head');
  try {
    if (command === 'changed-paths') {
      const files = readJson(option(args, '--files'));
      const pull = readJson(option(args, '--pull'));
      for (const path of changedPaths(files, pull, head)) console.log(path);
    } else if (command === 'approvals') {
      const approved = approvedLogins(readJson(option(args, '--reviews')), head);
      if (approved.length === 0) {
        console.error('Build-surface change needs an approving review from a maintainer on this exact head.');
        process.exitCode = 1;
      } else {
        console.log(approved.join('\n'));
      }
    } else {
      console.error('usage: publication-approval.mjs changed-paths --files F --pull P --head SHA');
      console.error('       publication-approval.mjs approvals --reviews R --head SHA');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
