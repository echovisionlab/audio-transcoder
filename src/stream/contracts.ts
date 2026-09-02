import type {
  AudioInspection,
  AudioOutputPreset,
  AudioTranscoderEngineInfo,
} from '../engine/contracts.js';
import type { WavOutputPresetId } from '../codecs/wav-presets.js';
import type {
  AudioStreamOutputFormatId,
  AudioStreamOutputPreset,
  AudioTranscoderStreamCapabilities,
} from './capabilities.js';

export interface AudioStreamBlobInput {
  /** Browser-local source. `File` is supported because it extends `Blob`. */
  readonly blob: Blob;
  readonly name?: string;
  readonly http?: never;
}

export type AudioStreamHttpCredentials = 'include' | 'omit' | 'same-origin';

export interface AudioStreamHttpSource {
  /** Fetch credentials mode. Defaults to `same-origin`. */
  readonly credentials?: AudioStreamHttpCredentials;
  /** Optional serializable request headers. `Range` is owned by the engine. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Exact source size used for bounded random-access reads. */
  readonly size: number;
  /** Absolute HTTP(S) URL that must support byte-range requests. */
  readonly url: string;
}

export interface AudioStreamHttpInput {
  readonly blob?: never;
  /** Consumer-owned HTTP source. The engine only requests bounded byte ranges. */
  readonly http: AudioStreamHttpSource;
  readonly name?: string;
}

/** Browser-local Blob/File input or a serializable HTTP byte-range source. */
export type AudioStreamInput = AudioStreamBlobInput | AudioStreamHttpInput;

export type AudioStreamOutputPresetId = AudioStreamOutputPreset['id'];

export type AudioResampleQuality = 'balanced' | 'best' | 'fast';
export type AudioDitherMode = 'auto' | 'none' | 'tpdf';
export type WavContainerMode = 'auto' | 'rf64' | 'riff';

interface AudioStreamTargetBase {
  /** Optional channel count. Omit it to preserve the source layout. */
  readonly channels?: number;
  /** Band-limited sample-rate conversion quality. Defaults to `balanced`. */
  readonly resampleQuality?: AudioResampleQuality;
  /** Optional output sample rate. Omit it to preserve the source rate. */
  readonly sampleRate?: number;
}

export type AudioStreamIntegerOutputPresetId =
  | Exclude<WavOutputPresetId, 'wav-float32'>
  | Extract<
      AudioStreamOutputPreset,
      { readonly container: 'aiff' | 'flac' }
    >['id'];

export type AudioStreamNonIntegerOutputPresetId = Exclude<
  AudioStreamOutputPresetId,
  AudioStreamIntegerOutputPresetId
>;

export interface AudioStreamIntegerWavTarget extends AudioStreamTargetBase {
  /** Dither policy for integer output. Defaults to `auto`. */
  readonly dither?: AudioDitherMode;
  readonly presetId: Extract<
    AudioStreamIntegerOutputPresetId,
    WavOutputPresetId
  >;
  /** RIFF for normal WAV or RF64 for files that may exceed 4 GiB. */
  readonly wavContainer?: WavContainerMode;
}

export interface AudioStreamNonIntegerWavTarget extends AudioStreamTargetBase {
  /** Float output accepts `auto` or `none`; explicit TPDF is invalid. */
  readonly dither?: Exclude<AudioDitherMode, 'tpdf'>;
  readonly presetId: Extract<AudioStreamNonIntegerOutputPresetId, WavOutputPresetId>;
  readonly wavContainer?: WavContainerMode;
}

export interface AudioStreamIntegerNonWavTarget extends AudioStreamTargetBase {
  /** Dither policy for integer output. Defaults to `auto`. */
  readonly dither?: AudioDitherMode;
  readonly presetId: Exclude<AudioStreamIntegerOutputPresetId, WavOutputPresetId>;
  readonly wavContainer?: never;
}

export interface AudioStreamNonIntegerNonWavTarget
  extends AudioStreamTargetBase {
  /** Lossy output accepts `auto` or `none`; explicit TPDF is invalid. */
  readonly dither?: Exclude<AudioDitherMode, 'tpdf'>;
  readonly presetId: Exclude<AudioStreamNonIntegerOutputPresetId, WavOutputPresetId>;
  /** WAV container modes are invalid for non-WAV presets. */
  readonly wavContainer?: never;
}

