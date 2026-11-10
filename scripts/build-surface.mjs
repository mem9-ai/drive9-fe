import { readFileSync, realpathSync } from 'node:fs';

// Files that decide what the privileged Netlify deploy build executes, or that
// make it install and run third-party code. Netlify runs the build command from
// the merged revision, reads configuration from the repository root or the base
// directory, and installs dependencies when it finds a manifest — so a change to
// any of these changes code execution in the deploy environment. This module is
// the single source for the gate in `.github/workflows/studio-publication.yml`.
//
// `.github/CODEOWNERS` keeps a deliberately broader review set. The examples
// below are the canonical list the tests and the CODEOWNERS coverage check use,
// so widening the surface cannot silently drift from either.
const DEPENDENCY_MANIFESTS = ['package.json', 'package-lock.json'];

export const privilegedBuildSurface = path =>
  path === 'netlify.toml' ||
  path === 'site/netlify.toml' ||
  path.startsWith('scripts/') ||
  path.startsWith('.github/workflows/') ||
  DEPENDENCY_MANIFESTS.includes(path) ||
  DEPENDENCY_MANIFESTS.map(name => `site/${name}`).includes(path);

export const PRIVILEGED_EXAMPLES = [
  'netlify.toml',
  'site/netlify.toml',
  'scripts/prepare-studio.mjs',
  'scripts/netlify-ignore.mjs',
  '.github/workflows/studio-publication.yml',
  'package.json',
  'package-lock.json',
  'site/package.json',
  'site/package-lock.json',
];

export const UNCHANGED = 'Build surface unchanged.';

export const changedSurface = files => files.filter(privilegedBuildSurface);

const invokedDirectly = () => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) === import.meta.filename : false;
  } catch {
    return false;
  }
};

// Reads a newline-separated path list on stdin — GitHub's pull request file list,
// which is computed against the merge base and reports both sides of a rename —
// and prints the privileged subset, or UNCHANGED. This is the only mode: the gate
// must have exactly one definition of "changed".
if (invokedDirectly()) {
  if (!process.argv.includes('--stdin')) {
    console.error('usage: node scripts/build-surface.mjs --stdin < changed-paths.txt');
    process.exitCode = 2;
  } else {
    const files = readFileSync(0, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const changed = changedSurface(files);
    console.log(changed.length === 0 ? UNCHANGED : changed.join('\n'));
  }
}
