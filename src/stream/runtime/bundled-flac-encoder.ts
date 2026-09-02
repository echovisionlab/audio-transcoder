import {
  CustomAudioEncoder,
  EncodedPacket,
  registerEncoder,
  type AudioCodec,
  type AudioSample,
} from 'mediabunny';
import { createWasmModuleCache } from './wasm-module-cache.js';

export const BUNDLED_FLAC_WASM_ABI_VERSION = 1;

export type FlacWasmByteLoader = (
  signal?: AbortSignal,
) => Promise<Uint8Array<ArrayBuffer>>;

export interface BundledFlacEncoderRegistration {
  bind(config: AudioEncoderConfig, signal?: AbortSignal): void;
  register(): void;
}

const FLAC_SAMPLE_RATES = Object.freeze([
  8_000,
  16_000,
  22_050,
  24_000,
  32_000,
  44_100,
  48_000,
  88_200,
  96_000,
  176_400,
  192_000,
]);

export interface BundledFlacWasmExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly _initialize?: () => void;
  readonly wasm_flac_abi_version: () => number;
  readonly wasm_flac_create: (
    channels: number,
    sampleRate: number,
    bitsPerSample: number,
  ) => number;
  readonly wasm_flac_last_create_error: () => number;
  readonly wasm_flac_last_error: (handle: number) => number;
  readonly wasm_flac_prepare_pcm: (handle: number, frames: number) => number;
  readonly wasm_flac_pcm: (handle: number) => number;
  readonly wasm_flac_encode: (handle: number, frames: number) => number;
  readonly wasm_flac_output: (handle: number) => number;
  readonly wasm_flac_output_length: (handle: number) => number;
  readonly wasm_flac_frame_count: (handle: number) => number;
  readonly wasm_flac_frame_size: (handle: number, index: number) => number;
  readonly wasm_flac_frame_samples: (handle: number, index: number) => number;
  readonly wasm_flac_header: (handle: number) => number;
  readonly wasm_flac_header_length: (handle: number) => number;
  readonly wasm_flac_finish: (handle: number) => number;
  readonly wasm_flac_reset: (handle: number) => number;
  readonly wasm_flac_destroy: (handle: number) => void;
}

interface FlacRuntimeBinding {
  readonly loadWasm: FlacWasmByteLoader;
  readonly signal: AbortSignal | undefined;
}

const compiledModules = createWasmModuleCache<FlacWasmByteLoader>();
const runtimeBindingsByConfig = new WeakMap<
  AudioEncoderConfig,
  FlacRuntimeBinding
>();
let factoryRegistered = false;

export async function instantiateBundledFlacWasm(
  loadWasm: FlacWasmByteLoader,
  signal?: AbortSignal,
): Promise<BundledFlacWasmExports> {
  const module = await compiledModules.load(loadWasm, signal);
  const instance = await WebAssembly.instantiate(module, createWasmImports());
  const exports = instance.exports as Partial<BundledFlacWasmExports>;
  assertWasmExports(exports);
  exports._initialize?.();
  const abiVersion = exports.wasm_flac_abi_version();
  if (abiVersion !== BUNDLED_FLAC_WASM_ABI_VERSION) {
    throw new Error(
      `FLAC runtime-asset WASM ABI mismatch: expected ${BUNDLED_FLAC_WASM_ABI_VERSION}, received ${abiVersion}.`,
    );
  }
  return exports;
}

function createWasmImports(): WebAssembly.Imports {
  const unsupportedWasiCall = (): never => {
    throw new Error('The FLAC runtime-asset WASM module attempted unsupported WASI I/O.');
  };
  return {
    env: {
      emscripten_notify_memory_growth: () => undefined,
    },
    wasi_snapshot_preview1: {
      fd_close: unsupportedWasiCall,
      fd_read: unsupportedWasiCall,
      fd_seek: unsupportedWasiCall,
      fd_write: unsupportedWasiCall,
    },
  };
}

function assertWasmExports(
  exports: Partial<BundledFlacWasmExports>,
): asserts exports is BundledFlacWasmExports {
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error('The FLAC runtime-asset WASM module does not export memory.');
  }
  const functions = [
    'wasm_flac_abi_version',
    'wasm_flac_create',
    'wasm_flac_last_create_error',
    'wasm_flac_last_error',
    'wasm_flac_prepare_pcm',
    'wasm_flac_pcm',
    'wasm_flac_encode',
    'wasm_flac_output',
    'wasm_flac_output_length',
    'wasm_flac_frame_count',
    'wasm_flac_frame_size',
    'wasm_flac_frame_samples',
    'wasm_flac_header',
    'wasm_flac_header_length',
    'wasm_flac_finish',
    'wasm_flac_reset',
    'wasm_flac_destroy',
  ] as const;
  for (const name of functions) {
    if (typeof exports[name] !== 'function') {
      throw new Error(`The FLAC runtime-asset WASM module does not export ${name}.`);
    }
  }
}