export type AudioStreamWavTarget =
  | AudioStreamIntegerWavTarget
  | AudioStreamNonIntegerWavTarget;
export type AudioStreamNonWavTarget =
  | AudioStreamIntegerNonWavTarget
  | AudioStreamNonIntegerNonWavTarget;

/** Output target discriminated by its exact preset ID. */
export type AudioStreamTarget = AudioStreamNonWavTarget | AudioStreamWavTarget;

/** Exact output configuration used for one runtime availability probe. */
export interface AudioStreamOutputProbeTarget {
  /** Installed preset to initialize and exercise. */
  readonly presetId: AudioStreamOutputPresetId;
  /** Explicit encoded channel count; source-preserving defaults are invalid. */
  readonly channels: number;
  /** Explicit encoded sample rate; source-preserving defaults are invalid. */
  readonly sampleRate: number;
}

export interface AudioStreamOutputProbeOptions {
  /**
   * Cancels this caller with `OPERATION_ABORTED` without reading an input or
   * creating an artifact. Other callers sharing the same probe remain active.
   */
  readonly signal?: AbortSignal;
}

export interface AudioStreamSupportedOutputResult {
  readonly code: 'SUPPORTED';
  readonly message: 'The output runtime probe succeeded.';
  readonly reason: 'runtime-verified';
  readonly status: 'supported';
}

export interface AudioStreamUnsupportedOutputConfigurationResult {
  readonly code: 'UNSUPPORTED_OUTPUT';
  readonly message: string;
  readonly reason: 'channels' | 'preset' | 'sample-rate';
  readonly status: 'unsupported-configuration';
}

export interface AudioStreamUnavailableOutputResult {
  readonly code: 'OUTPUT_RUNTIME_UNAVAILABLE';
  readonly message: string;
  readonly reason:
    | 'encoder-create'
    | 'encoder-finalize'
    | 'encoder-no-output'
    | 'encoder-start'
    | 'encoder-write';
  readonly status: 'runtime-unavailable';
}

/**
 * Runtime support for one explicit output configuration. Static capability
 * mismatches are separate from failures to initialize or exercise the codec.
 */
export type AudioStreamOutputSupportResult =
  | AudioStreamSupportedOutputResult
  | AudioStreamUnavailableOutputResult
  | AudioStreamUnsupportedOutputConfigurationResult;

/** A random-access write used by seekable media containers such as WAV. */
export interface AudioStreamOutputChunk {
  readonly data: Uint8Array<ArrayBuffer>;
  readonly position: number;
  readonly type: 'write';
}

/**
 * Seekable output stream. A Chromium `FileSystemWritableFileStream` satisfies
 * this contract and remains fully local to the user's device. It must be
 * unlocked when passed to `transcode()`; the operation closes it on success and
 * aborts it on cancellation or failure until the final destination close
 * begins. That close is the irreversible commit point: once it starts, its
 * success or failure wins over a later cancellation request.
 */
export type AudioStreamOutput = WritableStream<AudioStreamOutputChunk>;

export type AudioStreamProgressPhase =
  | 'decode'
  | 'encode'
  | 'finalize'
  | 'prepare';

export interface AudioStreamProgress {
  readonly durationSeconds: number | null;
  readonly phase: AudioStreamProgressPhase;
  /** Overall progress from 0 to 1, quantized to three decimal places. */
  readonly progress: number;
  readonly processedSeconds: number | null;
}

