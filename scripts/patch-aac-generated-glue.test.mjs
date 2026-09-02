import assert from 'node:assert/strict';
import test from 'node:test';

import { removeStaticAacWasmFallback } from '../codec-build/aac/patch-generated-glue.mjs';

const generatedFallback =
  'function findWasmBinary(){if(Module["locateFile"]){return locateFile("aac.generated.wasm")}return new URL("aac.generated.wasm",import.meta.url).href}';

test('AAC generated glue fails closed instead of exposing a static WASM URL', () => {
  const patched = removeStaticAacWasmFallback(`before${generatedFallback}after`);

  assert.doesNotMatch(patched, /aac\.generated\.wasm/u);
  assert.doesNotMatch(patched, /new URL\(/u);
  assert.match(patched, /runtime asset loader through instantiateWasm/u);
});

test('AAC glue patch rejects unexpected generator output', () => {
  assert.throws(
    () => removeStaticAacWasmFallback('no generated fallback'),
    /exactly one Emscripten AAC WASM fallback, received 0/u,
  );
  assert.throws(
    () => removeStaticAacWasmFallback(`${generatedFallback}${generatedFallback}`),
    /exactly one Emscripten AAC WASM fallback, received 2/u,
  );
});