function createBundledFlacEncoder(): typeof CustomAudioEncoder {
  return class BundledFlacEncoder extends CustomAudioEncoder {
    #wasm: BundledFlacWasmExports | undefined;
    #handle = 0;
    #bitsPerSample: 16 | 24 | undefined;
    #description: Uint8Array | undefined;
    #nextTimestampInSamples: number | undefined;

    static override supports(
      codec: AudioCodec,
      config: AudioEncoderConfig,
    ): boolean {
      return (
        runtimeBindingsByConfig.has(config) &&
        codec === 'flac' &&
        config.numberOfChannels >= 1 &&
        config.numberOfChannels <= 8 &&
        FLAC_SAMPLE_RATES.includes(config.sampleRate)
      );
    }

    override async init(): Promise<void> {
      const binding = runtimeBindingsByConfig.get(this.config);
      if (binding === undefined) {
        throw new Error(
          'No FLAC runtime-asset WASM loader was bound to this encoder configuration.',
        );
      }
      this.#wasm = await instantiateBundledFlacWasm(
        binding.loadWasm,
        binding.signal,
      );
    }

    override async encode(audioSample: AudioSample): Promise<void> {
      const wasm = this.#requireWasm();
      const bitsPerSample = bitsPerSampleFor(audioSample.format);
      if (this.#handle === 0) {
        this.#createContext(wasm, bitsPerSample);
      } else if (bitsPerSample !== this.#bitsPerSample) {
        throw new Error(
          'FLAC runtime-asset input bit depth cannot change within an encoding session.',
        );
      }

      if (this.#nextTimestampInSamples === undefined) {
        this.#nextTimestampInSamples = Math.round(
          audioSample.timestamp * this.config.sampleRate,
        );
      }

      const frames = audioSample.numberOfFrames;
      const sampleCount = frames * this.config.numberOfChannels;
      if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) {
        throw new Error('FLAC runtime-asset input must contain complete PCM frames.');
      }
      const audioData = new ArrayBuffer(
        audioSample.allocationSize({ format: 's32', planeIndex: 0 }),
      );
      audioSample.copyTo(audioData, { format: 's32', planeIndex: 0 });

      const prepared = wasm.wasm_flac_prepare_pcm(this.#handle, frames);
      if (prepared !== 0) {
        throw nativeFailure('prepare PCM', prepared, wasm, this.#handle);
      }
      const pcmPointer = wasm.wasm_flac_pcm(this.#handle);
      if (!isMemoryRangeValid(wasm.memory, pcmPointer, audioData.byteLength)) {
        throw new Error('The FLAC runtime-asset encoder exposed an invalid PCM buffer.');
      }
      new Int32Array(
        wasm.memory.buffer,
        pcmPointer,
        sampleCount,
      ).set(new Int32Array(audioData));

      const encoded = wasm.wasm_flac_encode(this.#handle, frames);
      if (encoded !== 0) {
        throw nativeFailure('encode PCM', encoded, wasm, this.#handle);
      }
      this.#emitPackets(wasm);
    }

    override async flush(): Promise<void> {
      const wasm = this.#requireWasm();
      if (this.#handle === 0) {
        return;
      }
      const finished = wasm.wasm_flac_finish(this.#handle);
      if (finished !== 0) {
        throw nativeFailure('finish', finished, wasm, this.#handle);
      }
      const reset = wasm.wasm_flac_reset(this.#handle);
      if (reset !== 0) {
        throw nativeFailure('reset', reset, wasm, this.#handle);
      }
      const nextDescription = readHeader(wasm, this.#handle);
      this.#emitPackets(wasm);
      this.#description = nextDescription;
      this.#nextTimestampInSamples = undefined;
    }

    override close(): void {
      if (this.#wasm !== undefined && this.#handle !== 0) {
        this.#wasm.wasm_flac_destroy(this.#handle);
      }
      this.#wasm = undefined;
      this.#handle = 0;
      this.#bitsPerSample = undefined;
      this.#description = undefined;
      this.#nextTimestampInSamples = undefined;
    }

    #createContext(
      wasm: BundledFlacWasmExports,
      bitsPerSample: 16 | 24,
    ): void {
      const handle = wasm.wasm_flac_create(
        this.config.numberOfChannels,
        this.config.sampleRate,
        bitsPerSample,
      );
      if (handle === 0) {
        const error = wasm.wasm_flac_last_create_error();
        throw new Error(
          `FLAC runtime-asset encoder initialization failed (native error ${error}).`,
        );
      }
      this.#handle = handle;
      this.#bitsPerSample = bitsPerSample;
      try {
        const description = readHeader(wasm, handle);
        this.#description = description;
      } catch (error) {
        this.close();
        throw error;
      }
    }

    #emitPackets(wasm: BundledFlacWasmExports): void {
      const frameCount = wasm.wasm_flac_frame_count(this.#handle);
      const outputLength = wasm.wasm_flac_output_length(this.#handle);
      if (frameCount < 0 || outputLength < 0) {
        throw new Error('The FLAC runtime-asset encoder returned invalid output metadata.');
      }
      if (frameCount === 0) {
        if (outputLength !== 0) {
          throw new Error('The FLAC runtime-asset encoder returned unframed output.');
        }
        return;
      }
      // A context is created only from encode(), which initializes this value
      // before native code can emit its first frame.
      const timestamp = this.#nextTimestampInSamples!;
      const outputPointer = wasm.wasm_flac_output(this.#handle);
      if (!isMemoryRangeValid(wasm.memory, outputPointer, outputLength)) {
        throw new Error('The FLAC runtime-asset encoder exposed an invalid output buffer.');
      }

      const packets: Array<{ readonly data: Uint8Array; readonly samples: number }> = [];
      let offset = 0;
      for (let index = 0; index < frameCount; index += 1) {
        const size = wasm.wasm_flac_frame_size(this.#handle, index);
        const samples = wasm.wasm_flac_frame_samples(this.#handle, index);
        if (size < 1 || samples < 1 || size > outputLength - offset) {
          throw new Error('The FLAC runtime-asset encoder returned an invalid frame.');
        }
        packets.push({
          data: Uint8Array.from(
            new Uint8Array(wasm.memory.buffer, outputPointer + offset, size),
          ),
          samples,
        });
        offset += size;
      }
      if (offset !== outputLength) {
        throw new Error('The FLAC runtime-asset frame sizes do not match its output length.');
      }

      let nextTimestamp = timestamp;
      for (const packetInfo of packets) {
        const packet = new EncodedPacket(
          packetInfo.data,
          'key',
          nextTimestamp / this.config.sampleRate,
          packetInfo.samples / this.config.sampleRate,
        );
        const metadata: EncodedAudioChunkMetadata | undefined = this.#description
          ? {
              decoderConfig: {
                codec: 'flac',
                description: this.#description,
                numberOfChannels: this.config.numberOfChannels,
                sampleRate: this.config.sampleRate,
              },
            }
          : undefined;
        this.onPacket(packet, metadata);
        this.#description = undefined;
        nextTimestamp += packetInfo.samples;
      }
      this.#nextTimestampInSamples = nextTimestamp;
    }

    #requireWasm(): BundledFlacWasmExports {
      if (this.#wasm === undefined) {
        throw new Error('The FLAC runtime-asset encoder is not initialized.');
      }
      return this.#wasm;
    }
  };
}

function bitsPerSampleFor(format: AudioSample['format']): 16 | 24 {
  switch (format) {
    case 'u8':
    case 'u8-planar':
    case 's16':
    case 's16-planar':
      return 16;
    case 's32':
    case 's32-planar':
    case 'f32':
    case 'f32-planar':
      return 24;
  }
}

function readHeader(
  wasm: BundledFlacWasmExports,
  handle: number,
): Uint8Array {
  const pointer = wasm.wasm_flac_header(handle);
  const length = wasm.wasm_flac_header_length(handle);
  if (
    length < 8 ||
    !isMemoryRangeValid(wasm.memory, pointer, length)
  ) {
    throw new Error('The FLAC runtime-asset encoder returned an invalid stream header.');
  }
  const header = Uint8Array.from(
    new Uint8Array(wasm.memory.buffer, pointer, length),
  );
  if (
    header[0] !== 0x66 ||
    header[1] !== 0x4c ||
    header[2] !== 0x61 ||
    header[3] !== 0x43
  ) {
    throw new Error('The FLAC runtime-asset encoder returned an invalid stream marker.');
  }
  return header;
}

function isMemoryRangeValid(
  memory: WebAssembly.Memory,
  pointer: number,
  byteLength: number,
): boolean {
  return (
    Number.isSafeInteger(pointer) &&
    Number.isSafeInteger(byteLength) &&
    pointer > 0 &&
    byteLength >= 0 &&
    pointer <= memory.buffer.byteLength - byteLength
  );
}

function nativeFailure(
  operation: string,
  result: number,
  wasm: BundledFlacWasmExports,
  handle: number,
): Error {
  const detail = wasm.wasm_flac_last_error(handle);
  return new Error(
    `FLAC runtime-asset encoder could not ${operation} (native result ${result}, error ${detail}).`,
  );
}

const BundledFlacEncoder = createBundledFlacEncoder();

/** Registers the raw-WASM FLAC encoder without creating a nested Worker. */
export function createBundledFlacEncoderRegistration(
  loadWasm: FlacWasmByteLoader,
): BundledFlacEncoderRegistration {
  if (typeof loadWasm !== 'function') {
    throw new TypeError('FLAC runtime-asset registration requires a WASM byte loader.');
  }
  return Object.freeze({
    bind(config: AudioEncoderConfig, signal?: AbortSignal): void {
      runtimeBindingsByConfig.set(config, { loadWasm, signal });
    },
    register(): void {
      if (factoryRegistered) return;
      registerEncoder(BundledFlacEncoder);
      factoryRegistered = true;
    },
  });
}