export interface AudioStreamOperationOptions {
  /**
   * One source-read limit. A support probe also uses it as its cumulative
   * decoder-validation read budget. Defaults to 8 MiB.
   */
  readonly inputReadBytes?: number;
  /**
   * Optional whole-artifact byte limit. Known uncompressed outputs reject
   * during preparation when their predicted full container size exceeds this
   * value; every output write is also checked so unknown or compressed sizes
   * cannot cross the limit while encoding. Limit failures use
   * `reason === 'output-storage-limit'`.
   */
  readonly maxOutputBytes?: number;
  /** One buffered output-chunk limit, not total memory. Defaults to 4 MiB. */
  readonly outputChunkBytes?: number;
  /** One decoded PCM yield limit, not total memory. Defaults to 4 MiB. */
  readonly pcmChunkBytes?: number;
  /**
   * A thrown listener error rejects the operation; Worker-backed clients also
   * request cancellation.
   */
  readonly onProgress?: (progress: AudioStreamProgress) => void;
  /**
   * Cancels queued or running work. Rejection uses `OPERATION_ABORTED`; a
   * transcoding operation also aborts its output stream until the final close
   * begins. A cancellation arriving after that irreversible commit point does
   * not override the destination close result. No wall-clock deadline is added;
   * UI probes should compose this signal with an application deadline.
   */
  readonly signal?: AbortSignal;
}

export interface AudioStreamInspection extends AudioInspection {
  readonly size: number;
}

export interface AudioStreamSupportedInputResult {
  /** Header recognition and decode support were confirmed for this file. */
  readonly status: 'supported';
  readonly inspection: AudioStreamInspection;
}

export interface AudioStreamRecognizedUnsupportedInputResult {
  /** The container was recognized, but this runtime cannot decode its codec. */
  readonly status: 'recognized-unsupported';
  readonly inspection: AudioStreamInspection;
}

export interface AudioStreamUnsupportedInputResult {
  /** No installed input adapter recognized the file headers. */
  readonly status: 'unsupported';
  readonly inspection: null;
}

/** Result of probing one file with bounded decoder validation when required. */
export type AudioStreamInputSupportResult =
  | AudioStreamRecognizedUnsupportedInputResult
  | AudioStreamSupportedInputResult
  | AudioStreamUnsupportedInputResult;

interface AudioStreamTranscodeResultBase {
  readonly bytesWritten: number;
  readonly channels: number;
  readonly durationSeconds: number;
  readonly preset: AudioOutputPreset;
  readonly sampleRate: number;
}

export interface AudioStreamWavTranscodeResult
  extends AudioStreamTranscodeResultBase {
  readonly details: Readonly<{ readonly format: 'wav'; readonly rf64: boolean }>;
  readonly format: 'wav';
  /** @deprecated Use `details.rf64`. Retained for WAV source compatibility. */
  readonly rf64: boolean;
}

export interface AudioStreamNonWavTranscodeResult
  extends AudioStreamTranscodeResultBase {
  readonly details: Readonly<{
    readonly format: Exclude<AudioStreamOutputFormatId, 'wav'>;
  }>;
  readonly format: Exclude<AudioStreamOutputFormatId, 'wav'>;
  readonly rf64?: undefined;
}

/** Result discriminated by output format; WAV-only details stay WAV-only. */
export type AudioStreamTranscodeResult =
  | AudioStreamNonWavTranscodeResult
  | AudioStreamWavTranscodeResult;

