import { copyFile, mkdir, rm } from 'node:fs/promises';

const assets = [
  ['../src/stream/runtime/aac.generated.mjs', '../dist/stream/runtime/aac.generated.mjs'],
  ['../src/stream/runtime/aac.generated.d.mts', '../dist/stream/runtime/aac.generated.d.mts'],
];

for (const [source, destination] of assets) {
  const destinationUrl = new URL(destination, import.meta.url);
  await mkdir(new URL('./', destinationUrl), { recursive: true });
  await copyFile(new URL(source, import.meta.url), destinationUrl);
}

// Raw WASM is distributed by the version-matched codec asset package. These
// legacy generated modules remain source fixtures for deterministic extraction
// tests, but must never be duplicated in the engine npm package.
const generatedWasmModules = [
  '../dist/stream/runtime/ogg-opus-wasm-binary.js',
  '../dist/stream/resampler-wasm-best-binary.js',
  '../dist/stream/resampler-wasm-balanced-binary.js',
  '../dist/stream/resampler-wasm-fast-binary.js',
];

for (const modulePath of generatedWasmModules) {
  for (const suffix of ['', '.map']) {
    await rm(new URL(`${modulePath}${suffix}`, import.meta.url), {
      force: true,
    });
  }
  const declarationPath = modulePath.replace(/\.js$/u, '.d.ts');
  for (const suffix of ['', '.map']) {
    await rm(new URL(`${declarationPath}${suffix}`, import.meta.url), {
      force: true,
    });
  }
}
