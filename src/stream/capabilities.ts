import {
  AAC_OUTPUT_PRESET_DESCRIPTORS,
  AIFF_STREAM_OUTPUT_PRESET_DESCRIPTORS,
  FLAC_OUTPUT_PRESET_DESCRIPTORS,
  MP3_OUTPUT_PRESET_DESCRIPTORS,
  OGG_OPUS_OUTPUT_PRESET_DESCRIPTORS,
  STREAM_OUTPUT_PRESETS,
  WAV_STREAM_OUTPUT_PRESET_DESCRIPTORS,
  type StreamLosslessOutputPresetDescriptor,
  type StreamLossyOutputPresetDescriptor,
  type StreamOutputFormatId,
  type StreamOutputPreset,
} from '../codecs/stream-output-presets.js';
import type { AudioOutputPreset } from '../engine/contracts.js';
import { DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS } from './runtime/ids.js';

export type AudioStreamInputCapabilityPath =
  | 'built-in-pcm'
  | 'runtime-probed';

/**
 * Extension-only input summary retained for 0.0.2 consumers. Extensions are
 * discovery hints and never prove that a concrete file is decodable.
 *
 * @deprecated Use `AudioTranscoderStreamCapabilities.inputFormats` and
 * `AudioTranscoderStreamEngine.probeInputSupport()`.
 */
export interface AudioStreamInputCapability {
  readonly extensions: readonly string[];
  readonly path: AudioStreamInputCapabilityPath;
}

interface AudioStreamInputFormatDescriptorBase {
  readonly adapterId: string;
  readonly container: string;
  /** Filename hints for pickers and UI labels, not support assertions. */
  readonly extensionHints: readonly string[];
  readonly id: string;
  /** MIME hints for pickers and UI labels, not support assertions. */
  readonly mimeTypeHints: readonly string[];
}

/** A matching PCM header is decoded by code bundled with this package. */
export interface AudioStreamBuiltInInputFormatDescriptor
  extends AudioStreamInputFormatDescriptorBase {
  readonly path: 'built-in-pcm';
}

/** The installed parser probes headers and the current runtime probes decode support. */
export interface AudioStreamRuntimeInputFormatDescriptor
  extends AudioStreamInputFormatDescriptorBase {
  readonly path: 'runtime-probed';
}

/** Immutable description of an installed input recognition path. */
export type AudioStreamInputFormatDescriptor =
  | AudioStreamBuiltInInputFormatDescriptor
  | AudioStreamRuntimeInputFormatDescriptor;

/** Exact preset union produced by the installed streaming encoder. */
export type AudioStreamOutputPreset =
  StreamOutputPreset;

interface AudioStreamOutputPresetDescriptorBase {
  readonly codec: string;
  readonly preset: AudioOutputPreset;
  /** Exact target values accepted by this preset's encoder path. */
  readonly target: AudioStreamOutputTargetConstraints;
}

export interface AudioStreamOutputChannelConstraints {
  readonly maximum: number;
  readonly minimum: number;
}

export interface AudioStreamOutputSampleRateRange {
  readonly kind: 'range';
  readonly maximum: number;
  readonly minimum: number;
}

export interface AudioStreamOutputSampleRateSet {
  readonly kind: 'discrete';
  readonly values: readonly number[];
}

/** Sample rates accepted by one output preset. */
export type AudioStreamOutputSampleRateConstraints =
  | AudioStreamOutputSampleRateRange
  | AudioStreamOutputSampleRateSet;

export interface AudioStreamOutputTargetConstraints {
  readonly channels: AudioStreamOutputChannelConstraints;
  readonly sampleRate: AudioStreamOutputSampleRateConstraints;
}

/** Float32 pipeline precision after accounting for the selected output preset. */
export interface AudioStreamProcessingPrecision {
  /** Maximum integer-source precision retained by processing and encoding. */
  readonly effectiveIntegerPrecisionBits: number;
  readonly sampleFormat: 'float32';
}

/** A lossless preset whose encoded container precision is fixed. */
export interface AudioStreamLosslessOutputPresetDescriptor
  extends AudioStreamOutputPresetDescriptorBase {
  /** Encoded container depth; this alone does not promise preserved precision. */
  readonly bitDepth: number;
  readonly kind: 'lossless';
  readonly preset: AudioOutputPreset & {
    readonly bitDepth: number;
    readonly sampleFormat: 'float' | 'integer';
  };
  readonly processingPrecision: AudioStreamProcessingPrecision;
}

