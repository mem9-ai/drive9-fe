import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareStudio, studioRedirects } from './prepare-studio.mjs';

test('API and schema proxy rules precede the scoped SPA fallback', () => {
  const rules = studioRedirects('https://api.example.invalid').trim().split('\n');
  assert.deepEqual(rules, [
    '/studio/api/* https://api.example.invalid/api/:splat 200!',
    '/studio/openapi.json https://api.example.invalid/openapi.json 200!',
    '/studio/owner-openapi.json https://api.example.invalid/owner-openapi.json 200!',
    '/studio/discover/* /404.html 404',
    '/studio/* /studio/index.html 200',
  ]);
  // Existing site pages and real Studio assets must win over the SPA fallback.
  assert.ok(!rules.some(rule => rule.startsWith('/* ')));
  assert.ok(!rules.at(-1).endsWith('!'));
});

test('no redirect points to the same path after Netlify trailing-slash normalization', () => {
  const origin = 'https://api.example.invalid';
  const normalize = value => {
    const url = new URL(value, origin);
    return url.origin + (url.pathname.replace(/\/+$/, '') || '/') + url.search;
  };
  for (const rule of studioRedirects(origin).trim().split('\n')) {
    const [from, to, status] = rule.split(/\s+/);
    if (Number.parseInt(status, 10) >= 300 && Number.parseInt(status, 10) < 400) {
      assert.notEqual(normalize(from), normalize(to), `Self redirect: ${rule}`);
    }
  }
});

test('reject unsafe or ambiguous deployment origins without echoing the value', () => {
  for (const value of [undefined, '', 'http://api.example.invalid', 'https://localhost',
    'https://127.0.0.1', 'https://[::1]', 'https://backend.internal',
    'https://user:fixture-secret@api.example.invalid', 'https://api.example.invalid/path',
    'https://api.example.invalid/', 'https://api.example.invalid?token=fixture-secret',
    'https://api.example.invalid#x', 'https://api.example.invalid\n/* /other 200']) {
    assert.throws(() => studioRedirects(value), error => {
      assert.match(error.message, /STUDIO_API_ORIGIN must/);
      assert.ok(!error.message.includes('fixture-secret'));
      return true;
    });
  }
  assert.match(studioRedirects('https://api.example.invalid:8443'), /:8443\/api\/:splat/);
});

async function fixture(t, html = '<script src="/studio/assets/app.js"></script>') {
  const root = await mkdtemp(join(tmpdir(), 'drive9-studio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const consoleDirectory = join(root, 'console');
  const siteDirectory = join(root, 'site');
  await mkdir(join(consoleDirectory, 'assets'), { recursive: true });
  await mkdir(join(siteDirectory, 'studio'), { recursive: true });
  await writeFile(join(consoleDirectory, 'index.html'), html);
  await writeFile(join(consoleDirectory, 'assets/app.js'), '/* fixture asset */');
  await mkdir(join(consoleDirectory, 'skills/drive9-workspace'), { recursive: true });
  await writeFile(join(consoleDirectory, 'skills/drive9-workspace/SKILL.md'), '# Workspace skill\n');
  await writeFile(join(consoleDirectory, 'config.json'), '{"apiOrigin":"http://127.0.0.1:4318"}');
  await writeFile(join(siteDirectory, 'index.html'), 'existing homepage');
  await writeFile(join(siteDirectory, 'skill.md'), 'existing skill');
  await writeFile(join(siteDirectory, 'studio/old.js'), 'stale asset');
  return { consoleDirectory, siteDirectory, apiOrigin: 'https://api.example.invalid' };
}

test('prepares subpath assets and same-origin config while preserving the homepage', async t => {
  const options = await fixture(t);
  await prepareStudio(options);
  const read = path => readFile(join(options.siteDirectory, path), 'utf8');
  assert.equal(await read('index.html'), 'existing homepage');
  assert.equal(await read('skill.md'), 'existing skill');
  assert.equal(await read('studio/assets/app.js'), '/* fixture asset */');
  assert.equal(await read('studio/skills/drive9-workspace/SKILL.md'), '# Workspace skill\n');
  assert.deepEqual(JSON.parse(await read('studio/config.json')), { apiOrigin: '', apiPathPrefix: '/studio' });
  assert.match(await read('_redirects'), /^\/studio\/api\/\*/);
  await assert.rejects(read('studio/old.js'), { code: 'ENOENT' });
  await prepareStudio(options);
  assert.equal(await read('index.html'), 'existing homepage');
});

test('bad origin, missing output, and root-base build fail before changing the site', async t => {
  const options = await fixture(t, '<script src="/assets/app.js"></script>');
  await assert.rejects(prepareStudio({ ...options, apiOrigin: undefined }), /STUDIO_API_ORIGIN/);
  await assert.rejects(prepareStudio(options), /--base=\/studio\//);
  await assert.rejects(prepareStudio({ ...options, consoleDirectory: join(options.consoleDirectory, 'missing') }), { code: 'ENOENT' });
  assert.equal(await readFile(join(options.siteDirectory, 'studio/old.js'), 'utf8'), 'stale asset');
  await assert.rejects(readFile(join(options.siteDirectory, '_redirects')), { code: 'ENOENT' });
});


test('approved public discovery pages get production canonicals and preview noindex',async t=>{
  const options=await fixture(t);await mkdir(join(options.consoleDirectory,'discover'),{recursive:true});
  await writeFile(join(options.consoleDirectory,'discover/index.html'),'<!doctype html><html><head><meta name="robots" content="noindex"></head><body><h1>Useful public content</h1></body></html>');
  await writeFile(join(options.siteDirectory,'sitemap.xml'),'<?xml version="1.0"?><urlset><url><loc>https://drive9.ai/</loc></url></urlset>');
  await prepareStudio({...options,context:'production'});
  let html=await readFile(join(options.siteDirectory,'studio/discover/index.html'),'utf8');assert.match(html,/index,follow/);assert.match(html,/rel="canonical" href="https:\/\/drive9.ai\/studio\/discover\//);
  assert.match(await readFile(join(options.siteDirectory,'sitemap.xml'),'utf8'),/studio\/discover\//);
  await prepareStudio({...options,context:'deploy-preview'});html=await readFile(join(options.siteDirectory,'studio/discover/index.html'),'utf8');assert.match(html,/noindex,follow/);assert.ok(!html.includes('rel="canonical"'));
});
