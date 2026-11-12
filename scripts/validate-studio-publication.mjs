import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { studioPublicFile, verifyStudioArtifact } from './studio-artifact.mjs';
import { CONSOLE_ARTIFACT_DIRECTORY, CONSOLE_MANIFEST, isConsoleArtifactPath } from './build-surface.mjs';
import { prepareStudio } from './prepare-studio.mjs';

// Candidate Git objects are data only. All imports and the site template above/below
// come from the trusted default-branch checkout, never from the PR tree.
export async function validateStudioPublication(repository, head, artifactOnly, changedFilesPath) {
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.equal(typeof artifactOnly, 'boolean');
  const git = (...args) => execFileSync('git', args, { cwd: repository, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  // The workflow supplies GitHub's pull request file list, computed against the
  // merge base and including both sides of a rename. There is deliberately no
  // git-diff fallback: the gate has one definition of "changed".
  assert.ok(changedFilesPath, 'A changed-file list is required.');
  const files = (await readFile(changedFilesPath, 'utf8')).split('\n').map(line => line.trim()).filter(Boolean);
  assert.ok(files.length > 0, 'Empty publication.');
  // Publishing an artifact is author-independent: a candidate that touches the
  // Console artifact may change nothing else, bot or human. Previously only bot
  // PRs were restricted, so a human PR could mix the artifact with arbitrary code.
  if (artifactOnly || files.some(isConsoleArtifactPath)) {
    assert.ok(files.every(isConsoleArtifactPath), 'Publication may change only Console artifacts and provenance.');
  }
  const temporary = await mkdtemp(join(tmpdir(), 'studio-candidate-'));
  try {
    // The extraction scope comes from the same constants the exemption uses, so a
    // widened artifact cannot be validated here while being waved through there.
    const artifactDirectory = CONSOLE_ARTIFACT_DIRECTORY.replace(/\/$/, '');
    const entries = git('ls-tree', '-rz', '--full-tree', head, '--', artifactDirectory, CONSOLE_MANIFEST).toString().split('\0').filter(Boolean);
    for (const entry of entries) {
      const match = entry.match(/^100644 blob ([a-f0-9]{40})\t(.+)$/);
      assert.ok(match && (match[2] === CONSOLE_MANIFEST ||
        (match[2].startsWith(CONSOLE_ARTIFACT_DIRECTORY) && studioPublicFile(match[2].slice(CONSOLE_ARTIFACT_DIRECTORY.length)))),
      'Candidate contains an unexpected artifact path or Git mode.');
      const [, object, path] = match;
      const destination = join(temporary, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, git('cat-file', 'blob', object));
    }
    const consoleDirectory = join(temporary, artifactDirectory);
    await verifyStudioArtifact(consoleDirectory, join(temporary, CONSOLE_MANIFEST));
    const siteDirectory = join(temporary, 'site');
    await cp(fileURLToPath(new URL('../site', import.meta.url)), siteDirectory, { recursive: true });
    await prepareStudio({ consoleDirectory, siteDirectory, apiOrigin: 'https://api.example.invalid' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const invokedDirectly = () => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) === import.meta.filename : false;
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  try {
    const [head, artifactOnly, changedFilesPath] = process.argv.slice(2);
    assert.ok(['true', 'false'].includes(artifactOnly));
    await validateStudioPublication(process.cwd(), head, artifactOnly === 'true', changedFilesPath);
    console.log('Candidate artifacts validated by trusted main code.');
  } catch {
    console.error('Studio publication validation failed. Candidate was not executed.');
    process.exitCode = 1;
  }
}
