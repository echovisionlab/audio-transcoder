import type { AudioTranscoderPlugin } from '../codecs/contracts.js';

export interface AudioTranscoderEngineInfo {
  readonly name: string;
  readonly version: string;
}

export interface AudioInput {
  /**
   * Complete file bytes. Treat them as immutable until the operation settles;
   * a Worker may detach the buffer at dispatch when transfer is enabled.
   */
  readonly data: ArrayBuffer;
  readonly name?: string;
  readonly size?: number;
}

/**
 * Header-level decode confidence: `built-in` is package-owned;
 * `likely-browser` is unverified browser-friendly input; `browser-dependent`
 * varies by runtime; `unknown` has no recognized decoder path.
 */
export type AudioDecodeSupport =
  | 'browser-dependent'
  | 'built-in'
  | 'likely-browser'
  | 'unknown';

/** Structured source encoding metadata that does not require parsing `codec`. */
export type AudioSourceEncoding =
  | Readonly<{
      readonly bitDepth: number | null;
      readonly endianness: 'big' | 'little' | 'not-applicable' | 'unknown';
      readonly kind: 'pcm';
      readonly sampleFormat: 'float' | 'integer';
      readonly signedness: 'not-applicable' | 'signed' | 'unknown' | 'unsigned';
    }>
  | Readonly<{
      readonly bitDepth: number | null;
      readonly codec: string;
      readonly kind: 'lossless-compressed';
    }>
  | Readonly<{
      /** First-frame estimate when available; not an average for VBR sources. */
      readonly estimatedBitrateBps: number | null;
      readonly codec: string;
      readonly kind: 'lossy-compressed';
    }>
  | Readonly<{
      readonly kind: 'unknown';
    }>;

export interface AudioInspection {
  readonly bitDepth: number | null;
  readonly channels: number | null;
  readonly codec: string;
  readonly container: string;
  readonly decodeSupport: AudioDecodeSupport;
  readonly durationSeconds: number | null;
  readonly notes: readonly string[];
  readonly sampleRate: number | null;
  /**
   * Structured encoding metadata. Built-in inspectors always provide it.
   * Optionality preserves compatibility with third-party inspector plugins
   * written against releases before this field existed.
   */
  readonly sourceEncoding?: AudioSourceEncoding;
}

export interface PcmAudio {
  /**
   * Treat channel views and their backing buffers as immutable until settlement.
   */
  readonly channelData: readonly Float32Array[];
  readonly sampleRate: number;
}

export interface DecodedAudio extends PcmAudio {
  readonly durationSeconds: number;
  readonly source: string;
}

export type AudioSampleFormat = 'float' | 'integer' | 'lossy';

export interface AudioOutputPreset {
  readonly bitDepth: number | null;
  readonly container: string;
  readonly extension: string;
  readonly id: string;
  readonly mimeType: string;
  readonly sampleFormat: AudioSampleFormat;
}

export interface EncodedAudio {
  readonly data: ArrayBuffer;
  readonly preset: AudioOutputPreset;
}

export interface AudioTranscoderCapabilities {
  /** Installed decoder format labels; concrete data may still reject. */
  readonly decode: readonly string[];
  /** Exact output presets accepted by `encode()` and `transcode()`. */
  readonly encode: readonly AudioOutputPreset[];
  /** Installed header-inspector format labels, not decode guarantees. */
  readonly inspect: readonly string[];
}

export type AudioOperationKind = 'decode' | 'encode' | 'transcode';

export type AudioProgressPhase = 'decode' | 'encode' | 'finalize';

export interface AudioProgress {
  readonly completedFrames: number | null;
  readonly operation: AudioOperationKind;
  readonly phase: AudioProgressPhase;
  /** Overall operation progress from 0 to 1, quantized to three decimals. */
  readonly progress: number;
  readonly totalFrames: number | null;
}

export type AudioProgressListener = (progress: AudioProgress) => void;

export interface AudioOperationOptions {
  /**
   * Receives immutable progress snapshots; a thrown listener error rejects work.
   */
  readonly onProgress?: AudioProgressListener;

  /** Cancels queued or running work with `OPERATION_ABORTED`. */
  readonly signal?: AbortSignal;

  /**
   * Transfers input ownership at Worker dispatch instead of copying it.
   * Decode/transcode detach `AudioInput.data`; encode detaches every transferable
   * `ArrayBuffer` backing a channel view, including aliased views of the same
   * buffer. Non-transferable backing storage is copied. Ignored by inline
   * engines. Treat all inputs as immutable until the operation settles.
   */
  readonly transferInput?: boolean;

  /**
   * Disables the whole-buffer size guard, but cannot prevent an out-of-memory
   * failure. Prefer the streaming Worker APIs for large files.
   */
  readonly unsafeAllowLargeBuffers?: boolean;
}

export interface CreateAudioTranscoderEngineOptions {
  /** Codec strategies checked before built-in adapters. */
  readonly plugins?: readonly AudioTranscoderPlugin[];
}

export interface AudioTranscoderEngine {
  /**
   * Decodes supported input into planar Float32 PCM.
   *
   * @throws `UNSUPPORTED_INPUT`, validation, resource-limit, or cancellation
   * errors.
   */
  decode(
    input: AudioInput,
    options?: AudioOperationOptions,
  ): Promise<DecodedAudio>;
  /**
   * Encodes planar PCM with a registered output preset.
   *
   * @throws `UNSUPPORTED_OUTPUT`, validation, resource-limit, or cancellation
   * errors.
   */
  encode(
    audio: PcmAudio,
    presetId: string,
    options?: AudioOperationOptions,
  ): Promise<EncodedAudio>;
  getCapabilities(): AudioTranscoderCapabilities;
  getInfo(): AudioTranscoderEngineInfo;
  getVersion(): string;
  /** Inspects headers synchronously without decoding audio payloads. */
  inspect(input: AudioInput): AudioInspection;

  /**
   * Decodes then encodes while preserving sample rate and channel layout.
   *
   * @throws The documented decode or encode errors for either phase.
   */
  transcode(
    input: AudioInput,
    presetId: string,
    options?: AudioOperationOptions,
  ): Promise<EncodedAudio>;
}

export interface AudioTranscoderWorkerEngine extends AudioTranscoderEngine {
  /** Cancels pending work and releases the Worker. This instance is terminal. */
  terminate(): void;
}

export interface CreateAudioTranscoderWorkerEngineOptions {
  /**
   * Maximum operations waiting behind the active operation. Defaults to 8.
   * Must be an integer from 0 to 64. The active operation is excluded; use 0
   * to reject while the Worker is busy.
   */
  readonly maxQueued?: number;

  /**
   * Maximum bytes retained by operations waiting behind the active operation.
   * Defaults to the 64 MiB whole-buffer safety limit. The active operation is
   * excluded. `unsafeAllowLargeBuffers` does not bypass this aggregate limit.
   */
  readonly maxQueuedBytes?: number;

  /**
   * Supplies a module Worker when a custom entry URL or CSP handling is
   * required. Import `@echovisionlab/audio-transcoder/worker` from that entry module.
   */
  readonly workerFactory?: () => Worker;
}