/** A lossy preset whose target bitrate is fixed in bits per second. */
export interface AudioStreamLossyOutputPresetDescriptor
  extends AudioStreamOutputPresetDescriptorBase {
  readonly bitrate: number;
  /** Codec rate-control mode used by this exact preset. */
  readonly bitrateMode: 'constant' | 'variable';
  readonly kind: 'lossy';
  readonly preset: AudioOutputPreset & {
    readonly bitDepth: null;
    readonly sampleFormat: 'lossy';
  };
}

/** Exact encoding parameters represented by one public preset ID. */
export type AudioStreamOutputPresetDescriptor =
  | AudioStreamLosslessOutputPresetDescriptor
  | AudioStreamLossyOutputPresetDescriptor;

export type AudioStreamOutputImplementation = 'built-in' | 'runtime-asset';
export type AudioStreamOutputLoading = 'eager' | 'lazy';
export type AudioStreamOutputStreamingMode = 'bounded-memory';
/** Known format IDs; installed availability is determined by `outputFormats`. */
export type AudioStreamOutputFormatId = StreamOutputFormatId;

interface AudioStreamOutputFormatDescriptorBase {
  readonly container: string;
  readonly extension: string;
  readonly id: AudioStreamOutputFormatId;
  readonly mimeType: string;
  readonly presets: readonly AudioStreamOutputPresetDescriptor[];
  readonly requiresSeekableOutput: boolean;
  readonly streaming: AudioStreamOutputStreamingMode;
}

/** Output implemented by code loaded with the core Worker module. */
export interface AudioStreamBuiltInOutputFormatDescriptor
  extends AudioStreamOutputFormatDescriptorBase {
  readonly implementation: 'built-in';
  readonly loading: 'eager';
}

/** Output implemented by a separately delivered runtime asset loaded on first use. */
export interface AudioStreamRuntimeAssetOutputFormatDescriptor
  extends AudioStreamOutputFormatDescriptorBase {
  readonly implementation: 'runtime-asset';
  readonly loading: 'lazy';
}

/**
 * Deterministic output support declared by this build. Runtime-probed
 * candidates must not be included in this list.
 */
export type AudioStreamOutputFormatDescriptor =
  | AudioStreamBuiltInOutputFormatDescriptor
  | AudioStreamRuntimeAssetOutputFormatDescriptor;

export interface AudioStreamLimits {
  /** Per-read and per-yield allocation bounds, not a total working-set limit. */
  readonly buffers: {
    readonly defaultInputReadBytes: number;
    readonly defaultOutputChunkBytes: number;
    readonly defaultPcmChunkBytes: number;
    readonly maximumBytes: number;
    readonly minimumBytes: number;
  };
  readonly channels: { readonly maximum: number; readonly minimum: number };
  /** Hard upper bound accepted by the stream Worker pool. */
  readonly maximumConcurrency: number;
  readonly queue: {
    readonly defaultMaximumQueued: number;
    readonly maximumQueued: number;
  };
  readonly recommendedConcurrency: number;
  readonly sampleRate: {
    /** @deprecated Use `passThrough`. */
    readonly maximum: number;
    /** @deprecated Use `passThrough`. */
    readonly minimum: number;
    /** Accepted source rates and same-rate output rates. */
    readonly passThrough: {
      readonly maximum: number;
      readonly minimum: number;
    };
    /** Source and target range when sample-rate conversion is required. */
    readonly resampling: {
      readonly maximum: number;
      readonly minimum: number;
    };
  };
}

export interface AudioStreamCodecRuntimeCapability {
  readonly encoderAdapter: string;
  readonly inputAdapters: readonly string[];
  readonly resamplerAdapter: string;
}

export interface AudioTranscoderStreamCapabilities {
  readonly codecRuntime: AudioStreamCodecRuntimeCapability;
  /** Installed parsers and their support decision paths. */
  readonly inputFormats: readonly AudioStreamInputFormatDescriptor[];
  /**
   * Extension-only compatibility view. Values are hints, not file support.
   *
   * @deprecated Use `inputFormats` and probe each concrete file.
   */
  readonly inputs: readonly AudioStreamInputCapability[];
  readonly limits: AudioStreamLimits;
  /** Installed output containers with per-format sink requirements. */
  readonly outputFormats: readonly AudioStreamOutputFormatDescriptor[];
  /** Exact presets accepted by `AudioStreamTarget.presetId`. */
  readonly outputPresets: readonly AudioStreamOutputPreset[];
  /**
   * WAV-only compatibility alias. Future formats may have different sink needs.
   *
   * @deprecated Read `outputFormats[].requiresSeekableOutput`.
   */
  readonly requiresSeekableOutput: true;
}

