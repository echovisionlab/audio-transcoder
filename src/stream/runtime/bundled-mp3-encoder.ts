import {
  CustomAudioEncoder,
  EncodedPacket,
  registerEncoder,
  type AudioCodec,
  type AudioSample,
} from "mediabunny";
import { createWasmModuleCache } from "./wasm-module-cache.js";

export const BUNDLED_MP3_WASM_ABI_VERSION = 1;

const MP3_ALL_SAMPLE_RATES = Object.freeze([
  16_000, 22_050, 24_000, 32_000, 44_100, 48_000,
]);
const MP3_HIGH_BITRATE_SAMPLE_RATES = Object.freeze([32_000, 44_100, 48_000]);
const MP3_BITRATES = Object.freeze([128_000, 192_000, 256_000, 320_000]);
const MPEG1_LAYER3_BITRATES = Object.freeze([
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
]);
const MPEG2_LAYER3_BITRATES = Object.freeze([
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
]);
const MPEG1_SAMPLE_RATES = Object.freeze([44_100, 48_000, 32_000]);

export type Mp3WasmByteLoader = (
  signal?: AbortSignal,
) => Promise<Uint8Array<ArrayBuffer>>;

export interface BundledMp3EncoderRegistration {
  bind(config: AudioEncoderConfig, signal?: AbortSignal): void;
  register(): void;
}

export interface BundledMp3WasmExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly _initialize?: () => void;
  readonly wasm_mp3_abi_version: () => number;
  readonly wasm_mp3_create: (
    channels: number,
    sampleRate: number,
    bitrate: number,
  ) => number;
  readonly wasm_mp3_destroy: (handle: number) => void;
  readonly wasm_mp3_encode: (handle: number, frames: number) => number;
  readonly wasm_mp3_flush: (handle: number) => number;
  readonly wasm_mp3_last_create_error: () => number;
  readonly wasm_mp3_output: (handle: number) => number;
  readonly wasm_mp3_prepare_pcm: (handle: number, frames: number) => number;
  readonly wasm_mp3_reset: (handle: number) => number;
}

export interface BundledMp3FrameHeader {
  readonly audioSamplesInFrame: number;
  readonly sampleRate: number;
  readonly totalSize: number;
}

interface Mp3RuntimeBinding {
  readonly loadWasm: Mp3WasmByteLoader;
  readonly signal: AbortSignal | undefined;
}

const compiledModules = createWasmModuleCache<Mp3WasmByteLoader>();
const runtimeBindingsByConfig = new WeakMap<
  AudioEncoderConfig,
  Mp3RuntimeBinding
>();
let factoryRegistered = false;

export async function instantiateBundledMp3Wasm(
  loadWasm: Mp3WasmByteLoader,
  signal?: AbortSignal,
): Promise<BundledMp3WasmExports> {
  const module = await compiledModules.load(loadWasm, signal);
  const instance = await WebAssembly.instantiate(module, createImports());
  const exports = instance.exports as Partial<BundledMp3WasmExports>;
  assertExports(exports);
  exports._initialize?.();
  const actualAbiVersion = exports.wasm_mp3_abi_version();
  if (actualAbiVersion !== BUNDLED_MP3_WASM_ABI_VERSION) {
    throw new Error(
      `MP3 runtime-asset WASM ABI mismatch: expected ${BUNDLED_MP3_WASM_ABI_VERSION}, received ${actualAbiVersion}.`,
    );
  }
  return exports;
}

/**
 * Registers the raw-WASM LAME encoder with MediaBunny. The caller owns
 * asset selection and integrity verification; this module never chooses a URL.
 */
export function createBundledMp3EncoderRegistration(
  loadWasm: Mp3WasmByteLoader,
): BundledMp3EncoderRegistration {
  if (typeof loadWasm !== "function") {
    throw new TypeError(
      "MP3 runtime-asset registration requires a WASM byte loader.",
    );
  }
  return Object.freeze({
    bind(config: AudioEncoderConfig, signal?: AbortSignal): void {
      runtimeBindingsByConfig.set(config, { loadWasm, signal });
    },
    register(): void {
      if (factoryRegistered) return;
      registerEncoder(BundledMp3Encoder);
      factoryRegistered = true;
    },
  });
}

