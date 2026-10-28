import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    '/studio /studio/ 301!',
    '/studio/* /studio/index.html 200',
    '',
  ].join('\n');
}

export async function prepareStudio({ consoleDirectory, siteDirectory, apiOrigin }) {
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    await prepareStudio({
      consoleDirectory: resolve(root, 'studio/dist/console'),
      siteDirectory: resolve(root, 'site'),
      apiOrigin: process.env.STUDIO_API_ORIGIN,
    });
    console.log('Studio static assets and routing prepared.');
  } catch (error) {
    console.error(error.code === 'ENOENT' ? 'Console build output is missing.' : error.message);
    process.exitCode = 1;
  }
}
