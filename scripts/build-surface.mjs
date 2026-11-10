import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Files that decide what the privileged Netlify deploy build executes, or that
// make it install and run third-party code. Netlify runs the build command from
// the merged revision, reads configuration from the root or the base directory,
// and installs dependencies when it finds a manifest — so a change to any of
// these changes code execution in the deploy environment. This module is the
// single source for the gate in `.github/workflows/studio-publication.yml`.
//
// `.github/CODEOWNERS` keeps a deliberately broader review set; the pairs are
// pinned by `tests/build-surface.test.mjs`.
const DEPENDENCY_MANIFESTS = ['package.json', 'package-lock.json'];

export const privilegedBuildSurface = path =>
  path === 'netlify.toml' ||
  path === 'site/netlify.toml' ||
  path.startsWith('scripts/') ||
  path.startsWith('.github/workflows/') ||
  DEPENDENCY_MANIFESTS.includes(path) ||
  DEPENDENCY_MANIFESTS.map(name => `site/${name}`).includes(path);

export const UNCHANGED = 'Build surface unchanged.';

export function changedBuildSurface(repository, base, head) {
  const files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head], {
    cwd: repository,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .split('\0')
    .filter(Boolean);
  return files.filter(privilegedBuildSurface);
}

// Prints the changed privileged paths (one per line) or the UNCHANGED sentinel.
// `--stdin` reads an explicit newline-separated file list instead of diffing two
// commits: GitHub's pull request file list is computed against the merge base,
// so an advancing `main` cannot make unrelated PRs look like surface changes.
if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const args = process.argv.slice(2);
  const changed = args.includes('--stdin')
    ? readFileSync(0, 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .filter(privilegedBuildSurface)
    : changedBuildSurface(process.cwd(), args[0], args[1]);
  console.log(changed.length === 0 ? UNCHANGED : changed.join('\n'));
}
