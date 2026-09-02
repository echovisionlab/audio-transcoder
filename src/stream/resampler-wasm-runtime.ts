import { createAbortableSharedInitialization } from './abortable-initialization.js';

interface ResamplerWasmExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly _initialize?: () => void;
  readonly wasm_resampler_create: (channels: number, ratio: number) => number;
  readonly wasm_resampler_destroy: (handle: number) => void;
  readonly wasm_resampler_input: (handle: number) => number;
  readonly wasm_resampler_input_frames_used: (handle: number) => number;
  readonly wasm_resampler_last_create_error: () => number;
  readonly wasm_resampler_output: (handle: number) => number;
  readonly wasm_resampler_output_frames_gen: (handle: number) => number;
  readonly wasm_resampler_prepare: (
    handle: number,
    inputFrames: number,
    outputFrames: number,
  ) => number;
  readonly wasm_resampler_process: (
    handle: number,
    inputFrames: number,
    outputFrames: number,
    endOfInput: number,
  ) => number;
}

export interface ResamplerWasmProcessResult {
  readonly inputFramesUsed: number;
  readonly outputFramesGenerated: number;
}

export interface ResamplerWasmSession {
  close(): void;
  process(
    input: Float32Array,
    output: Float32Array,
    endOfInput: boolean,
  ): ResamplerWasmProcessResult;
}

export type ResamplerWasmLoader = (
  signal?: AbortSignal,
) => Promise<Uint8Array<ArrayBuffer>>;

export type ResamplerWasmSessionFactory = (
  channels: number,
  ratio: number,
  signal?: AbortSignal,
) => Promise<ResamplerWasmSession>;

/** Creates a raw-WASM loader-local compiled-module cache. */
export function createResamplerWasmSessionFactory(
  loadWasm: ResamplerWasmLoader,
): ResamplerWasmSessionFactory {
  const compiledModule = createAbortableSharedInitialization(
    async (signal) => WebAssembly.compile(await loadWasm(signal)),
  );

  return async (channels, ratio, signal) => {
    const module = await compiledModule.get(signal);
    return instantiateSession(module, channels, ratio);
  };
}

async function instantiateSession(
  module: WebAssembly.Module,
  channels: number,
  ratio: number,
): Promise<ResamplerWasmSession> {
  const instance = await WebAssembly.instantiate(module, {
    env: { emscripten_notify_memory_growth: () => undefined },
  });
  let activeWasm = instance.exports as unknown as ResamplerWasmExports | null;
  assertExports(activeWasm);
  activeWasm._initialize?.();
  const handle = activeWasm.wasm_resampler_create(channels, ratio);
  if (handle === 0) {
    throw new Error(
      `libsamplerate could not create a session (error ${activeWasm.wasm_resampler_last_create_error()}).`,
    );
  }

  return {
    close(): void {
      if (activeWasm !== null) {
        activeWasm.wasm_resampler_destroy(handle);
        activeWasm = null;
      }
    },
    process(
      input: Float32Array,
      output: Float32Array,
      endOfInput: boolean,
    ): ResamplerWasmProcessResult {
      const wasm = activeWasm;
      if (wasm === null) {
        throw new Error('The libsamplerate WASM session is already closed.');
      }
      if (input.length % channels !== 0 || output.length % channels !== 0) {
        throw new Error(
          'libsamplerate WASM buffers must contain complete frames.',
        );
      }
      const inputFrames = input.length / channels;
      const outputFrames = output.length / channels;
      const prepareError = wasm.wasm_resampler_prepare(
        handle,
        inputFrames,
        outputFrames,
      );
      if (prepareError !== 0) {
        throw new Error(
          'libsamplerate could not allocate bounded PCM buffers.',
        );
      }

      if (input.length > 0) {
        const inputPointer = wasm.wasm_resampler_input(handle);
        new Float32Array(wasm.memory.buffer, inputPointer, input.length).set(
          input,
        );
      }
      const processError = wasm.wasm_resampler_process(
        handle,
        inputFrames,
        outputFrames,
        endOfInput ? 1 : 0,
      );
      if (processError !== 0) {
        throw new Error(
          `libsamplerate failed to process PCM (error ${processError}).`,
        );
      }

      const inputFramesUsed = wasm.wasm_resampler_input_frames_used(handle);
      const outputFramesGenerated =
        wasm.wasm_resampler_output_frames_gen(handle);
      if (outputFramesGenerated > 0) {
        const outputPointer = wasm.wasm_resampler_output(handle);
        output.set(
          new Float32Array(
            wasm.memory.buffer,
            outputPointer,
            outputFramesGenerated * channels,
          ),
          0,
        );
      }
      return { inputFramesUsed, outputFramesGenerated };
    },
  };
}

function assertExports(
  exports: Partial<ResamplerWasmExports> | null,
): asserts exports is ResamplerWasmExports {
  const functions = [
    'wasm_resampler_create',
    'wasm_resampler_destroy',
    'wasm_resampler_input',
    'wasm_resampler_input_frames_used',
    'wasm_resampler_last_create_error',
    'wasm_resampler_output',
    'wasm_resampler_output_frames_gen',
    'wasm_resampler_prepare',
    'wasm_resampler_process',
  ] as const;
  if (exports === null || !(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error('The libsamplerate WASM module does not export memory.');
  }
  for (const name of functions) {
    if (typeof exports[name] !== 'function') {
      throw new Error(`The libsamplerate WASM module does not export ${name}.`);
    }
  }
}
