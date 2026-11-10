import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Files that decide what the privileged Netlify deploy build executes, or that
// make it install and run third-party code. Netlify runs the build command from
// the merged revision and installs dependencies when it finds a dependency
// manifest, so a change to any of these changes code execution in the deploy
// environment. This module is the single source for the gate in
// `.github/workflows/studio-publication.yml`.
//
// `.github/CODEOWNERS` keeps a deliberately broader review set; keep the two in
// sync when widening this surface.
const DEPENDENCY_MANIFESTS = ['package.json', 'package-lock.json'];

export const privilegedBuildSurface = path =>
  path === 'site/netlify.toml' ||
  path.startsWith('scripts/') ||
  path.startsWith('.github/workflows/') ||
  DEPENDENCY_MANIFESTS.includes(path) ||
  DEPENDENCY_MANIFESTS.map(name => `site/${name}`).includes(path);

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

// Prints the changed privileged paths (one per line) or a single "unchanged"
// line, so the workflow can branch on the output without parsing exit codes.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  const changed = changedBuildSurface(process.cwd(), base, head);
  console.log(changed.length === 0 ? 'Build surface unchanged.' : changed.join('\n'));
}
