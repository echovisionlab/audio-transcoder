import {
  CustomAudioEncoder,
  EncodedPacket,
  registerEncoder,
  type AudioCodec,
  type AudioSample,
} from 'mediabunny';
import type {
  BundledAacEmscriptenModule,
  BundledAacEmscriptenModuleOptions,
} from './aac.generated.mjs';
import { createWasmModuleCache } from './wasm-module-cache.js';

const AAC_SAMPLE_RATES = Object.freeze([32_000, 44_100, 48_000]);
const AAC_BITRATES = Object.freeze([96_000, 128_000, 192_000, 256_000]);

interface AacEncoderBindings {
  readonly againErrorCode: number;
  readonly closeEncoder: (context: number) => void;
  readonly describeError: (errorCode: number) => string;
  readonly flushEncoderStart: (context: number) => number;
  readonly getEncodeInputPointer: (context: number, size: number) => number;
  readonly getEncodedData: (context: number) => number;
  readonly getEncodedDuration: (context: number) => number;
  readonly getEncoderExtradata: (context: number) => number;
  readonly getEncoderExtradataSize: (context: number) => number;
  readonly getEncoderFrameSize: (context: number) => number;
  readonly getHeap: () => Uint8Array;
  readonly initEncoder: (
    channels: number,
    sampleRate: number,
    bitrate: number,
  ) => number;
  readonly receivePacket: (context: number) => number;
  readonly resetEncoder: (context: number) => void;
  readonly sendFrame: (context: number, timestamp: bigint) => number;
}

type AacModuleLoader = () => Promise<BundledAacEmscriptenModule>;

export type BundledAacWasmLoader = (
  signal?: AbortSignal,
) => Promise<Uint8Array<ArrayBuffer>>;

export interface BundledAacEncoderRegistration {
  bind(config: AudioEncoderConfig, signal?: AbortSignal): void;
  register(): void;
}

interface AacRuntimeBinding {
  readonly loadWasm: BundledAacWasmLoader;
  readonly signal: AbortSignal | undefined;
}

const compiledModules = createWasmModuleCache<BundledAacWasmLoader>();
const runtimeBindingsByConfig = new WeakMap<
  AudioEncoderConfig,
  AacRuntimeBinding
>();
let moduleFactory:
  | Promise<
      (
        options: BundledAacEmscriptenModuleOptions,
      ) => Promise<BundledAacEmscriptenModule>
    >
  | undefined;
let factoryRegistered = false;

function createRawWasmModuleLoader(
  loadWasm: BundledAacWasmLoader,
  signal: AbortSignal | undefined,
): AacModuleLoader {
  const getModuleFactory = () => {
    if (moduleFactory !== undefined) return moduleFactory;
    moduleFactory = import('./aac.generated.mjs').then(
      ({ default: create }) => create,
    );
    return moduleFactory;
  };

  return async () => {
    const [compiled, createModule] = await Promise.all([
      compiledModules.load(loadWasm, signal),
      getModuleFactory(),
    ]);
    return createModule({
      instantiateWasm(imports, receiveInstance) {
        const instance = new WebAssembly.Instance(compiled, imports);
        receiveInstance(instance, compiled);
        return instance.exports;
      },
    });
  };
}