const BUILT_IN_INPUT_ADAPTER =
  DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS.inputAdapters[0];
const RUNTIME_INPUT_ADAPTER =
  DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS.inputAdapters[1];

export const AUDIO_STREAM_INPUT_FORMATS = Object.freeze([
  inputFormat({
    adapterId: BUILT_IN_INPUT_ADAPTER,
    container: 'CAF',
    extensionHints: ['caf'],
    id: 'caf-lpcm',
    mimeTypeHints: ['audio/x-caf'],
    path: 'built-in-pcm',
  }),
  inputFormat({
    adapterId: BUILT_IN_INPUT_ADAPTER,
    container: 'AIFF',
    extensionHints: ['aif', 'aiff'],
    id: 'aiff-pcm',
    mimeTypeHints: ['audio/aiff', 'audio/x-aiff'],
    path: 'built-in-pcm',
  }),
  inputFormat({
    adapterId: BUILT_IN_INPUT_ADAPTER,
    container: 'AIFC',
    extensionHints: ['aifc'],
    id: 'aifc-pcm',
    mimeTypeHints: ['audio/aiff', 'audio/x-aiff'],
    path: 'built-in-pcm',
  }),
  inputFormat({
    adapterId: RUNTIME_INPUT_ADAPTER,
    container: 'MP4',
    extensionHints: ['m4a', 'mp4'],
    id: 'mp4',
    mimeTypeHints: ['audio/mp4', 'video/mp4'],
    path: 'runtime-probed',
  }),
  inputFormat({
    adapterId: RUNTIME_INPUT_ADAPTER,
    container: 'QuickTime File Format',
    extensionHints: ['mov', 'qt'],
    id: 'quicktime',
    mimeTypeHints: ['audio/quicktime', 'video/quicktime'],
    path: 'runtime-probed',
  }),
  inputFormat({
    adapterId: RUNTIME_INPUT_ADAPTER,
    container: 'Matroska',
    extensionHints: ['mka', 'mkv'],
    id: 'matroska',
    mimeTypeHints: ['audio/x-matroska', 'video/x-matroska'],
    path: 'runtime-probed',
  }),
  inputFormat({
    adapterId: RUNTIME_INPUT_ADAPTER,
    container: 'WebM',
    extensionHints: ['webm'],
    id: 'webm',
    mimeTypeHints: ['audio/webm', 'video/webm'],
    path: 'runtime-probed',
  }),
  inputFormat({
    adapterId: RUNTIME_INPUT_ADAPTER,
    container: 'WAVE',
    extensionHints: ['wav', 'wave'],
    id: 'wave',
    mimeTypeHints: ['audio/wav', 'audio/x-wav'],
    path: 'runtime-probed',
  }),
  inputFormat({
    adapterId: RUNTIME_INPUT_ADAPTER,
    container: 'Ogg',
    extensionHints: ['oga', 'ogg', 'opus'],
    id: 'ogg',
    mimeTypeHints: ['application/ogg', 'audio/ogg'],
    path: 'runtime-probed',
  }),
  inputFormat({
    adapterId: RUNTIME_INPUT_ADAPTER,
    container: 'FLAC',
    extensionHints: ['flac'],
    id: 'flac',
    mimeTypeHints: ['audio/flac'],
    path: 'runtime-probed',
  }),
  inputFormat({
    adapterId: RUNTIME_INPUT_ADAPTER,
    container: 'MP3',
    extensionHints: ['mp3'],
    id: 'mp3',
    mimeTypeHints: ['audio/mpeg'],
    path: 'runtime-probed',
  }),
  inputFormat({
    adapterId: RUNTIME_INPUT_ADAPTER,
    container: 'ADTS',
    extensionHints: ['aac', 'adts'],
    id: 'adts',
    mimeTypeHints: ['audio/aac'],
    path: 'runtime-probed',
  }),
  inputFormat({
    adapterId: RUNTIME_INPUT_ADAPTER,
    container: 'MPEG Transport Stream',
    extensionHints: ['ts'],
    id: 'mpeg-ts',
    mimeTypeHints: ['video/mp2t'],
    path: 'runtime-probed',
  }),
] as const satisfies readonly AudioStreamInputFormatDescriptor[]);

export type AudioStreamInputFormatId =
  (typeof AUDIO_STREAM_INPUT_FORMATS)[number]['id'];

