import { readFileSync, realpathSync } from 'node:fs';

// Files that decide what the privileged Netlify deploy build executes, or that
// make it install and run third-party code. Netlify runs the build command from
// the merged revision, reads configuration from the repository root or the base
// directory, and installs dependencies when it finds a manifest — so a change to
// any of these changes code execution in the deploy environment. This module is
// the single source for the gate in `.github/workflows/studio-publication.yml`.
//
// `.github/CODEOWNERS` keeps a deliberately broader review set. `EXACT_PATHS` and
// `PREFIX_SAMPLES` are derived from the sets themselves, so the tests and the
// CODEOWNERS coverage check cannot drift from the surface they describe.
// Netlify installs from whichever of these it finds (root or base directory), and
// a lockfile or registry config decides what the installer downloads. The non-Node
// manifests are inert for today's static build but are listed so a build command
// that starts using them cannot silently become an ungated execution path.
const DEPENDENCY_FILES = [
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'bun.lock',
  'bun.lockb',
  'deno.json',
  'deno.lock',
  'composer.json',
  'composer.lock',
  'Gemfile',
  'Gemfile.lock',
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
];

// The Console artifact lives under one directory plus one provenance manifest.
// Every consumer derives from these two constants — the exemption predicate, the
// privileged surface below, the trusted validator's extraction scope, and the
// tests' corpus of positives and lookalike negatives — so widening the artifact
// widens all of them in one edit. The quiet failure mode this prevents: a
// publisher pull request touching only a newly admitted path would read
// "Build surface unchanged." (the surface is evaluated before the exemption), so
// the check would go green without any approval and without the validator ever
// walking that path.
export const CONSOLE_ARTIFACT_DIRECTORY = 'vendor/studio/';
export const CONSOLE_MANIFEST = 'vendor/studio-build.json';
// Detached signature over the manifest bytes (#147); part of the artifact so a
// publisher pull request can carry it.
export const CONSOLE_SIGNATURE = 'vendor/studio-build.json.sig';

// What the site ships as code rather than as text: the installers (run on the
// visitor's machine) and the Console bundle with its provenance manifest (served
// to the browser, published by automation). These are not executed by the build,
// but a change to them changes what every visitor runs, so they need the same
// maintainer approval. `site/*.html` is deliberately not here: a page is content
// that changes through ordinary review, and inline script in it is not the
// automated publication path this gate exists to control.
//
// `site/releases/**` (checked-in binaries) is not here either, and does not need
// to be: `/releases/*` is redirected to releases.drive9.ai with `force = true` in
// `site/netlify.toml`, so those files are unreachable in production. The redirect
// is what protects them, and that file is in the surface.
const PUBLISHED_CODE = [
  'site/install.sh',
  'site/install.ps1',
  CONSOLE_MANIFEST,
  CONSOLE_SIGNATURE,
];

// Imported by the approval exemption and by the trusted validator, so the two
// halves of the exemption cannot disagree about which paths they cover.
export const isConsoleArtifactPath = path =>
  path.startsWith(CONSOLE_ARTIFACT_DIRECTORY) || path === CONSOLE_MANIFEST || path === CONSOLE_SIGNATURE;

// Precomputed once: this predicate runs over every changed path.
const SITE_DEPENDENCY_FILES = DEPENDENCY_FILES.map(name => `site/${name}`);

// Netlify deploys functions from the base directory without any configuration:
// the defaults are `netlify/functions` and `netlify/edge-functions` resolved
// against the base directory, which is `site` here. A pull request that drops a
// file under either path gets code running in the deployed site, with the site's
// environment, without touching any other privileged path — so those
// directories are part of the surface. The repository-root variants are listed
// too: they are the same defaults if the base directory ever becomes the root.
const FUNCTION_DIRECTORIES = [
  'netlify/functions',
  'netlify/edge-functions',
  'site/netlify/functions',
  'site/netlify/edge-functions',
];

const DIRECTORY_PREFIXES = [
  'scripts/',
  '.github/workflows/',
  CONSOLE_ARTIFACT_DIRECTORY,
  ...FUNCTION_DIRECTORIES.map(directory => `${directory}/`),
];

const EXACT_PATHS = new Set([
  'netlify.toml',
  'site/netlify.toml',
  ...PUBLISHED_CODE,
  ...DEPENDENCY_FILES,
  ...SITE_DEPENDENCY_FILES,
]);

export const privilegedBuildSurface = path =>
  EXACT_PATHS.has(path) || DIRECTORY_PREFIXES.some(prefix => path.startsWith(prefix));

// One sample per directory prefix, plus every exact path. The predicate test and
// the CODEOWNERS coverage test both iterate this list, so a path added to any
// canonical set is automatically pinned, and CODEOWNERS has to cover it too.
const PREFIX_SAMPLES = DIRECTORY_PREFIXES.map(prefix => `${prefix}hello.mjs`);

export const PRIVILEGED_EXAMPLES = [...PREFIX_SAMPLES, ...EXACT_PATHS];

export const UNCHANGED = 'Build surface unchanged.';

export const changedSurface = files => files.filter(privilegedBuildSurface);

const invokedDirectly = () => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) === import.meta.filename : false;
  } catch {
    return false;
  }
};

// Reads a newline-separated path list on stdin — GitHub's pull request file list,
// which is computed against the merge base and reports both sides of a rename —
// and prints the privileged subset, or UNCHANGED. This is the only mode: the gate
// must have exactly one definition of "changed".
if (invokedDirectly()) {
  if (!process.argv.includes('--stdin')) {
    console.error('usage: node scripts/build-surface.mjs --stdin < changed-paths.txt');
    process.exitCode = 2;
  } else {
    const files = readFileSync(0, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const changed = changedSurface(files);
    console.log(changed.length === 0 ? UNCHANGED : changed.join('\n'));
  }
}
