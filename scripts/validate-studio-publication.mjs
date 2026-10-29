import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyStudioArtifact } from './studio-artifact.mjs';
import { prepareStudio } from './prepare-studio.mjs';

const artifactPath = path => path.startsWith('vendor/studio/') || path === 'vendor/studio-build.json';

// Candidate Git objects are data only. All imports and the site template above/below
// come from the trusted default-branch checkout, never from the PR tree.
export async function validateStudioPublication(repository, base, head, artifactOnly) {
  for (const sha of [base, head]) assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(typeof artifactOnly, 'boolean');
  const git = (...args) => execFileSync('git', args, { cwd: repository, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (artifactOnly) {
    const files = git('diff', '--name-only', '--no-renames', '-z', base, head).toString().split('\0').filter(Boolean);
    assert.ok(files.length > 0, 'Empty publication.');
    assert.ok(files.every(artifactPath), 'Publication may change only Console artifacts and provenance.');
  }
  const temporary = await mkdtemp(join(tmpdir(), 'studio-candidate-'));
  try {
    const entries = git('ls-tree', '-rz', '--full-tree', head, '--', 'vendor/studio', 'vendor/studio-build.json').toString().split('\0').filter(Boolean);
    for (const entry of entries) {
      const match = entry.match(/^100644 blob ([a-f0-9]{40})\t(vendor\/studio-build\.json|vendor\/studio\/(?:index\.html|config\.json|favicon\.svg|assets\/[\w.-]+\.(?:js|css|woff2)))$/);
      assert.ok(match, 'Candidate contains an unexpected artifact path or Git mode.');
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
