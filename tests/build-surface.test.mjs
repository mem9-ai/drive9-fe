import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import {
  isPublicPage,
  CONSOLE_ARTIFACT_DIRECTORY,
  CONSOLE_MANIFEST,
  isConsoleArtifactPath,
  PRIVILEGED_EXAMPLES,
  privilegedBuildSurface,
  changedSurface,
  UNCHANGED,
} from '../scripts/build-surface.mjs';

const codeOwners = () => readFileSync(new URL('../.github/CODEOWNERS', import.meta.url), 'utf8')
  .split('\n')
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'))
  .map(line => line.split(/\s+/)[0].replace(/^\//, ''));

const covers = (entries, path) => entries.some(pattern =>
  pattern.endsWith('/') ? path.startsWith(pattern) : path === pattern);

test('the privileged surface is exactly what the project ships or executes', () => {
  for (const path of PRIVILEGED_EXAMPLES) {
    assert.ok(privilegedBuildSurface(path), path);
  }
  for (const path of ['site/styles.css', 'site/robots.txt', 'tests/build-surface.test.mjs', 'README.md']) {
    assert.ok(!privilegedBuildSurface(path), path);
  }
});

test('the changed subset keeps every privileged path, including both sides of a rename', () => {
  // GitHub reports the new and the previous name of a rename, so a privileged file
  // cannot be moved out of the gate by renaming it.
  assert.equal(UNCHANGED, 'Build surface unchanged.');
  assert.deepEqual(changedSurface(['site/styles.css', 'README.md']), []);
  assert.deepEqual(
    changedSurface(['scripts/evil.mjs', 'site/styles.css', 'site/package.json']),
    ['scripts/evil.mjs', 'site/package.json'],
  );
  assert.deepEqual(
    changedSurface(['docs/notes.md', 'scripts/prepare-studio.mjs', 'vendor/studio/x.js']),
    ['scripts/prepare-studio.mjs', 'vendor/studio/x.js'],
  );
});

test('every published page is gated and owned, including ones added later', () => {
  // The pattern gates new pages without an edit here; this test keeps the
  // CODEOWNERS side honest, because an ungated-by-ownership page would still be
  // merged on one person's say-so.
  const pages = readdirSync(new URL('../site', import.meta.url)).filter(name => name.endsWith('.html'));
  assert.ok(pages.length > 0);
  const entries = codeOwners();
  for (const page of pages) {
    const path = `site/${page}`;
    assert.ok(privilegedBuildSurface(path), `${path} must be in the surface`);
    assert.ok(covers(entries, path), `CODEOWNERS must cover ${path}`);
  }
  assert.ok(isPublicPage('site/brand-new.html'));
  assert.ok(!isPublicPage('site/manifest/x.html'));
});

test('CODEOWNERS covers the whole enforced surface', () => {
  const entries = codeOwners();
  for (const path of PRIVILEGED_EXAMPLES) {
    assert.ok(privilegedBuildSurface(path), path);
    assert.ok(covers(entries, path), `CODEOWNERS must cover ${path}`);
  }
});

test('every console-artifact path is also a privileged build path', () => {
  // The surface is evaluated before the exemption, so a path the exemption accepts
  // but the surface does not would read "Build surface unchanged." — green with no
  // approval and without the validator ever walking that path. The corpus derives
  // from the shared constants, so admitting a new artifact widens it in one edit.
  const positives = [
    `${CONSOLE_ARTIFACT_DIRECTORY}index.html`,
    `${CONSOLE_ARTIFACT_DIRECTORY}assets/app.js`,
    `${CONSOLE_ARTIFACT_DIRECTORY}discover/index.html`,
    CONSOLE_MANIFEST,
  ];
  for (const path of positives) {
    assert.ok(isConsoleArtifactPath(path), `${path} must be the artifact`);
    assert.ok(privilegedBuildSurface(path), `${path} must also be in the privileged surface`);
  }
  const directory = CONSOLE_ARTIFACT_DIRECTORY.replace(/\/$/, '');
  for (const path of [
    `${directory}-extra.json`,
    `${directory}-evil/assets/app.js`,
    directory,
    `site${CONSOLE_ARTIFACT_DIRECTORY}x.js`,
    'site/install.sh',
  ]) {
    assert.equal(isConsoleArtifactPath(path), false, path);
  }
});
