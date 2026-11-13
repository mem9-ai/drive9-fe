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
// half lives in mem9-ai/tidb-agentspace as STUDIO_ARTIFACT_SIGNING_KEY. While a
// key is pinned, every publication must carry a signature that verifies against
// it: a missing, empty or mismatching signature stops the gate rather than
// shipping unverified bytes, which is why a broken signing step stops publication
// instead of degrading quietly.
//
// Rotation has no dependency on a release: replace that secret with a new private
// key and paste its public half here; anything signed with the old key then fails
// closed until the next publication is signed with the new one. Emptying this
// constant is the rollback, and it restores the pre-#147 behaviour where only the
// publisher app's identity was checked.

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
