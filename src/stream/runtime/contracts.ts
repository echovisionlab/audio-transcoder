import type { AudioOutputPreset } from '../../engine/contracts.js';
import type { AudioTranscoderStreamCapabilities } from '../capabilities.js';
import type {
  AudioResampleQuality,
  AudioStreamInput,
  AudioStreamInspection,
  AudioStreamOutput,
} from '../contracts.js';
import type { PcmStreamSource } from '../pcm-source.js';
import type { StreamingResampler } from '../resampler.js';

export interface AudioStreamInputAdapterContext {
  /** Maximum bytes in any one source read; the adapter must enforce it. */
  readonly inputReadBytes: number;
  /** Maximum bytes in each decoded PCM yield; the adapter must enforce it. */
  readonly pcmChunkBytes: number;
  /**
   * Check before and after awaited work and at bounded intervals in long loops;
   * pass it to cancellable dependencies.
   */
  readonly signal: AbortSignal | undefined;
}

/**
 * A bounded-memory source inspector and PCM decoder. Methods are tried in
 * registration order; returning `null` declines the input and tries the next
 * adapter.
 */
export interface AudioStreamInputAdapter {
  /** Unique within this runtime's input adapters. */
  readonly id: string;
  /** Returns recognized metadata, or `null` to continue adapter fallthrough. */
  inspect(
    input: AudioStreamInput,
    context: AudioStreamInputAdapterContext,
  ): Promise<AudioStreamInspection | null>;
  /**
   * Opens a bounded PCM source, or returns `null` to continue fallthrough. The
   * engine owns a returned source and calls its idempotent `close()` on every
   * terminal path.
   */
  open(
    input: AudioStreamInput,
    context: AudioStreamInputAdapterContext,
  ): Promise<PcmStreamSource | null>;
  /**
   * Performs bounded decoder validation. If omitted, `inspect()` is used.
   * `null` continues fallthrough. A returned inspection maps `built-in` and
   * `likely-browser` to `supported`; other decode-support values map to
   * `recognized-unsupported`.
   */
  probe?(
    input: AudioStreamInput,
    context: AudioStreamInputAdapterContext,
  ): Promise<AudioStreamInspection | null>;
}

export interface AudioStreamEncoderConfiguration {
  readonly channels: number;
  /** Maximum `data.byteLength` of one output write; split larger output. */
  readonly outputChunkBytes: number;
  readonly preset: AudioOutputPreset;
  /** Resolved WAV container mode, or `null` for non-WAV outputs. */
  readonly rf64: boolean | null;
  readonly sampleRate: number;
  /** Must be checked during runtime initialization and encoding. */
  readonly signal?: AbortSignal;
  readonly writable: AudioStreamOutput;
}

/** A single bounded-memory encoder session. */
export interface AudioStreamEncoder {
  /** Idempotently aborts the configured writable and releases resources. */
  cancel(reason?: unknown): Promise<void>;
  /** Flushes encoded data, closes the configured writable, and releases resources. */
  finalize(): Promise<void>;
  getBytesWritten(): number;
  start(): Promise<void>;
  /**
   * Encodes interleaved Float32 PCM at the given frame offset. Implementations
   * must release the input reference before this promise resolves.
   */
  write(samples: Float32Array, frameOffset: number): Promise<void>;
}

/** Converts interleaved Float32 PCM into a seekable output stream. */
export interface AudioStreamEncoderAdapter {
  readonly id: string;
  /**
   * Resolves after any preset-specific codec runtime has been initialized.
   * Runtime output probes use this same lifecycle rather than a capability-only
   * shortcut, so custom adapters require no probe-specific API. If creation
   * rejects after locking the writable, the adapter must abort and release it.
   */
  create(
    configuration: AudioStreamEncoderConfiguration,
  ): Promise<AudioStreamEncoder>;
}

/** Creates bounded streaming sample-rate converter sessions. */
export interface AudioStreamResamplerAdapter {
  readonly id: string;
  create(
    channels: number,
    inputSampleRate: number,
    outputSampleRate: number,
    quality: AudioResampleQuality,
    signal?: AbortSignal,
  ): Promise<StreamingResampler | null>;
}

/**
 * Complete runtime used by the stream engine. A custom WASM implementation can
 * replace one or more roles without changing the public transcoding contract.
 * Custom adapters must enforce the configured read, PCM-yield, and output-write
 * limits; these are allocation bounds, not a total runtime-memory guarantee.
 */
export interface AudioTranscoderStreamCodecRuntime {
  readonly capabilities: AudioTranscoderStreamCapabilities;
  readonly encoder: AudioStreamEncoderAdapter;
  readonly inputs: readonly AudioStreamInputAdapter[];
  readonly resampler: AudioStreamResamplerAdapter;
}

export interface CreateAudioTranscoderStreamEngineOptions {
  /** Verified raw assets for the package runtime; no CDN is selected implicitly. */
  readonly codecAssets?: import('../../assets/audio-codec-assets.js').AudioTranscoderCodecAssetProvider;
  /** Custom codec adapters. Construct them inside the Worker that uses them. */
  readonly codecRuntime?: AudioTranscoderStreamCodecRuntime;
}
