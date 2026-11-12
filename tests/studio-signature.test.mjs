import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MANIFEST_SIGNATURE_PATH, signManifest, signatureConfigured, verifyManifestSignature } from '../scripts/studio-signature.mjs';

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
};

test('a manifest signature verifies only against the same bytes and key', () => {
  const { privateKey, publicKey } = keyPair();
  const manifest = Buffer.from('{"repository":"https://github.com/mem9-ai/tidb.ai","files":{"index.html":"abc"}}');
  const signature = signManifest(manifest, privateKey);

  assert.doesNotThrow(() => verifyManifestSignature(manifest, signature, publicKey));
  // Any change to the manifest invalidates it, including whitespace.
  assert.throws(() => verifyManifestSignature(Buffer.from(`${manifest} `), signature, publicKey), /does not match/);
  // A different publisher key does not verify the same signature.
  assert.throws(() => verifyManifestSignature(manifest, signature, keyPair().publicKey), /does not match/);
  // An empty signature is a distinct, clearer failure.
  assert.throws(() => verifyManifestSignature(manifest, '  ', publicKey), /signature is missing/);
  // Signing without a key is a programmer error, not a silent no-op.
  assert.throws(() => signManifest(manifest, undefined), /signing key is required/);
});

test('the pinned key is the switch: empty means "not configured yet"', () => {
  assert.equal(signatureConfigured(''), false);
  assert.equal(signatureConfigured('   '), false);
  assert.equal(signatureConfigured('-----BEGIN PUBLIC KEY-----'), true);
  // The shipped pin is empty until the publisher pipeline signs (#147).
  assert.equal(MANIFEST_SIGNATURE_PATH, 'vendor/studio-build.json.sig');
});

test('the publisher CLI signs a manifest file and refuses to run without a key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-sign-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../scripts/sign-studio-manifest.mjs', import.meta.url));
  const manifest = join(directory, 'studio-build.json');
  const out = join(directory, 'studio-build.json.sig');
  await writeFile(manifest, '{"files":{}}');
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });

  const signed = spawnSync(process.execPath, [cli, '--manifest', manifest, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, STUDIO_ARTIFACT_SIGNING_KEY: privateKeyPem },
  });
  assert.equal(signed.status, 0, signed.stderr);
  assert.doesNotThrow(() => verifyManifestSignature(readFileSync(manifest), readFileSync(out, 'utf8'), publicKey));

  // A key with escaped newlines (as secrets are often stored) still parses.
  const escaped = spawnSync(process.execPath, [cli, '--manifest', manifest, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, STUDIO_ARTIFACT_SIGNING_KEY: privateKeyPem.replace(/\n/g, '\\n') },
  });
  assert.equal(escaped.status, 0, escaped.stderr);
  assert.doesNotThrow(() => verifyManifestSignature(readFileSync(manifest), readFileSync(out, 'utf8'), publicKey));

  const missing = spawnSync(process.execPath, [cli, '--manifest', manifest, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, STUDIO_ARTIFACT_SIGNING_KEY: '' },
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No signing key/);

  const usage = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage/);
});
