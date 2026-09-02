import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';

const scriptDirectory = new URL('./', import.meta.url);
const repositoryRoot = new URL('../../', scriptDirectory);
const manifest = JSON.parse(
  await readFile(new URL('manifest.json', scriptDirectory), 'utf8'),
);

await verifyFile(
  manifest.artifact.path,
  manifest.artifact.sha256,
  manifest.artifact.sizeBytes,
);
await verifyFile(
  manifest.wasmArtifact.path,
  manifest.wasmArtifact.sha256,
  manifest.wasmArtifact.sizeBytes,
);
await verifyFile(manifest.bridge.path, manifest.bridge.sha256);
await readFile(new URL(manifest.bridge.licensePath, repositoryRoot));
await readFile(new URL(manifest.ffmpeg.licensePath, repositoryRoot));

const distArtifactPath = manifest.artifact.path.replace(/^src\//, 'dist/');
const distArtifactUrl = new URL(distArtifactPath, repositoryRoot);
const requireDist = process.argv.includes('--require-dist');
if (requireDist || (await exists(distArtifactUrl))) {
  await verifyFile(
    distArtifactPath,
    manifest.artifact.sha256,
    manifest.artifact.sizeBytes,
  );
}

console.log(
  `Verified bundled AAC glue ${manifest.artifact.sha256}, raw WASM ${manifest.wasmArtifact.sha256}, and license/source inputs.`,
);

async function verifyFile(path, expectedSha256, expectedSize) {
  const url = new URL(path, repositoryRoot);
  const bytes = await readFile(url);
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `${path} SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}.`,
    );
  }
  if (expectedSize !== undefined) {
    const { size } = await stat(url);
    if (size !== expectedSize) {
      throw new Error(
        `${path} size mismatch: expected ${expectedSize}, received ${size}.`,
      );
    }
  }
}

async function exists(url) {
  try {
    await access(url);
    return true;
  } catch {
    return false;
  }
}