export interface AudioTranscoderStreamEngine {
  getCapabilities(): AudioTranscoderStreamCapabilities;
  getInfo(): AudioTranscoderEngineInfo;
  getVersion(): string;
  /** Reads only the metadata needed to identify and describe the source. */
  inspect(
    input: AudioStreamInput,
    options?: AudioStreamOperationOptions,
  ): Promise<AudioStreamInspection>;
  /**
   * Probes headers and validates the installed decoder with at most the first
   * decoded sample inside the configured read budget. Support states resolve as
   * values. Browser decoder checks honor `options.signal`; use an application
   * deadline because browser codec APIs are runtime-owned.
   *
   * @throws Invalid input or options, `OPERATION_ABORTED`,
   * `RESOURCE_LIMIT_EXCEEDED`, or `QUEUE_CAPACITY_EXCEEDED` for rejected
   * control flow. Worker-backed implementations may also reject with Worker
   * lifecycle errors.
   */
  probeInputSupport(
    input: AudioStreamInput,
    options?: AudioStreamOperationOptions,
  ): Promise<AudioStreamInputSupportResult>;
  /**
   * Validates the exact target against `getCapabilities()`, then performs a
   * tiny discard-only encode to verify the current codec runtime. Only
   * successful exact targets are cached, with at most 32 retained per engine or
   * pool. Static mismatches and `runtime-unavailable` outcomes are not cached;
   * runtime-unavailable targets may be retried. Distinct runtime probes execute
   * serially with at most 8 unique targets waiting, and identical in-flight
   * targets are coalesced.
   *
   * Support verdicts resolve as values.
   *
   * @throws `INVALID_CONFIGURATION`, `OPERATION_ABORTED`,
   * `QUEUE_CAPACITY_EXCEEDED`, or `RESOURCE_LIMIT_EXCEEDED` for rejected
   * control flow. Worker-backed implementations may also reject with Worker
   * lifecycle errors.
   */
  probeOutputSupport(
    target: AudioStreamOutputProbeTarget,
    options?: AudioStreamOutputProbeOptions,
  ): Promise<AudioStreamOutputSupportResult>;
  /**
   * Decodes, optionally resamples, and writes with bounded memory. The output
   * stream is closed on success and aborted on cancellation or failure until
   * the final close begins. That close is an irreversible, success-wins commit
   * point. The operation owns its writer lock until the returned promise
   * settles.
   *
   * @throws `UNSUPPORTED_INPUT` or `UNSUPPORTED_OUTPUT` when the selected
   * source or target cannot be transcoded. Invalid configuration, cancellation,
   * resource or queue limits, and Worker lifecycle failures also reject.
   */
  transcode(
    input: AudioStreamInput,
    target: AudioStreamTarget,
    output: AudioStreamOutput,
    options?: AudioStreamOperationOptions,
  ): Promise<AudioStreamTranscodeResult>;
}

export interface AudioTranscoderStreamWorkerEngine
  extends AudioTranscoderStreamEngine {
  /**
   * Cancels pending work and resolves after output aborts release writer locks.
   * The instance is terminal. Repeated calls return the same promise. After a
   * running abort, standalone consumers should dispose this engine before
   * creating a replacement; Worker pools retire the affected slot automatically.
   */
  dispose(): Promise<void>;
  /** Starts terminal cleanup without waiting for output writer lock release. */
  terminate(): void;
}

interface AudioTranscoderStreamWorkerCommonOptions {
  /** Waiting jobs retained after the active job. Defaults to 8; maximum 64. */
  readonly maxQueued?: number;
}

/** Uses the package Worker runtime and its matching built-in capabilities. */
export interface AudioTranscoderDefaultStreamWorkerRuntimeOptions<
  WorkerFactory = () => Worker,
> {
  /** Explicit runtime asset delivery and loading-state policy. */
  readonly codecAssets: import('../assets/audio-codec-assets.js').AudioTranscoderCodecAssetsConfiguration;
  readonly capabilities?: never;
  readonly runtime?: 'default';
  /**
   * Supplies a module Worker for custom URLs or CSP handling. Import
   * `@echovisionlab/audio-transcoder/stream-worker` from that entry module.
   */
  readonly workerFactory?: WorkerFactory;
}

/** Couples a custom capability manifest to its matching custom Worker runtime. */
export interface AudioTranscoderCustomStreamWorkerRuntimeOptions<
  WorkerFactory = () => Worker,
> {
  readonly codecAssets?: never;
  readonly capabilities: AudioTranscoderStreamCapabilities;
  readonly runtime: 'custom';
  /**
   * Every Worker returned by this factory, including every indexed pool slot,
   * must implement this exact capability manifest and custom runtime contract.
   */
  readonly workerFactory: WorkerFactory;
}

export type AudioTranscoderStreamWorkerRuntimeOptions<
  WorkerFactory = () => Worker,
> =
  | AudioTranscoderCustomStreamWorkerRuntimeOptions<WorkerFactory>
  | AudioTranscoderDefaultStreamWorkerRuntimeOptions<WorkerFactory>;

export type CreateAudioTranscoderStreamWorkerEngineOptions =
  AudioTranscoderStreamWorkerCommonOptions &
    AudioTranscoderStreamWorkerRuntimeOptions;
