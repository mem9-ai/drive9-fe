import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Workflow wiring, not the code the workflows call: those decisions are tested in
// publication-check.test.mjs and build-surface.test.mjs.
const workflow = name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const uncommented = source => source.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');

test('the test suite runs for a PR against any base branch', () => {
  // A stacked PR targets another branch, not main. Filtering the event by base
  // branch left exactly that PR with no CI, so the filter must stay off the
  // pull_request trigger (the push trigger stays on main).
  const events = uncommented(workflow('studio-artifact.yml')).split('permissions:')[0];
  assert.match(events, /^on:$/m);
  assert.match(events, /^  pull_request:$/m);
  assert.match(events, /^  push:\n    branches: \[main\]$/m);
});

test('the trusted publication check runs only for a main base', () => {
  // It validates a candidate against the trusted default branch, so a PR to any
  // other base has nothing to compare with; `pull_request_target` is the only
  // event, because GitHub runs a `pull_request` workflow from the candidate head.
  const events = uncommented(workflow('studio-publication.yml')).split('permissions:')[0];
  assert.match(events, /^  pull_request_target:\n    branches: \[main\]$/m);
  assert.doesNotMatch(events, /^  pull_request:/m);
  assert.doesNotMatch(events, /pull_request_review/);
});
