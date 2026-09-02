import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '../..');
const manifest = JSON.parse(
  await readFile(resolve(SCRIPT_DIRECTORY, 'manifest.json'), 'utf8'),
);

await verifyManifestFile(manifest.artifact, true);
await verifyManifestFile(manifest.bridge, false);
await readFile(resolve(REPOSITORY_ROOT, manifest.bridge.licensePath));
await readFile(resolve(REPOSITORY_ROOT, manifest.libflac.licensePath));

const wasmBytes = await readFile(resolve(REPOSITORY_ROOT, manifest.artifact.path));
const module = await WebAssembly.compile(wasmBytes);
const actualImports = WebAssembly.Module.imports(module)
  .map(({ module: namespace, name }) => `${namespace}.${name}`)
  .sort();
const expectedImports = [
  'env.emscripten_notify_memory_growth',
  'wasi_snapshot_preview1.fd_close',
  'wasi_snapshot_preview1.fd_read',
  'wasi_snapshot_preview1.fd_seek',
  'wasi_snapshot_preview1.fd_write',
].sort();
assertEqual(actualImports, expectedImports, 'WASM imports');

const expectedApplicationExports = [
  'wasm_flac_abi_version',
  'wasm_flac_create',
  'wasm_flac_destroy',
  'wasm_flac_encode',
  'wasm_flac_finish',
  'wasm_flac_frame_count',
  'wasm_flac_frame_samples',
  'wasm_flac_frame_size',
  'wasm_flac_header',
  'wasm_flac_header_length',
  'wasm_flac_last_create_error',
  'wasm_flac_last_error',
  'wasm_flac_output',
  'wasm_flac_output_length',
  'wasm_flac_pcm',
  'wasm_flac_prepare_pcm',
  'wasm_flac_reset',
].sort();
const actualApplicationExports = WebAssembly.Module.exports(module)
  .map(({ name }) => name)
  .filter((name) => name.startsWith('flac_'))
  .sort();
assertEqual(
  actualApplicationExports,
  expectedApplicationExports,
  'application exports',
);

const unsupportedWasiCall = () => {
  throw new Error('FLAC verification encountered unexpected WASI I/O.');
};
const instance = await WebAssembly.instantiate(module, {
  env: { emscripten_notify_memory_growth: () => undefined },
  wasi_snapshot_preview1: {
    fd_close: unsupportedWasiCall,
    fd_read: unsupportedWasiCall,
    fd_seek: unsupportedWasiCall,
    fd_write: unsupportedWasiCall,
  },
});
const wasm = instance.exports;
wasm._initialize();
assert(
  wasm.wasm_flac_abi_version() === manifest.abiVersion,
  `Expected ABI ${manifest.abiVersion}.`,
);
assert(wasm.wasm_flac_create(0, 48_000, 24) === 0, 'Invalid channels were accepted.');
assert(wasm.wasm_flac_last_create_error() === -1, 'Invalid create error was not reported.');

const handle = wasm.wasm_flac_create(2, 48_000, 24);
assert(handle !== 0, `FLAC create failed (${wasm.wasm_flac_last_create_error()}).`);
try {
  const header = copyWasmBytes(
    wasm.memory,
    wasm.wasm_flac_header(handle),
    wasm.wasm_flac_header_length(handle),
  );
  assert(
    header[0] === 0x66 &&
      header[1] === 0x4c &&
      header[2] === 0x61 &&
      header[3] === 0x43,
    'FLAC stream marker is missing.',
  );

  const frames = 4_096;
  assert(wasm.wasm_flac_prepare_pcm(handle, frames) === 0, 'PCM prepare failed.');
  const pcmPointer = wasm.wasm_flac_pcm(handle);
  assert(pcmPointer !== 0, 'PCM pointer is null.');
  const pcm = new Int32Array(wasm.memory.buffer, pcmPointer, frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round(Math.sin((frame * Math.PI) / 32) * 0x3fffffff);
    pcm[frame * 2] = value;
    pcm[frame * 2 + 1] = value;
  }
  assert(wasm.wasm_flac_encode(handle, frames) === 0, 'PCM encode failed.');
  assert(wasm.wasm_flac_finish(handle) === 0, 'FLAC finish failed.');

  const frameCount = wasm.wasm_flac_frame_count(handle);
  const outputLength = wasm.wasm_flac_output_length(handle);
  assert(frameCount > 0, 'FLAC finish emitted no frames.');
  assert(outputLength > 0, 'FLAC finish emitted no bytes.');
  copyWasmBytes(wasm.memory, wasm.wasm_flac_output(handle), outputLength);
  let describedBytes = 0;
  let describedSamples = 0;
  for (let index = 0; index < frameCount; index += 1) {
    describedBytes += wasm.wasm_flac_frame_size(handle, index);
    describedSamples += wasm.wasm_flac_frame_samples(handle, index);
  }
  assert(describedBytes === outputLength, 'FLAC frame byte lengths do not match output.');
  assert(describedSamples === frames, 'FLAC frame sample counts do not match input.');
  assert(wasm.wasm_flac_reset(handle) === 0, 'FLAC reset failed.');
} finally {
  wasm.wasm_flac_destroy(handle);
}

console.log(
  `Verified FLAC WASM ABI ${manifest.abiVersion}: ${wasmBytes.byteLength} bytes (${manifest.artifact.sha256}).`,
);

async function verifyManifestFile(entry, verifySize) {
  const bytes = await readFile(resolve(REPOSITORY_ROOT, entry.path));
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert(digest === entry.sha256, `${entry.path} SHA-256 mismatch.`);
  if (verifySize) {
    assert(bytes.byteLength === entry.sizeBytes, `${entry.path} size mismatch.`);
  }
}

function copyWasmBytes(memory, pointer, length) {
  assert(pointer > 0 && length > 0, 'WASM byte range is empty.');
  assert(pointer <= memory.buffer.byteLength - length, 'WASM byte range is out of bounds.');
  return Uint8Array.from(new Uint8Array(memory.buffer, pointer, length));
}

function assertEqual(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} mismatch: ${JSON.stringify(actual)}.`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