const WAV_OUTPUT_PRESETS = Object.freeze([
  losslessOutputPreset(WAV_STREAM_OUTPUT_PRESET_DESCRIPTORS[0]),
  losslessOutputPreset(WAV_STREAM_OUTPUT_PRESET_DESCRIPTORS[1]),
  losslessOutputPreset(WAV_STREAM_OUTPUT_PRESET_DESCRIPTORS[2]),
  losslessOutputPreset(WAV_STREAM_OUTPUT_PRESET_DESCRIPTORS[3]),
] as const);

const AIFF_OUTPUT_PRESETS = Object.freeze([
  losslessOutputPreset(AIFF_STREAM_OUTPUT_PRESET_DESCRIPTORS[0]),
  losslessOutputPreset(AIFF_STREAM_OUTPUT_PRESET_DESCRIPTORS[1]),
] as const);

const AAC_OUTPUT_PRESETS = Object.freeze([
  lossyOutputPreset(AAC_OUTPUT_PRESET_DESCRIPTORS[0]),
  lossyOutputPreset(AAC_OUTPUT_PRESET_DESCRIPTORS[1]),
  lossyOutputPreset(AAC_OUTPUT_PRESET_DESCRIPTORS[2]),
  lossyOutputPreset(AAC_OUTPUT_PRESET_DESCRIPTORS[3]),
] as const);

const OGG_OPUS_OUTPUT_PRESETS = Object.freeze([
  lossyOutputPreset(OGG_OPUS_OUTPUT_PRESET_DESCRIPTORS[0]),
  lossyOutputPreset(OGG_OPUS_OUTPUT_PRESET_DESCRIPTORS[1]),
  lossyOutputPreset(OGG_OPUS_OUTPUT_PRESET_DESCRIPTORS[2]),
  lossyOutputPreset(OGG_OPUS_OUTPUT_PRESET_DESCRIPTORS[3]),
] as const);

const MP3_OUTPUT_PRESETS = Object.freeze([
  lossyOutputPreset(MP3_OUTPUT_PRESET_DESCRIPTORS[0]),
  lossyOutputPreset(MP3_OUTPUT_PRESET_DESCRIPTORS[1]),
  lossyOutputPreset(MP3_OUTPUT_PRESET_DESCRIPTORS[2]),
  lossyOutputPreset(MP3_OUTPUT_PRESET_DESCRIPTORS[3]),
] as const);

const FLAC_OUTPUT_PRESETS = Object.freeze([
  losslessOutputPreset(FLAC_OUTPUT_PRESET_DESCRIPTORS[0]),
  losslessOutputPreset(FLAC_OUTPUT_PRESET_DESCRIPTORS[1]),
] as const);

export const AUDIO_STREAM_OUTPUT_FORMATS = Object.freeze([
  Object.freeze({
    container: 'wav',
    extension: 'wav',
    id: 'wav',
    implementation: 'built-in',
    loading: 'eager',
    mimeType: 'audio/wav',
    presets: WAV_OUTPUT_PRESETS,
    requiresSeekableOutput: true,
    streaming: 'bounded-memory',
  }),
  Object.freeze({
    container: 'aiff',
    extension: 'aiff',
    id: 'aiff',
    implementation: 'built-in',
    loading: 'eager',
    mimeType: 'audio/aiff',
    presets: AIFF_OUTPUT_PRESETS,
    requiresSeekableOutput: true,
    streaming: 'bounded-memory',
  }),
  Object.freeze({
    container: 'adts',
    extension: 'aac',
    id: 'aac',
    implementation: 'runtime-asset',
    loading: 'lazy',
    mimeType: 'audio/aac',
    presets: AAC_OUTPUT_PRESETS,
    requiresSeekableOutput: false,
    streaming: 'bounded-memory',
  }),
  Object.freeze({
    container: 'ogg',
    extension: 'ogg',
    id: 'ogg',
    implementation: 'runtime-asset',
    loading: 'lazy',
    mimeType: 'audio/ogg',
    presets: OGG_OPUS_OUTPUT_PRESETS,
    requiresSeekableOutput: false,
    streaming: 'bounded-memory',
  }),
  Object.freeze({
    container: 'mp3',
    extension: 'mp3',
    id: 'mp3',
    implementation: 'runtime-asset',
    loading: 'lazy',
    mimeType: 'audio/mpeg',
    presets: MP3_OUTPUT_PRESETS,
    requiresSeekableOutput: true,
    streaming: 'bounded-memory',
  }),
  Object.freeze({
    container: 'flac',
    extension: 'flac',
    id: 'flac',
    implementation: 'runtime-asset',
    loading: 'lazy',
    mimeType: 'audio/flac',
    presets: FLAC_OUTPUT_PRESETS,
    requiresSeekableOutput: true,
    streaming: 'bounded-memory',
  }),
] as const satisfies readonly AudioStreamOutputFormatDescriptor[]);

