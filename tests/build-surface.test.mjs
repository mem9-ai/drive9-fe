import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import {
  CONSOLE_ARTIFACT_DIRECTORY,
  CONSOLE_MANIFEST,
  isConsoleArtifactPath,
  PRIVILEGED_EXAMPLES,
  privilegedBuildSurface,
  changedSurface,
  UNCHANGED,
} from '../scripts/build-surface.mjs';

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

test('every published page is gated, including pages added later', () => {
  // The pattern gates a page added later without an edit here; CODEOWNERS stays
  // coarse on purpose (it drives review requests, not the merge decision).
  const pages = readdirSync(new URL('../site', import.meta.url)).filter(name => name.endsWith('.html'));
  assert.ok(pages.length > 0);
  for (const page of pages) {
    assert.ok(privilegedBuildSurface(`site/${page}`), `site/${page} must be in the surface`);
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
