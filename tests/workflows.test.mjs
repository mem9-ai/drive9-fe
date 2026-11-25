import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Workflow wiring, not the code the workflows call: those decisions are tested in
// publication-check.test.mjs and build-surface.test.mjs. Comments are stripped so a
// comment can never satisfy an assertion about what the workflow does.
const workflow = name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const events = name => workflow(name)
  .split('\n')
  .filter(line => !line.trim().startsWith('#'))
  .join('\n')
  .split('permissions:')[0];

test('the test suite runs for a PR against any base branch', () => {
  // A stacked PR targets another branch, not main, and must run the suite before
  // anyone reviews it. The pin is on the block body, not on the key: any nested
  // filter — `branches`, `types`, `paths` — narrows the trigger again, and
  // matching the key's own line would keep this test green through that.
  const trigger = events('studio-artifact.yml');
  assert.match(trigger, /^on:$/m);
  assert.match(trigger, /^  pull_request:\n(?! {4})/m);
  // `push` stays on the default branch, and gains no other filter.
  assert.match(trigger, /^  push:\n {4}branches: \[main\]\n(?! {4})/m);
});

test('the trusted publication check runs only for a main base', () => {
  // `pull_request_target` runs the base branch's workflow file and scripts, and
  // this job holds `checks: write`; a base other than the protected `main` would
  // let the check that is meant to be trusted come from an unprotected branch. It
  // is also the only trusted event: GitHub runs a `pull_request` workflow from the
  // candidate head, which is the case the probe exists to detect.
  const trigger = events('studio-publication.yml');
  assert.match(trigger, /^  pull_request_target:\n    branches: \[main\]$/m);
  assert.doesNotMatch(trigger, /^  pull_request:/m);
  assert.doesNotMatch(trigger, /pull_request_review/);
});
