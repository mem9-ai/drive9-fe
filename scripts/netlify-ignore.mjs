import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Netlify's base is site/, but Studio and its build tooling live outside it.
// Exit 0 skips a build; exit 1 builds, including when comparison is unavailable.
const root = fileURLToPath(new URL('../', import.meta.url));
const before = process.env.CACHED_COMMIT_REF;
const after = process.env.COMMIT_REF;
let unchanged = false;
if ([before, after].every(value => /^[a-f0-9]{40}$/.test(value || ''))) {
  try {
    execFileSync('git', ['diff', '--quiet', before, after, '--', 'site', 'scripts', 'vendor', 'tests'], {
      cwd: root,
      stdio: 'ignore',
      timeout: 10_000,
    });
    unchanged = true;
  } catch {
    // First builds, shallow history and Git errors must not hide an update.
  }
}
console.log(unchanged ? 'No website build inputs changed; skipping.' : 'Website build inputs changed or unavailable; building.');
process.exitCode = unchanged ? 0 : 1;