function createBundledAacEncoderClass() {
  return class BundledAacEncoder extends CustomAudioEncoder {
    #bindings: AacEncoderBindings | undefined;
    #context = 0;
    #decoderDescription: Uint8Array | undefined;
    #description: Uint8Array | undefined;
    #encoderFrameSize = 0;
    #nextPacketTimestampInSamples: number | undefined;
    #nextSampleTimestampInSamples: number | undefined;
    #pendingBuffer = new Float32Array(0);
    #pendingFrames = 0;

    static override supports(
      codec: AudioCodec,
      config: AudioEncoderConfig,
    ): boolean {
      const aacFormat = (
        config as AudioEncoderConfig & {
          readonly aac?: { readonly format?: string };
        }
      ).aac?.format;
      return (
        runtimeBindingsByConfig.has(config) &&
        codec === 'aac' &&
        config.numberOfChannels >= 1 &&
        config.numberOfChannels <= 2 &&
        AAC_SAMPLE_RATES.includes(config.sampleRate) &&
        config.bitrate !== undefined &&
        AAC_BITRATES.includes(config.bitrate) &&
        (aacFormat === undefined || aacFormat === 'aac')
      );
    }

    override async init(): Promise<void> {
      const binding = runtimeBindingsByConfig.get(this.config);
      if (binding === undefined) {
        throw new Error(
          'No AAC runtime-asset WASM loader was bound to this encoder configuration.',
        );
      }
      const loadAacModule = createRawWasmModuleLoader(
        binding.loadWasm,
        binding.signal,
      );
      const module = await loadAacModule();
      const bindings = bindModule(module);
      const bitrate = this.config.bitrate;
      if (bitrate === undefined) {
        throw new Error('A bitrate is required for the AAC runtime-asset encoder.');
      }

      const context = bindings.initEncoder(
        this.config.numberOfChannels,
        this.config.sampleRate,
        bitrate,
      );
      if (context === 0) {
        throw new Error('Failed to initialize the AAC runtime-asset encoder.');
      }

      this.#bindings = bindings;
      this.#context = context;
      try {
        this.#encoderFrameSize = bindings.getEncoderFrameSize(context);
        const extradataPointer = bindings.getEncoderExtradata(context);
        const extradataSize = bindings.getEncoderExtradataSize(context);
        if (
          this.#encoderFrameSize <= 0 ||
          extradataPointer === 0 ||
          extradataSize <= 0
        ) {
          throw new Error('The AAC runtime-asset encoder returned invalid metadata.');
        }
        this.#decoderDescription = module.HEAPU8.slice(
          extradataPointer,
          extradataPointer + extradataSize,
        );
        this.#resetStreamState();
      } catch (error) {
        this.close();
        throw error;
      }
    }

    override async encode(audioSample: AudioSample): Promise<void> {
      this.#requireBindings();
      const channels = this.config.numberOfChannels;
      const incomingFrames = audioSample.numberOfFrames;
      const incomingBytes = new Uint8Array(
        audioSample.allocationSize({ format: 'f32', planeIndex: 0 }),
      );
      audioSample.copyTo(incomingBytes, { format: 'f32', planeIndex: 0 });
      const incomingData = new Float32Array(incomingBytes.buffer);

      if (this.#nextSampleTimestampInSamples === undefined) {
        const firstTimestamp = Math.round(
          audioSample.timestamp * this.config.sampleRate,
        );
        this.#nextSampleTimestampInSamples = firstTimestamp;
        this.#nextPacketTimestampInSamples = firstTimestamp;
      }

      const requiredSamples = Math.max(
        (this.#pendingFrames + incomingFrames) * channels,
        this.#encoderFrameSize * channels,
      );
      if (requiredSamples > this.#pendingBuffer.length) {
        const nextBuffer = new Float32Array(requiredSamples);
        nextBuffer.set(
          this.#pendingBuffer.subarray(0, this.#pendingFrames * channels),
        );
        this.#pendingBuffer = nextBuffer;
      }
      this.#pendingBuffer.set(incomingData, this.#pendingFrames * channels);
      this.#pendingFrames += incomingFrames;

      while (this.#pendingFrames >= this.#encoderFrameSize) {
        this.#encodeOneFrame(this.#nextSampleTimestampInSamples!);
      }
    }

    override async flush(): Promise<void> {
      const bindings = this.#requireBindings();
      if (this.#pendingFrames > 0) {
        const frameSamples =
          this.#encoderFrameSize * this.config.numberOfChannels;
        this.#pendingBuffer.fill(
          0,
          this.#pendingFrames * this.config.numberOfChannels,
          frameSamples,
        );
        this.#pendingFrames = this.#encoderFrameSize;
        this.#encodeOneFrame(this.#nextSampleTimestampInSamples!);
      }

      const flushResult = bindings.flushEncoderStart(this.#context);
      if (flushResult < 0) {
        throw new Error(
          `AAC runtime-asset flush failed: ${bindings.describeError(flushResult)} (${flushResult}).`,
        );
      }
      this.#drainPackets();
      bindings.resetEncoder(this.#context);
      this.#resetStreamState();
    }

    override close(): void {
      if (this.#bindings !== undefined && this.#context !== 0) {
        this.#bindings.closeEncoder(this.#context);
      }
      this.#bindings = undefined;
      this.#context = 0;
      this.#decoderDescription = undefined;
      this.#description = undefined;
      this.#encoderFrameSize = 0;
      this.#pendingBuffer = new Float32Array(0);
      this.#pendingFrames = 0;
      this.#nextPacketTimestampInSamples = undefined;
      this.#nextSampleTimestampInSamples = undefined;
    }

    #encodeOneFrame(timestamp: number): void {
      const bindings = this.#requireBindings();

      const channels = this.config.numberOfChannels;
      const frameSamples = this.#encoderFrameSize * channels;
      const frameBytes = frameSamples * Float32Array.BYTES_PER_ELEMENT;
      const inputPointer = bindings.getEncodeInputPointer(
        this.#context,
        frameBytes,
      );
      if (inputPointer === 0) {
        throw new Error('Failed to allocate the AAC runtime-asset input buffer.');
      }
      bindings
        .getHeap()
        .set(
          new Uint8Array(
            this.#pendingBuffer.buffer,
            this.#pendingBuffer.byteOffset,
            frameBytes,
          ),
          inputPointer,
        );

      let result = bindings.sendFrame(this.#context, BigInt(timestamp));
      if (result === bindings.againErrorCode) {
        this.#drainPackets();
        result = bindings.sendFrame(this.#context, BigInt(timestamp));
      }
      if (result < 0) {
        throw new Error(
          `AAC runtime-asset encoding failed at input sample ${timestamp}: ${bindings.describeError(result)} (${result}).`,
        );
      }

      this.#pendingFrames -= this.#encoderFrameSize;
      if (this.#pendingFrames > 0) {
        this.#pendingBuffer.copyWithin(
          0,
          frameSamples,
          frameSamples + this.#pendingFrames * channels,
        );
      }
      this.#nextSampleTimestampInSamples = timestamp + this.#encoderFrameSize;
      this.#drainPackets();
    }

    #drainPackets(): void {
      const bindings = this.#requireBindings();
      let size = bindings.receivePacket(this.#context);
      while (size > 0) {
        const timestamp = this.#nextPacketTimestampInSamples;
        if (timestamp === undefined) {
          throw new Error('AAC output timestamps were not initialized.');
        }
        const duration = bindings.getEncodedDuration(this.#context);
        if (duration <= 0) {
          throw new Error(
            'The AAC runtime-asset encoder returned an invalid duration.',
          );
        }
        const dataPointer = bindings.getEncodedData(this.#context);
        const data = bindings.getHeap().slice(dataPointer, dataPointer + size);
        const packet = new EncodedPacket(
          data,
          'key',
          timestamp / this.config.sampleRate,
          duration / this.config.sampleRate,
        );
        const metadata: EncodedAudioChunkMetadata | undefined = this
          .#description
          ? {
              decoderConfig: {
                codec: 'mp4a.40.2',
                description: this.#description,
                numberOfChannels: this.config.numberOfChannels,
                sampleRate: this.config.sampleRate,
              },
            }
          : undefined;
        this.onPacket(packet, metadata);
        this.#description = undefined;
        this.#nextPacketTimestampInSamples = timestamp + duration;
        size = bindings.receivePacket(this.#context);
      }
      if (size < 0) {
        throw new Error(
          `AAC runtime-asset packet drain failed: ${bindings.describeError(size)} (${size}).`,
        );
      }
    }

    #requireBindings(): AacEncoderBindings {
      if (this.#bindings === undefined) {
        throw new Error('The AAC runtime-asset encoder is not initialized.');
      }
      return this.#bindings;
    }

    #resetStreamState(): void {
      this.#nextPacketTimestampInSamples = undefined;
      this.#nextSampleTimestampInSamples = undefined;
      this.#pendingFrames = 0;
      this.#description = this.#decoderDescription;
    }
  };
}

function bindModule(module: BundledAacEmscriptenModule): AacEncoderBindings {
  return {
    againErrorCode: (
      module.cwrap('get_again_error_code', 'number', []) as () => number
    )(),
    closeEncoder: module.cwrap('close_encoder', null, ['number']) as (
      context: number,
    ) => void,
    describeError: module.cwrap('get_error_description', 'string', [
      'number',
    ]) as (errorCode: number) => string,
    flushEncoderStart: module.cwrap('flush_encoder_start', 'number', [
      'number',
    ]) as (context: number) => number,
    getEncodeInputPointer: module.cwrap('get_encode_input_ptr', 'number', [
      'number',
      'number',
    ]) as (context: number, size: number) => number,
    getEncodedData: module.cwrap('get_encoded_data', 'number', ['number']) as (
      context: number,
    ) => number,
    getEncodedDuration: module.cwrap('get_encoded_duration', 'number', [
      'number',
    ]) as (context: number) => number,
    getEncoderExtradata: module.cwrap('get_encoder_extradata', 'number', [
      'number',
    ]) as (context: number) => number,
    getEncoderExtradataSize: module.cwrap(
      'get_encoder_extradata_size',
      'number',
      ['number'],
    ) as (context: number) => number,
    getEncoderFrameSize: module.cwrap('get_encoder_frame_size', 'number', [
      'number',
    ]) as (context: number) => number,
    getHeap: () => module.HEAPU8,
    initEncoder: module.cwrap('init_encoder', 'number', [
      'number',
      'number',
      'number',
    ]) as AacEncoderBindings['initEncoder'],
    receivePacket: module.cwrap('receive_packet', 'number', ['number']) as (
      context: number,
    ) => number,
    resetEncoder: module.cwrap('reset_encoder', null, ['number']) as (
      context: number,
    ) => void,
    sendFrame: module.cwrap('send_frame', 'number', [
      'number',
      'number',
    ]) as AacEncoderBindings['sendFrame'],
  };
}

const BundledAacEncoder = createBundledAacEncoderClass();

/** Creates a runtime-local binding for the realm-global MediaBunny encoder. */
export function createBundledAacEncoderRegistration(
  loadWasm: BundledAacWasmLoader,
): BundledAacEncoderRegistration {
  if (typeof loadWasm !== 'function') {
    throw new TypeError('AAC runtime-asset registration requires a WASM byte loader.');
  }
  return Object.freeze({
    bind(config: AudioEncoderConfig, signal?: AbortSignal): void {
      runtimeBindingsByConfig.set(config, { loadWasm, signal });
    },
    register(): void {
      if (factoryRegistered) return;
      registerEncoder(BundledAacEncoder);
      factoryRegistered = true;
    },
  });
}