const LEGACY_INPUT_CAPABILITIES = Object.freeze([
  Object.freeze({
    extensions: Object.freeze(['aif', 'aifc', 'aiff', 'caf']),
    path: 'built-in-pcm' as const,
  }),
  Object.freeze({
    extensions: Object.freeze([
      'aac',
      'adts',
      'flac',
      'm4a',
      'mka',
      'mkv',
      'mov',
      'mp3',
      'mp4',
      'oga',
      'ogg',
      'opus',
      'qt',
      'ts',
      'wav',
      'wave',
      'webm',
    ]),
    path: 'runtime-probed' as const,
  }),
]);

export const AUDIO_TRANSCODER_STREAM_CAPABILITIES = Object.freeze({
  codecRuntime: DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS,
  inputFormats: AUDIO_STREAM_INPUT_FORMATS,
  inputs: LEGACY_INPUT_CAPABILITIES,
  limits: Object.freeze({
    buffers: Object.freeze({
      defaultInputReadBytes: 8 * 1024 * 1024,
      defaultOutputChunkBytes: 4 * 1024 * 1024,
      defaultPcmChunkBytes: 4 * 1024 * 1024,
      maximumBytes: 64 * 1024 * 1024,
      minimumBytes: 64 * 1024,
    }),
    channels: Object.freeze({ maximum: 32, minimum: 1 }),
    maximumConcurrency: 4,
    queue: Object.freeze({ defaultMaximumQueued: 8, maximumQueued: 64 }),
    recommendedConcurrency: 1,
    sampleRate: Object.freeze({
      maximum: 384_000,
      minimum: 8_000,
      passThrough: Object.freeze({ maximum: 384_000, minimum: 8_000 }),
      resampling: Object.freeze({ maximum: 192_000, minimum: 8_000 }),
    }),
  }),
  outputFormats: AUDIO_STREAM_OUTPUT_FORMATS,
  outputPresets: STREAM_OUTPUT_PRESETS as readonly AudioStreamOutputPreset[],
  requiresSeekableOutput: true,
}) satisfies AudioTranscoderStreamCapabilities;

function inputFormat<const Descriptor extends AudioStreamInputFormatDescriptor>(
  descriptor: Descriptor,
): Readonly<Descriptor> {
  return Object.freeze({
    ...descriptor,
    extensionHints: Object.freeze(descriptor.extensionHints),
    mimeTypeHints: Object.freeze(descriptor.mimeTypeHints),
  }) as Readonly<Descriptor>;
}

function losslessOutputPreset<
  const Descriptor extends StreamLosslessOutputPresetDescriptor,
>(descriptor: Descriptor): Readonly<{
  readonly bitDepth: Descriptor['bitDepth'];
  readonly codec: Descriptor['codec'];
  readonly kind: 'lossless';
  readonly preset: Descriptor['preset'];
  readonly processingPrecision: AudioStreamProcessingPrecision;
  readonly target: AudioStreamOutputTargetConstraints;
}> {
  return Object.freeze({
    bitDepth: descriptor.bitDepth,
    codec: descriptor.codec,
    kind: 'lossless' as const,
    preset: descriptor.preset,
    processingPrecision: Object.freeze({
      effectiveIntegerPrecisionBits: Math.min(descriptor.bitDepth, 24),
      sampleFormat: 'float32' as const,
    }),
    target: descriptor.constraints,
  }) as Readonly<{
    readonly bitDepth: Descriptor['bitDepth'];
    readonly codec: Descriptor['codec'];
    readonly kind: 'lossless';
    readonly preset: Descriptor['preset'];
    readonly processingPrecision: AudioStreamProcessingPrecision;
    readonly target: AudioStreamOutputTargetConstraints;
  }>;
}

function lossyOutputPreset<
  const Descriptor extends StreamLossyOutputPresetDescriptor,
>(descriptor: Descriptor): Readonly<{
  readonly bitrate: Descriptor['bitrate'];
  readonly bitrateMode: Descriptor['bitrateMode'];
  readonly codec: Descriptor['codec'];
  readonly kind: 'lossy';
  readonly preset: Descriptor['preset'];
  readonly target: AudioStreamOutputTargetConstraints;
}> {
  return Object.freeze({
    bitrate: descriptor.bitrate,
    bitrateMode: descriptor.bitrateMode,
    codec: descriptor.codec,
    kind: 'lossy' as const,
    preset: descriptor.preset,
    target: descriptor.constraints,
  });
}
