#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const emscriptenStaticWasmFallback =
  'function findWasmBinary(){if(Module["locateFile"]){return locateFile("aac.generated.wasm")}return new URL("aac.generated.wasm",import.meta.url).href}';
const runtimeAssetOnlyFallback =
  'function findWasmBinary(){throw new Error("AAC WASM must be provided by the runtime asset loader through instantiateWasm")}';

export function removeStaticAacWasmFallback(source) {
  const matches = source.split(emscriptenStaticWasmFallback).length - 1;
  if (matches !== 1) {
    throw new Error(
      `Expected exactly one Emscripten AAC WASM fallback, received ${matches}.`,
    );
  }
  return source.replace(emscriptenStaticWasmFallback, runtimeAssetOnlyFallback);
}

async function main() {
  const [path] = process.argv.slice(2);
  if (path === undefined) {
    throw new Error('Usage: patch-generated-glue.mjs PATH');
  }
  const source = await readFile(path, 'utf8');
  await writeFile(path, removeStaticAacWasmFallback(source));
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}
