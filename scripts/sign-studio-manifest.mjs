import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { MANIFEST_SIGNATURE_PATH, signManifest } from './studio-signature.mjs';

// Publisher side of #147: sign the manifest that is about to be published. Run by
// the Console publish pipeline with the private key from its secrets; the trusted
// gate then verifies the signature against the pinned public key.
//
//   STUDIO_ARTIFACT_SIGNING_KEY="$(cat key.pem)" node scripts/sign-studio-manifest.mjs \
//     --manifest ../vendor/studio-build.json --out ../vendor/studio-build.json.sig

const option = (args, name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const invokedDirectly = () => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) === import.meta.filename : false;
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  const args = process.argv.slice(2);
  const manifestPath = option(args, '--manifest');
  const outPath = option(args, '--out') ?? MANIFEST_SIGNATURE_PATH;
  const keyFile = option(args, '--key-file');
  if (!manifestPath) {
    console.error('usage: sign-studio-manifest.mjs --manifest P [--out P] [--key-file P]');
    console.error('       (the private key can also come from STUDIO_ARTIFACT_SIGNING_KEY)');
    process.exitCode = 2;
  } else {
    try {
      // Secrets often arrive with escaped newlines; PEM parsers need real ones.
      const key = (keyFile ? readFileSync(keyFile, 'utf8') : (process.env.STUDIO_ARTIFACT_SIGNING_KEY ?? ''))
        .replace(/\\n/g, '\n');
      if (!key.trim()) throw new Error('No signing key: pass --key-file or set STUDIO_ARTIFACT_SIGNING_KEY.');
      writeFileSync(outPath, `${signManifest(readFileSync(manifestPath), key)}\n`);
      console.log(`Signed ${manifestPath} -> ${outPath}`);
    } catch (error) {
      console.error(`Could not sign the Console manifest: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
