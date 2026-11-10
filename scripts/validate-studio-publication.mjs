import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioPublicFile, verifyStudioArtifact } from './studio-artifact.mjs';
import { prepareStudio } from './prepare-studio.mjs';

const artifactPath = path => path.startsWith('vendor/studio/') || path === 'vendor/studio-build.json';

// Files the privileged Netlify build executes (or that decide what it executes).
// A change here is a change to code execution in the deploy environment, so the
// trusted workflow requires a maintainer approval for it on every PR.
export const privilegedBuildSurface = path =>
  path === 'site/netlify.toml' ||
  path.startsWith('scripts/') ||
  path.startsWith('.github/workflows/');

// Candidate Git objects are data only. All imports and the site template above/below
// come from the trusted default-branch checkout, never from the PR tree.
export async function validateStudioPublication(repository, base, head, artifactOnly) {
  for (const sha of [base, head]) assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(typeof artifactOnly, 'boolean');
  const git = (...args) => execFileSync('git', args, { cwd: repository, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const files = git('diff', '--name-only', '--no-renames', '-z', base, head).toString().split('\0').filter(Boolean);
  assert.ok(files.length > 0, 'Empty publication.');
  // Publishing an artifact is author-independent: a candidate that touches the
  // Console artifact may change nothing else, bot or human. Previously only bot
  // PRs were restricted, so a human PR could mix the artifact with arbitrary code.
  if (artifactOnly || files.some(artifactPath)) {
    assert.ok(files.every(artifactPath), 'Publication may change only Console artifacts and provenance.');
  }
  const temporary = await mkdtemp(join(tmpdir(), 'studio-candidate-'));
  try {
    const entries = git('ls-tree', '-rz', '--full-tree', head, '--', 'vendor/studio', 'vendor/studio-build.json').toString().split('\0').filter(Boolean);
    for (const entry of entries) {
      const match = entry.match(/^100644 blob ([a-f0-9]{40})\t(.+)$/);
      assert.ok(match && (match[2] === 'vendor/studio-build.json' ||
        (match[2].startsWith('vendor/studio/') && studioPublicFile(match[2].slice('vendor/studio/'.length)))),
      'Candidate contains an unexpected artifact path or Git mode.');
      const [, object, path] = match;
      const destination = join(temporary, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, git('cat-file', 'blob', object));
    }
    const consoleDirectory = join(temporary, 'vendor/studio');
    await verifyStudioArtifact(consoleDirectory, join(temporary, 'vendor/studio-build.json'));
    const siteDirectory = join(temporary, 'site');
    await cp(fileURLToPath(new URL('../site', import.meta.url)), siteDirectory, { recursive: true });
    await prepareStudio({ consoleDirectory, siteDirectory, apiOrigin: 'https://api.example.invalid' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [base, head, artifactOnly] = process.argv.slice(2);
    assert.ok(['true', 'false'].includes(artifactOnly));
    await validateStudioPublication(process.cwd(), base, head, artifactOnly === 'true');
    console.log('Candidate artifacts validated by trusted main code.');
  } catch {
    console.error('Studio publication validation failed. Candidate was not executed.');
    process.exitCode = 1;
  }
}
