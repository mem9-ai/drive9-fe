import assert from 'node:assert/strict';
import { sign, verify } from 'node:crypto';

// Publisher provenance for the Console artifact (#147).
//
// `verifyStudioArtifact` proves the bundle is self-consistent: the checksums match
// the manifest that ships with it. Against a compromised publisher that is
// circular, because the manifest is candidate-supplied. This module adds the
// missing half — a detached Ed25519 signature over the exact manifest bytes,
// produced by the publish pipeline and checked against a key pinned here.
//
// The pin below is the Ed25519 public key of the publisher pipeline; the private
// half lives in mem9-ai/tidb-agentspace as STUDIO_ARTIFACT_SIGNING_KEY. Rotation
// is two steps and has no dependency on a release: replace that secret with a new
// private key, paste its public half here, and the next publication is signed and
// verified with the new key. While no key is pinned the gate behaves as it did
// before #147 existed, so a broken signing step degrades provenance instead of
// stopping publication.

export const MANIFEST_SIGNATURE_PATH = 'vendor/studio-build.json.sig';

export const PINNED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEADa5R3rw/YMYfBtLrA6HvmQFmxK6CerX+zdk+nh/OrNs=
-----END PUBLIC KEY-----
`;

export const signatureConfigured = (publicKey = PINNED_PUBLIC_KEY) => publicKey.trim() !== '';

// Deterministic bytes: the signature covers the manifest exactly as it is stored,
// so any change to the artifact metadata invalidates it.
export function signManifest(manifestBytes, privateKey) {
  assert.ok(privateKey, 'A signing key is required.');
  return sign(null, manifestBytes, privateKey).toString('base64');
}

export function verifyManifestSignature(manifestBytes, signatureText, publicKey = PINNED_PUBLIC_KEY) {
  assert.ok(signatureConfigured(publicKey), 'No pinned Console signing key is configured.');
  const signature = Buffer.from(String(signatureText ?? '').trim(), 'base64');
  if (signature.length === 0) {
    throw new Error('Console artifact signature is missing.');
  }
  if (!verify(null, manifestBytes, publicKey, signature)) {
    throw new Error('Console artifact signature does not match the pinned publisher key.');
  }
}
