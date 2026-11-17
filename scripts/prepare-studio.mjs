import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyStudioArtifact } from './studio-artifact.mjs';
import { CONSOLE_ARTIFACT_DIRECTORY, CONSOLE_MANIFEST, CONSOLE_SIGNATURE } from './build-surface.mjs';
import { PINNED_PUBLIC_KEY, signatureConfigured, verifyManifestSignature } from './studio-signature.mjs';
import { prepareDiscovery } from './prepare-discovery.mjs';

export function studioRedirects(apiOrigin) {
  const invalid = () => new Error('STUDIO_API_ORIGIN must be a public HTTPS origin without a path, credentials, or query.');
  let url;
  try {
    url = new URL(apiOrigin);
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'https:' || url.origin !== apiOrigin || url.username || url.password ||
      isIP(url.hostname) || !url.hostname.includes('.') || url.hostname.startsWith('[') ||
      /\.(localhost|local|internal)$/.test(url.hostname)) throw invalid();
  return [
    `/studio/api/* ${url.origin}/api/:splat 200!`,
    `/studio/openapi.json ${url.origin}/openapi.json 200!`,
    `/studio/owner-openapi.json ${url.origin}/owner-openapi.json 200!`,
    // Netlify matches paths with or without a trailing slash. A slash-only
    // redirect would therefore also redirect /studio/ back to itself.
    '/studio/discover/* /404.html 404',
    '/studio/* /studio/index.html 200',
    '',
  ].join('\n');
}

export async function prepareStudio({ consoleDirectory, siteDirectory, apiOrigin, context = 'deploy-preview' }) {
  // Validate before changing output; never echo deployment configuration on failure.
  const redirects = studioRedirects(apiOrigin);
  const html = await readFile(resolve(consoleDirectory, 'index.html'), 'utf8');
  if (!html.includes('/studio/assets/')) {
    throw new Error('Build the Console with --base=/studio/ before preparing the site.');
  }
  const destination = resolve(siteDirectory, 'studio');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(consoleDirectory, destination, { recursive: true });
  // The gateway strips the public prefix; the API keeps its existing routes.
  await writeFile(resolve(destination, 'config.json'), '{"apiOrigin":"","apiPathPrefix":"/studio"}\n');
  await writeFile(resolve(siteDirectory, '_redirects'), redirects);
  await prepareDiscovery(destination, siteDirectory, context);
}

// The deploy build is the last place the artifact can be checked before it is
// served, so it verifies the publisher signature as well as the checksums: an
// artifact that reached this revision without a signature, or with one that does
// not verify against the pinned key, stops the deploy instead of shipping to
// authenticated users. Exported so the deploy path is covered by a test.
export async function verifyPublishedArtifact(root, publicKey = PINNED_PUBLIC_KEY) {
  const manifest = resolve(root, CONSOLE_MANIFEST);
  await verifyStudioArtifact(resolve(root, CONSOLE_ARTIFACT_DIRECTORY), manifest);
  if (!signatureConfigured(publicKey)) return;
  // Read the signature separately so its absence is reported as a missing
  // signature rather than by the caller's generic ENOENT branch, and so a real
  // filesystem error (EACCES, EISDIR) still surfaces as itself.
  let signature;
  try {
    signature = await readFile(resolve(root, CONSOLE_SIGNATURE), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error(`${CONSOLE_SIGNATURE} is missing: a pinned signing key requires every publication to be signed.`);
  }
  verifyManifestSignature(await readFile(manifest), signature, publicKey);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    await verifyPublishedArtifact(root);
    await prepareStudio({
      consoleDirectory: resolve(root, CONSOLE_ARTIFACT_DIRECTORY),
      siteDirectory: resolve(root, 'site'),
      apiOrigin: process.env.STUDIO_API_ORIGIN,
      context:process.env.CONTEXT || 'deploy-preview',
    });
    console.log('Studio static assets and routing prepared.');
  } catch (error) {
    console.error(error.code === 'ENOENT' ? 'Console build output is missing.' : error.message);
    process.exitCode = 1;
  }
}
