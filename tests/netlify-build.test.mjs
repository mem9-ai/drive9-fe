import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../', import.meta.url));

async function checkout(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drive9-netlify-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['site', 'scripts', 'vendor']) {
    await cp(join(repository, directory), join(root, directory), {
      recursive: true,
      filter: source => !['site/studio', 'site/_redirects'].some(path => source === join(repository, path)),
    });
  }
  const config = await readFile(join(root, 'site/netlify.toml'), 'utf8');
  // These two settings are single-line TOML strings. Run the checked-in command
  // from the production base directory; baseRelDir=true resolves publish here too.
  const command = JSON.parse(config.match(/^\s*command = (".*")$/m)[1]);
  const publish = JSON.parse(config.match(/^\s*publish = (".*")$/m)[1]);
  const base = join(root, 'site');
  return { root, base, command, publish: resolve(base, publish) };
}

function build(options, origin) {
  return spawnSync('/bin/sh', ['-c', options.command], {
    cwd: options.base,
    env: { PATH: dirname(process.execPath), ...(origin ? { STUDIO_API_ORIGIN: origin } : {}) },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

// Outside scripts/*.test.mjs so executing the actual Netlify command cannot
// recursively launch this integration test.
test('Netlify base=site builds and publishes the homepage and Studio together', async t => {
  const options = await checkout(t);
  const result = build(options, 'https://api.example.invalid');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Studio static assets and routing prepared/);
  assert.equal(options.publish, options.base);
  for (const path of ['index.html', 'skill.md', 'studio/index.html', 'studio/assets', '_redirects']) {
    await stat(join(options.publish, path));
  }
  assert.equal(await readFile(join(options.publish, 'index.html'), 'utf8'),
    await readFile(join(repository, 'site/index.html'), 'utf8'));
  assert.deepEqual(JSON.parse(await readFile(join(options.publish, 'studio/config.json'), 'utf8')),
    { apiOrigin: '', apiPathPrefix: '/studio' });
  assert.match(await readFile(join(options.publish, '_redirects'), 'utf8'),
    /^\/studio\/api\/\* https:\/\/api\.example\.invalid\/api\/:splat 200!/);
  for (const path of ['site', 'scripts', 'vendor']) {
    await assert.rejects(stat(join(options.publish, path)), { code: 'ENOENT' });
  }
});

test('Netlify build from site fails without an API origin before preparing output', async t => {
  const options = await checkout(t);
  const result = build(options);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /STUDIO_API_ORIGIN must/);
  await assert.rejects(stat(join(options.base, 'studio')), { code: 'ENOENT' });
  await assert.rejects(stat(join(options.base, '_redirects')), { code: 'ENOENT' });
});
