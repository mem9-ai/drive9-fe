// Files that decide what the privileged Netlify deploy build executes, or that
// make it install and run third-party code. Netlify runs the build command from
// the merged revision, reads configuration from the repository root or the base
// directory, and installs dependencies when it finds a manifest — so a change to
// any of these changes code execution in the deploy environment. This module is
// the single source for the gate in `.github/workflows/studio-publication.yml`.
//
// `.github/CODEOWNERS` is coarse on purpose: it decides who reviews, while this
// list decides what the gate calls a build-surface change. `EXACT_PATHS` and
// `PREFIX_SAMPLES` are derived from the sets themselves, so the tests cannot drift
// from the surface.
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
// Every consumer derives from these constants — the privileged surface below, the
// trusted validator's extraction scope, and the tests' corpus of positives and
// lookalike negatives — so widening the artifact widens all of them in one edit.
// The quiet failure mode this prevents: a path the validator's artifact-only rule
// admits but the surface does not gate would read "Build surface unchanged.", so a
// reviewer would never see the report name a path the validator still walks.
export const CONSOLE_ARTIFACT_DIRECTORY = 'vendor/studio/';
export const CONSOLE_MANIFEST = 'vendor/studio-build.json';
// Detached signature over the manifest bytes (#147); part of the artifact so a
// publisher pull request can carry it.
export const CONSOLE_SIGNATURE = 'vendor/studio-build.json.sig';

// The Netlify publish directory. One prefix, so a file added anywhere under it is
// gated without editing this module: Netlify serves the whole directory verbatim
// on the origin that holds the Console cookies, so `site/*.html` (inline script),
// `site/skill.md` (instructions an agent follows), `site/manifest/**` (the CLI's
// endpoint and region trust anchors), `site/_headers` (which origins may read the
// credentialed responses) and the checked-in `site/releases/**` binaries are all
// part of what visitors and agents run or read. A test walks the directory, so a
// file added later cannot slip through.
const PUBLISH_ROOT = 'site/';

// One predicate for the privileged surface and for the validator's artifact-only
// rule, so the report and the rule cannot disagree about which paths they cover.
export const isConsoleArtifactPath = path =>
  path.startsWith(CONSOLE_ARTIFACT_DIRECTORY) || path === CONSOLE_MANIFEST || path === CONSOLE_SIGNATURE;

// Netlify deploys functions from the base directory without any configuration:
// the defaults are `netlify/functions` and `netlify/edge-functions` resolved
// against the base directory. The base directory here is `site`, which
// PUBLISH_ROOT already covers, so only the repository-root variants are listed:
// they are the same defaults if the base directory ever becomes the root.
const FUNCTION_DIRECTORIES = [
  'netlify/functions',
  'netlify/edge-functions',
];

const DIRECTORY_PREFIXES = [
  'scripts/',
  '.github/workflows/',
  CONSOLE_ARTIFACT_DIRECTORY,
  PUBLISH_ROOT,
  ...FUNCTION_DIRECTORIES.map(directory => `${directory}/`),
];

const EXACT_PATHS = new Set([
  'netlify.toml',
  // The Console bundle and its provenance files live outside the publish
  // directory, so they are listed here rather than covered by PUBLISH_ROOT.
  CONSOLE_MANIFEST,
  CONSOLE_SIGNATURE,
  ...DEPENDENCY_FILES,
]);

export const privilegedBuildSurface = path =>
  EXACT_PATHS.has(path) || DIRECTORY_PREFIXES.some(prefix => path.startsWith(prefix));

// One sample per directory prefix plus every exact path. The predicate test
// iterates this list, so a path added to any canonical set is pinned, and the
// published-tree test walks `site/` for anything the prefix might miss.
const PREFIX_SAMPLES = DIRECTORY_PREFIXES.map(prefix => `${prefix}hello.mjs`);

export const PRIVILEGED_EXAMPLES = [...PREFIX_SAMPLES, ...EXACT_PATHS];

export const UNCHANGED = 'Build surface unchanged.';

// The gate consumes these as a module (scripts/publication-check.mjs); there is
// deliberately no second CLI entry point that could evaluate "changed" on its own.
export const changedSurface = files => files.filter(privilegedBuildSurface);
