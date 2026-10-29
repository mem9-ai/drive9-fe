import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRepository = 'https://github.com/mem9-ai/tidb.ai';
const studioConfig = '{"apiOrigin":"","apiPathPrefix":"/studio"}\n';

export async function studioHashes(directory, prefix = '') {
  const hashes = {};
  const entries = (await readdir(resolve(directory, prefix), { withFileTypes: true }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const path = prefix + entry.name;
    if (entry.isDirectory() && path === 'assets') {
      Object.assign(hashes, await studioHashes(directory, 'assets/'));
    } else if (entry.isFile() && /^(index\.html|config\.json|favicon\.svg|assets\/[\w.-]+\.(js|css|woff2))$/.test(path)) {
      hashes[path] = createHash('sha256').update(await readFile(resolve(directory, path))).digest('hex');
    } else {
      throw new Error('Studio output contains an unexpected file, directory, or symlink.');
    }
  }
  return hashes;
}

export async function verifyStudioArtifact(directory, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest || manifest.repository !== sourceRepository || !/^[a-f0-9]{40}$/.test(manifest.commit || '') ||
      !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('Studio artifact source metadata is invalid.');
  }
  if (manifest.node !== '24.22.1' || manifest.npm !== '11.6.2' ||
      manifest.build !== 'npm ci && npm run build:console -- --base=/studio/') {
    throw new Error('Studio artifact toolchain/build provenance is invalid.');
  }
  const actual = await studioHashes(directory);
  if (!actual['index.html'] || !actual['config.json'] ||
      Object.keys(actual).length !== Object.keys(manifest.files).length ||
      Object.entries(actual).some(([path, hash]) => manifest.files[path] !== hash)) {
    throw new Error('Studio artifact checksums do not match.');
  }
  for (const path of Object.keys(actual)) {
    if (path.endsWith('.woff2')) continue;
    const contents = await readFile(resolve(directory, path), 'utf8');
    if (/(?:-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|sourceMappingURL\s*=)/.test(contents)) {
      throw new Error('Studio artifact contains a credential marker or source map reference.');
    }
  }
  if ((await readFile(resolve(directory, 'config.json'), 'utf8')) !== studioConfig) {
    throw new Error('Studio artifact must use the same-origin /studio configuration.');
  }
}

// Maintenance command: import only the Console output built from the documented,
// clean source export. Netlify never runs this or accesses the source repository.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [source, commit] = process.argv.slice(2);
    if (!source || !/^[a-f0-9]{40}$/.test(commit || '')) {
      throw new Error('Usage: node scripts/studio-artifact.mjs <console-output> <full-source-commit>');
    }
    const files = await studioHashes(source);
    if (!files['index.html'] || !files['config.json']) throw new Error('Console output is incomplete.');
    if (!(await readFile(resolve(source, 'index.html'), 'utf8')).includes('/studio/assets/')) {
      throw new Error('Build the Console with --base=/studio/ before importing it.');
    }
    const root = fileURLToPath(new URL('../', import.meta.url));
    const destination = resolve(root, 'vendor/studio');
    if (resolve(source) === destination) throw new Error('Import from the clean Console build, not the vendored directory.');
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await cp(source, destination, { recursive: true });
    await writeFile(resolve(destination, 'config.json'), studioConfig);
    await writeFile(resolve(root, 'vendor/studio-build.json'), JSON.stringify({
      repository: sourceRepository,
      commit,
      node: '24.22.1',
      npm: '11.6.2',
      build: 'npm ci && npm run build:console -- --base=/studio/',
      files: await studioHashes(destination),
    }, null, 2) + '\n');
    console.log('Studio artifact and source manifest updated.');
  } catch (error) {
    console.error(error.code === 'ENOENT' ? 'Console output is missing.' : error.message);
    process.exitCode = 1;
  }
}
