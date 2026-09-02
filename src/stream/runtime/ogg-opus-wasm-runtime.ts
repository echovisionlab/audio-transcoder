import { createAbortableSharedInitialization } from '../abortable-initialization.js';

export interface OggOpusWasmExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly _initialize?: () => void;
  readonly wasm_ogg_opus_create: (
    channels: number,
    bitrateBps: number,
  ) => number;
  readonly wasm_ogg_opus_destroy: (handle: number) => void;
  readonly wasm_ogg_opus_drain: (handle: number) => number;
  readonly wasm_ogg_opus_eos_seen: (handle: number) => number;
  readonly wasm_ogg_opus_last_create_error: () => number;
  readonly wasm_ogg_opus_max_page_bytes: () => number;
  readonly wasm_ogg_opus_page: (handle: number) => number;
  readonly wasm_ogg_opus_page_length: (handle: number) => number;
  readonly wasm_ogg_opus_pcm: (handle: number) => number;
  readonly wasm_ogg_opus_pcm_capacity_frames: () => number;
  readonly wasm_ogg_opus_pull_page: (handle: number) => number;
  readonly wasm_ogg_opus_write: (handle: number, frames: number) => number;
}

export type OggOpusWasmLoader = (
  signal?: AbortSignal,
) => Promise<Uint8Array<ArrayBuffer>>;

export type OggOpusWasmInstantiator = (
  signal?: AbortSignal,
) => Promise<OggOpusWasmExports>;

/**
 * Creates a loader-local immutable module cache while giving each session its
 * own WebAssembly instance and linear memory.
 */
export function createOggOpusWasmInstantiator(
  loadWasm: OggOpusWasmLoader,
): OggOpusWasmInstantiator {
  const compiledModule = createAbortableSharedInitialization(
    async (signal) => WebAssembly.compile(await loadWasm(signal)),
  );

  return async (signal) => {
    const module = await compiledModule.get(signal);
    const instance = await WebAssembly.instantiate(module, createImports());
    const exports = instance.exports as unknown as OggOpusWasmExports;
    assertExports(exports);
    exports._initialize?.();
    return exports;
  };
}

function createImports(): WebAssembly.Imports {
  const unsupportedWasiCall = (): never => {
    throw new Error('The Ogg Opus WASM module attempted unsupported WASI I/O.');
  };
  return {
    env: {
      emscripten_notify_memory_growth: () => undefined,
    },
    wasi_snapshot_preview1: {
      fd_close: unsupportedWasiCall,
      fd_seek: unsupportedWasiCall,
      fd_write: unsupportedWasiCall,
    },
  };
}

function assertExports(
  exports: Partial<OggOpusWasmExports>,
): asserts exports is OggOpusWasmExports {
  const functions = [
    'wasm_ogg_opus_create',
    'wasm_ogg_opus_destroy',
    'wasm_ogg_opus_drain',
    'wasm_ogg_opus_eos_seen',
    'wasm_ogg_opus_last_create_error',
    'wasm_ogg_opus_max_page_bytes',
    'wasm_ogg_opus_page',
    'wasm_ogg_opus_page_length',
    'wasm_ogg_opus_pcm',
    'wasm_ogg_opus_pcm_capacity_frames',
    'wasm_ogg_opus_pull_page',
    'wasm_ogg_opus_write',
  ] as const;
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error('The Ogg Opus WASM module does not export memory.');
  }
  for (const name of functions) {
    if (typeof exports[name] !== 'function') {
      throw new Error(`The Ogg Opus WASM module does not export ${name}.`);
    }
  }
}
