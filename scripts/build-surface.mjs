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
// Netlify installs from whichever of these it finds (root or base directory), and
// a lockfile or registry config decides what the installer downloads. The non-Node
// manifests are inert for today's static build but are listed so a build command
// that starts using them cannot silently become an ungated execution path.
const DEPENDENCY_FILES = [
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.npmrc',
  '.yarnrc',
  'bun.lockb',
  'deno.json',
  'deno.lock',
  'composer.json',
  'composer.lock',
  'Gemfile',
  'Gemfile.lock',
  'requirements.txt',
  'pyproject.toml',
];

// Code the site publishes and users then execute: the installers and the Console
// bundle. Netlify does not execute these during the build, but a change to them
// changes what every visitor runs, so they need the same maintainer approval.
const PUBLISHED_CODE = [
  'site/install.sh',
  'site/install.ps1',
  'vendor/studio-build.json',
];

// Precomputed once: this predicate runs over every changed path.
const SITE_DEPENDENCY_FILES = DEPENDENCY_FILES.map(name => `site/${name}`);
const EXACT_PATHS = new Set([
  'netlify.toml',
  'site/netlify.toml',
  ...PUBLISHED_CODE,
  ...DEPENDENCY_FILES,
  ...SITE_DEPENDENCY_FILES,
]);

export const privilegedBuildSurface = path =>
  EXACT_PATHS.has(path) ||
  path.startsWith('scripts/') ||
  path.startsWith('.github/workflows/') ||
  path.startsWith('vendor/studio/');

export const PRIVILEGED_EXAMPLES = [
  'netlify.toml',
  'site/netlify.toml',
  'scripts/prepare-studio.mjs',
  'scripts/netlify-ignore.mjs',
  '.github/workflows/studio-publication.yml',
  'site/install.sh',
  'site/install.ps1',
  'vendor/studio/index.html',
  'vendor/studio/assets/app.js',
  'vendor/studio-build.json',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.npmrc',
  '.yarnrc',
  'bun.lockb',
  'deno.json',
  'deno.lock',
  'composer.json',
  'composer.lock',
  'Gemfile',
  'Gemfile.lock',
  'requirements.txt',
  'pyproject.toml',
  'site/package.json',
  'site/package-lock.json',
  'site/yarn.lock',
  'site/pnpm-lock.yaml',
  'site/.npmrc',
  'site/.yarnrc',
  'site/bun.lockb',
  'site/deno.json',
  'site/deno.lock',
  'site/composer.json',
  'site/composer.lock',
  'site/Gemfile',
  'site/Gemfile.lock',
  'site/requirements.txt',
  'site/pyproject.toml',
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
