import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CONSOLE_ARTIFACT_DIRECTORY,
  CONSOLE_MANIFEST,
  isConsoleArtifactPath,
  isPublishedPath,
  PRIVILEGED_EXAMPLES,
  privilegedBuildSurface,
  changedSurface,
  UNCHANGED,
} from '../scripts/build-surface.mjs';

test('the privileged surface is exactly what the project ships or executes', () => {
  for (const path of PRIVILEGED_EXAMPLES) {
    assert.ok(privilegedBuildSurface(path), path);
  }
  for (const path of ['tests/build-surface.test.mjs', 'README.md', 'docs/notes.md']) {
    assert.ok(!privilegedBuildSurface(path), path);
  }
});

test('the changed subset keeps every privileged path, including both sides of a rename', () => {
  // GitHub reports the new and the previous name of a rename, so a privileged file
  // cannot be moved out of the gate by renaming it.
  assert.equal(UNCHANGED, 'Build surface unchanged.');
  assert.deepEqual(changedSurface(['README.md', 'docs/notes.md']), []);
  assert.deepEqual(
    changedSurface(['scripts/evil.mjs', 'site/styles.css', 'site/package.json']),
    ['scripts/evil.mjs', 'site/styles.css', 'site/package.json'],
  );
  assert.deepEqual(
    changedSurface(['docs/notes.md', 'scripts/prepare-studio.mjs', 'vendor/studio/x.js']),
    ['scripts/prepare-studio.mjs', 'vendor/studio/x.js'],
  );
});

test('every published file is gated, except the release blobs the redirect hides', () => {
  // Netlify serves the whole `site/` directory on the origin that holds the Console
  // cookies, so a file added anywhere under it must need the same approval — the
  // walk covers every current file and therefore every future one.
  const siteRoot = fileURLToPath(new URL('../site', import.meta.url));
  const walk = (prefix = '') => readdirSync(join(siteRoot, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = `${prefix}${entry.name}`;
    return entry.isDirectory() ? walk(`${path}/`) : [path];
  });
  const files = walk();
  assert.ok(files.length > 0);
  for (const path of files) {
    const gated = privilegedBuildSurface(`site/${path}`);
    if (path.startsWith('releases/')) {
      // The redirect in site/netlify.toml serves these from releases.drive9.ai.
      assert.equal(gated, false, `site/${path} is unreachable and stays ungated`);
    } else {
      assert.ok(gated, `site/${path} must be in the surface`);
    }
  }
  // Nested files are covered too, not just the top level.
  assert.ok(privilegedBuildSurface('site/docs/nested/new-page.html'));
  assert.ok(privilegedBuildSurface('site/assets/icon.svg'));
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
