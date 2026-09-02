import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

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
await verifyFile(manifest.bridge.path, manifest.bridge.sha256);
await readFile(new URL(manifest.bridge.licensePath, repositoryRoot));
await readFile(new URL(manifest.lame.licensePath, repositoryRoot));

const artifact = await readFile(new URL(manifest.artifact.path, repositoryRoot));
const module = await WebAssembly.compile(artifact);
const imports = WebAssembly.Module.imports(module)
  .map(({ module: namespace, name }) => `${namespace}.${name}`)
  .sort();
const expectedImports = [
  'env.emscripten_notify_memory_growth',
  'wasi_snapshot_preview1.fd_close',
  'wasi_snapshot_preview1.fd_seek',
  'wasi_snapshot_preview1.fd_write',
  'wasi_snapshot_preview1.proc_exit',
].sort();
if (JSON.stringify(imports) !== JSON.stringify(expectedImports)) {
  throw new Error(`Unexpected MP3 WASM imports: ${imports.join(', ')}`);
}

const exportNames = new Set(
  WebAssembly.Module.exports(module).map(({ name }) => name),
);
for (const name of [
  'memory',
  'wasm_mp3_abi_version',
  'wasm_mp3_create',
  'wasm_mp3_last_create_error',
  'wasm_mp3_prepare_pcm',
  'wasm_mp3_encode',
  'wasm_mp3_flush',
  'wasm_mp3_output',
  'wasm_mp3_reset',
  'wasm_mp3_destroy',
]) {
  if (!exportNames.has(name)) {
    throw new Error(`MP3 WASM is missing required export ${name}.`);
  }
}

console.log(
  `Verified raw MP3 WASM ${manifest.artifact.sha256} and source/license inputs.`,
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