function createBundledMp3EncoderClass() {
  return class BundledMp3Encoder extends CustomAudioEncoder {
    #exports: BundledMp3WasmExports | undefined;
    #handle = 0;
    #pending = new Uint8Array(0);
    #pendingBytes = 0;
    #currentTimestamp: number | undefined;
    #emitDecoderConfig = true;

    static override supports(
      codec: AudioCodec,
      config: AudioEncoderConfig,
    ): boolean {
      if (
        !runtimeBindingsByConfig.has(config) ||
        codec !== "mp3" ||
        config.numberOfChannels < 1 ||
        config.numberOfChannels > 2 ||
        config.bitrate === undefined ||
        !MP3_BITRATES.includes(config.bitrate) ||
        (config.bitrateMode !== undefined && config.bitrateMode !== "constant")
      ) {
        return false;
      }
      const sampleRates =
        config.bitrate === 128_000
          ? MP3_ALL_SAMPLE_RATES
          : MP3_HIGH_BITRATE_SAMPLE_RATES;
      return sampleRates.includes(config.sampleRate);
    }

    override async init(): Promise<void> {
      const binding = runtimeBindingsByConfig.get(this.config);
      if (binding === undefined) {
        throw new Error(
          "No MP3 runtime-asset WASM loader was bound to this encoder configuration.",
        );
      }
      const bitrate = this.config.bitrate;
      if (bitrate === undefined) {
        throw new Error(
          "A bitrate is required for the MP3 runtime-asset encoder.",
        );
      }
      const exports = await instantiateBundledMp3Wasm(
        binding.loadWasm,
        binding.signal,
      );
      const handle = exports.wasm_mp3_create(
        this.config.numberOfChannels,
        this.config.sampleRate,
        bitrate,
      );
      if (handle === 0) {
        throw new Error(
          `Failed to initialize the MP3 runtime-asset encoder (${exports.wasm_mp3_last_create_error()}).`,
        );
      }
      this.#exports = exports;
      this.#handle = handle;
      this.#resetStreamState();
    }

    override async encode(audioSample: AudioSample): Promise<void> {
      const exports = this.#requireExports();
      const frames = audioSample.numberOfFrames;
      const sizePerChannel = audioSample.allocationSize({
        format: "s16-planar",
        planeIndex: 0,
      });
      const inputPointer = exports.wasm_mp3_prepare_pcm(this.#handle, frames);
      if (inputPointer === 0) {
        throw new Error(
          "Failed to allocate the MP3 runtime-asset input buffer.",
        );
      }
      const requiredBytes = sizePerChannel * this.config.numberOfChannels;
      assertHeapRange(
        exports.memory,
        inputPointer,
        requiredBytes,
        "input buffer",
      );
      for (let channel = 0; channel < this.config.numberOfChannels; channel++) {
        const destination = new Uint8Array(
          exports.memory.buffer,
          inputPointer + channel * sizePerChannel,
          sizePerChannel,
        );
        audioSample.copyTo(destination, {
          format: "s16-planar",
          planeIndex: channel,
        });
      }

      this.#currentTimestamp ??= audioSample.timestamp;
      const encodedBytes = exports.wasm_mp3_encode(this.#handle, frames);
      if (encodedBytes < 0) {
        throw new Error(`MP3 runtime-asset encoding failed (${encodedBytes}).`);
      }
      this.#digestNativeOutput(encodedBytes);
    }

    override async flush(): Promise<void> {
      const exports = this.#requireExports();
      const flushedBytes = exports.wasm_mp3_flush(this.#handle);
      if (flushedBytes < 0) {
        throw new Error(`MP3 runtime-asset flush failed (${flushedBytes}).`);
      }
      this.#currentTimestamp ??= 0;
      this.#digestNativeOutput(flushedBytes);
      if (this.#pendingBytes !== 0) {
        throw new Error(
          `MP3 runtime-asset flush left ${this.#pendingBytes} incomplete output bytes.`,
        );
      }
      const resetResult = exports.wasm_mp3_reset(this.#handle);
      if (resetResult < 0) {
        throw new Error(`MP3 runtime-asset reset failed (${resetResult}).`);
      }
      this.#resetStreamState();
    }

    override close(): void {
      if (this.#exports !== undefined && this.#handle !== 0) {
        this.#exports.wasm_mp3_destroy(this.#handle);
      }
      this.#exports = undefined;
      this.#handle = 0;
      this.#pending = new Uint8Array(0);
      this.#pendingBytes = 0;
      this.#currentTimestamp = undefined;
      this.#emitDecoderConfig = true;
    }

    #digestNativeOutput(size: number): void {
      if (size === 0) {
        return;
      }
      const exports = this.#requireExports();
      const outputPointer = exports.wasm_mp3_output(this.#handle);
      assertHeapRange(exports.memory, outputPointer, size, "encoded output");
      const requiredSize = this.#pendingBytes + size;
      if (requiredSize > this.#pending.length) {
        const next = new Uint8Array(requiredSize);
        next.set(this.#pending.subarray(0, this.#pendingBytes));
        this.#pending = next;
      }
      this.#pending.set(
        new Uint8Array(exports.memory.buffer, outputPointer, size),
        this.#pendingBytes,
      );
      this.#pendingBytes = requiredSize;

      let offset = 0;
      while (offset <= this.#pendingBytes - 4) {
        const word = new DataView(
          this.#pending.buffer,
          this.#pending.byteOffset + offset,
          4,
        ).getUint32(0, false);
        const header = parseBundledMp3FrameHeader(word);
        if (header === null) {
          throw new Error(
            `MP3 runtime-asset encoder returned invalid frame data at byte ${offset}.`,
          );
        }
        if (header.sampleRate !== this.config.sampleRate) {
          throw new Error(
            `MP3 runtime-asset encoder returned ${header.sampleRate} Hz for a ${this.config.sampleRate} Hz stream.`,
          );
        }
        if (header.totalSize > this.#pendingBytes - offset) {
          break;
        }
        // encode() and flush() establish the origin before output is digested.
        const timestamp = this.#currentTimestamp!;
        const duration = header.audioSamplesInFrame / header.sampleRate;
        const packet = new EncodedPacket(
          this.#pending.slice(offset, offset + header.totalSize),
          "key",
          timestamp,
          duration,
        );
        const metadata: EncodedAudioChunkMetadata | undefined = this
          .#emitDecoderConfig
          ? {
              decoderConfig: {
                codec: "mp3",
                numberOfChannels: this.config.numberOfChannels,
                sampleRate: this.config.sampleRate,
              },
            }
          : undefined;
        this.onPacket(packet, metadata);
        this.#emitDecoderConfig = false;
        this.#currentTimestamp = timestamp + duration;
        offset += header.totalSize;
      }

      if (offset > 0) {
        this.#pending.copyWithin(0, offset, this.#pendingBytes);
        this.#pendingBytes -= offset;
      }
    }

    #requireExports(): BundledMp3WasmExports {
      if (this.#exports === undefined || this.#handle === 0) {
        throw new Error("The MP3 runtime-asset encoder is not initialized.");
      }
      return this.#exports;
    }

    #resetStreamState(): void {
      this.#pendingBytes = 0;
      this.#currentTimestamp = undefined;
      this.#emitDecoderConfig = true;
    }
  };
}

const BundledMp3Encoder = createBundledMp3EncoderClass();

export function parseBundledMp3FrameHeader(
  word: number,
): BundledMp3FrameHeader | null {
  if (word >>> 21 !== 0x7ff) {
    return null;
  }
  const versionBits = (word >>> 19) & 0x03;
  const layerBits = (word >>> 17) & 0x03;
  const bitrateIndex = (word >>> 12) & 0x0f;
  const sampleRateIndex = (word >>> 10) & 0x03;
  if (
    versionBits === 0x01 ||
    layerBits !== 0x01 ||
    bitrateIndex === 0 ||
    bitrateIndex === 0x0f ||
    sampleRateIndex === 0x03
  ) {
    return null;
  }

  const mpeg1 = versionBits === 0x03;
  const bitrate = (mpeg1 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES)[
    bitrateIndex
  ]!;
  const rateDivisor = mpeg1 ? 1 : versionBits === 0x02 ? 2 : 4;
  const sampleRate = MPEG1_SAMPLE_RATES[sampleRateIndex]! / rateDivisor;
  const padding = (word >>> 9) & 0x01;
  const audioSamplesInFrame = mpeg1 ? 1152 : 576;
  const totalSize =
    Math.floor(((mpeg1 ? 144 : 72) * bitrate * 1000) / sampleRate) + padding;
  return Object.freeze({ audioSamplesInFrame, sampleRate, totalSize });
}

function createImports(): WebAssembly.Imports {
  const unsupportedWasiCall = (): never => {
    throw new Error(
      "The MP3 runtime-asset WASM module attempted unsupported I/O.",
    );
  };
  return {
    env: {
      emscripten_notify_memory_growth: () => undefined,
    },
    wasi_snapshot_preview1: {
      fd_close: unsupportedWasiCall,
      fd_seek: unsupportedWasiCall,
      fd_write: unsupportedWasiCall,
      proc_exit: unsupportedWasiCall,
    },
  };
}

function assertExports(
  exports: Partial<BundledMp3WasmExports>,
): asserts exports is BundledMp3WasmExports {
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error(
      "The MP3 runtime-asset WASM module does not export memory.",
    );
  }
  const functions = [
    "wasm_mp3_abi_version",
    "wasm_mp3_create",
    "wasm_mp3_destroy",
    "wasm_mp3_encode",
    "wasm_mp3_flush",
    "wasm_mp3_last_create_error",
    "wasm_mp3_output",
    "wasm_mp3_prepare_pcm",
    "wasm_mp3_reset",
  ] as const;
  for (const name of functions) {
    if (typeof exports[name] !== "function") {
      throw new Error(
        `The MP3 runtime-asset WASM module does not export ${name}.`,
      );
    }
  }
}

function assertHeapRange(
  memory: WebAssembly.Memory,
  pointer: number,
  size: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(pointer) ||
    pointer <= 0 ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    pointer > memory.buffer.byteLength - size
  ) {
    throw new Error(`The MP3 runtime-asset ${label} is outside WASM memory.`);
  }
}
