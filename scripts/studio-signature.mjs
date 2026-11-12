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
// The pin is empty until the pipeline signs (see #147). While it is empty the
// gate behaves exactly as before, so landing this module cannot break a release.
// Provisioning is two steps: store the private key as STUDIO_ARTIFACT_SIGNING_KEY
// in the publishing repository's secrets, and paste the matching public key here.

export const MANIFEST_SIGNATURE_PATH = 'vendor/studio-build.json.sig';

export const PINNED_PUBLIC_KEY = '';

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
