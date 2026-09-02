import type { AudioEncodingConfig } from 'mediabunny';
import type { AudioOutputPreset } from '../engine/contracts.js';
import { AIFF_OUTPUT_PRESETS } from './aiff.js';
import {
  WAV_OUTPUT_PRESET_DESCRIPTORS,
  type WavOutputPresetDescriptor,
} from './wav-presets.js';

export type BundledWasmOutputCodec = 'aac' | 'flac' | 'mp3' | 'ogg-opus';
export type StreamOutputFormatId =
  | 'aac'
  | 'aiff'
  | 'flac'
  | 'mp3'
  | 'ogg'
  | 'wav';

export interface StreamOutputChannelConstraints {
  readonly maximum: number;
  readonly minimum: number;
}

export interface StreamOutputDiscreteSampleRateConstraints {
  readonly kind: 'discrete';
  readonly values: readonly number[];
}

export interface StreamOutputRangeSampleRateConstraints {
  readonly kind: 'range';
  readonly maximum: number;
  readonly minimum: number;
}

export interface StreamOutputCodecConstraints {
  readonly channels: StreamOutputChannelConstraints;
  readonly sampleRate:
    | StreamOutputDiscreteSampleRateConstraints
    | StreamOutputRangeSampleRateConstraints;
}

export const MP3_128KBPS_OUTPUT_SAMPLE_RATES = Object.freeze([
  16_000,
  22_050,
  24_000,
  32_000,
  44_100,
  48_000,
] as const);

export const MP3_HIGH_BITRATE_OUTPUT_SAMPLE_RATES = Object.freeze([
  32_000,
  44_100,
  48_000,
] as const);

export const FLAC_OUTPUT_SAMPLE_RATES = Object.freeze([
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
] as const);

export const AAC_OUTPUT_SAMPLE_RATES = Object.freeze([
  32_000,
  44_100,
  48_000,
] as const);

export const OGG_OPUS_OUTPUT_SAMPLE_RATES = Object.freeze([48_000] as const);

export const WAV_OUTPUT_CODEC_CONSTRAINTS = rangeCodecConstraints(
  1,
  32,
  8_000,
  384_000,
);

export const AIFF_OUTPUT_CODEC_CONSTRAINTS = rangeCodecConstraints(
  1,
  32,
  8_000,
  384_000,
);

export const MP3_128KBPS_OUTPUT_CODEC_CONSTRAINTS = discreteCodecConstraints(
  1,
  2,
  MP3_128KBPS_OUTPUT_SAMPLE_RATES,
);

export const MP3_HIGH_BITRATE_OUTPUT_CODEC_CONSTRAINTS = discreteCodecConstraints(
  1,
  2,
  MP3_HIGH_BITRATE_OUTPUT_SAMPLE_RATES,
);

export const FLAC_OUTPUT_CODEC_CONSTRAINTS = discreteCodecConstraints(
  1,
  8,
  FLAC_OUTPUT_SAMPLE_RATES,
);

export const AAC_OUTPUT_CODEC_CONSTRAINTS = discreteCodecConstraints(
  1,
  2,
  AAC_OUTPUT_SAMPLE_RATES,
);

export const OGG_OPUS_OUTPUT_CODEC_CONSTRAINTS = discreteCodecConstraints(
  1,
  2,
  OGG_OPUS_OUTPUT_SAMPLE_RATES,
);

interface StreamOutputPresetDescriptorBase {
  readonly codec: string;
  readonly constraints: StreamOutputCodecConstraints;
  /** Exact MediaBunny configuration, or `null` for a built-in stream writer. */
  readonly encoding: Readonly<AudioEncodingConfig> | null;
  readonly format: StreamOutputFormatId;
  readonly preset: AudioOutputPreset;
  /** Runtime-asset extension loaded before creating the encoder, or `null` when eager. */
  readonly wasmCodec: BundledWasmOutputCodec | null;
}

export interface StreamLosslessOutputPresetDescriptor
  extends StreamOutputPresetDescriptorBase {
  readonly bitDepth: 16 | 24 | 32;
  readonly integer: boolean;
  readonly kind: 'lossless';
  readonly preset: AudioOutputPreset & {
    readonly bitDepth: 16 | 24 | 32;
    readonly sampleFormat: 'float' | 'integer';
  };
}

export interface StreamLossyOutputPresetDescriptor
  extends StreamOutputPresetDescriptorBase {
  readonly bitrate: number;
  readonly bitrateMode: 'constant' | 'variable';
  readonly kind: 'lossy';
  readonly preset: AudioOutputPreset & {
    readonly bitDepth: null;
    readonly sampleFormat: 'lossy';
  };
}

export type StreamOutputPresetDescriptor =
  | StreamLosslessOutputPresetDescriptor
  | StreamLossyOutputPresetDescriptor;

export const WAV_STREAM_OUTPUT_PRESET_DESCRIPTORS = Object.freeze([
  defineWavPreset(WAV_OUTPUT_PRESET_DESCRIPTORS[0]),
  defineWavPreset(WAV_OUTPUT_PRESET_DESCRIPTORS[1]),
  defineWavPreset(WAV_OUTPUT_PRESET_DESCRIPTORS[2]),
  defineWavPreset(WAV_OUTPUT_PRESET_DESCRIPTORS[3]),
] as const);

export const AIFF_STREAM_OUTPUT_PRESET_DESCRIPTORS = Object.freeze([
  defineAiffPreset('aiff-pcm16', 16, 'pcm-s16be'),
  defineAiffPreset('aiff-pcm24', 24, 'pcm-s24be'),
] as const);

export const AAC_OUTPUT_PRESET_DESCRIPTORS = Object.freeze([
  defineAacPreset('aac-96kbps', 96_000),
  defineAacPreset('aac-128kbps', 128_000),
  defineAacPreset('aac-192kbps', 192_000),
  defineAacPreset('aac-256kbps', 256_000),
] as const);

export const OGG_OPUS_OUTPUT_PRESET_DESCRIPTORS = Object.freeze([
  defineOggOpusPreset('ogg-opus-64kbps', 64_000),
  defineOggOpusPreset('ogg-opus-96kbps', 96_000),
  defineOggOpusPreset('ogg-opus-128kbps', 128_000),
  defineOggOpusPreset('ogg-opus-192kbps', 192_000),
] as const);

export const MP3_OUTPUT_PRESET_DESCRIPTORS = Object.freeze([
  defineMp3Preset(
    'mp3-128kbps',
    128_000,
    MP3_128KBPS_OUTPUT_CODEC_CONSTRAINTS,
  ),
  defineMp3Preset(
    'mp3-192kbps',
    192_000,
    MP3_HIGH_BITRATE_OUTPUT_CODEC_CONSTRAINTS,
  ),
  defineMp3Preset(
    'mp3-256kbps',
    256_000,
    MP3_HIGH_BITRATE_OUTPUT_CODEC_CONSTRAINTS,
  ),
  defineMp3Preset(
    'mp3-320kbps',
    320_000,
    MP3_HIGH_BITRATE_OUTPUT_CODEC_CONSTRAINTS,
  ),
] as const);

export const FLAC_OUTPUT_PRESET_DESCRIPTORS = Object.freeze([
  defineFlacPreset('flac-16bit', 16, 's16'),
  defineFlacPreset('flac-24bit', 24, 's32'),
] as const);

export const STREAM_OUTPUT_PRESET_DESCRIPTORS = Object.freeze([
  ...WAV_STREAM_OUTPUT_PRESET_DESCRIPTORS,
  ...AIFF_STREAM_OUTPUT_PRESET_DESCRIPTORS,
  ...AAC_OUTPUT_PRESET_DESCRIPTORS,
  ...OGG_OPUS_OUTPUT_PRESET_DESCRIPTORS,
  ...MP3_OUTPUT_PRESET_DESCRIPTORS,
  ...FLAC_OUTPUT_PRESET_DESCRIPTORS,
] as const satisfies readonly StreamOutputPresetDescriptor[]);

export type StreamOutputPreset =
  (typeof STREAM_OUTPUT_PRESET_DESCRIPTORS)[number]['preset'];
export type StreamOutputPresetId = StreamOutputPreset['id'];

export const STREAM_OUTPUT_PRESETS: readonly StreamOutputPreset[] =
  Object.freeze(
    STREAM_OUTPUT_PRESET_DESCRIPTORS.map(({ preset }) => preset),
  );

export function findStreamOutputPresetDescriptor(
  presetId: string,
): StreamOutputPresetDescriptor | undefined {
  return STREAM_OUTPUT_PRESET_DESCRIPTORS.find(
    ({ preset }) => preset.id === presetId,
  );
}

export function isStreamOutputConfigurationSupported(
  descriptor: StreamOutputPresetDescriptor,
  channels: number,
  sampleRate: number,
): boolean {
  if (
    !Number.isSafeInteger(channels) ||
    !Number.isSafeInteger(sampleRate) ||
    channels < descriptor.constraints.channels.minimum ||
    channels > descriptor.constraints.channels.maximum
  ) {
    return false;
  }

  const sampleRateConstraint = descriptor.constraints.sampleRate;
  return sampleRateConstraint.kind === 'discrete'
    ? sampleRateConstraint.values.includes(sampleRate)
    : sampleRate >= sampleRateConstraint.minimum &&
        sampleRate <= sampleRateConstraint.maximum;
}

function defineWavPreset<const Descriptor extends WavOutputPresetDescriptor>(
  descriptor: Descriptor,
): Readonly<{
  readonly bitDepth: Descriptor['bitDepth'];
  readonly codec: Descriptor['codec'];
  readonly constraints: typeof WAV_OUTPUT_CODEC_CONSTRAINTS;
  readonly encoding: Readonly<{ readonly codec: Descriptor['codec'] }>;
  readonly format: 'wav';
  readonly integer: Descriptor['integer'];
  readonly kind: 'lossless';
  readonly preset: Descriptor['preset'];
  readonly wasmCodec: null;
}> {
  return Object.freeze({
    bitDepth: descriptor.bitDepth,
    codec: descriptor.codec,
    constraints: WAV_OUTPUT_CODEC_CONSTRAINTS,
    encoding: Object.freeze({ codec: descriptor.codec }),
    format: 'wav' as const,
    integer: descriptor.integer,
    kind: 'lossless' as const,
    preset: descriptor.preset,
    wasmCodec: null,
  });
}

function defineAiffPreset<
  const Id extends 'aiff-pcm16' | 'aiff-pcm24',
  const BitDepth extends 16 | 24,
  const Codec extends 'pcm-s16be' | 'pcm-s24be',
>(
  id: Id,
  bitDepth: BitDepth,
  codec: Codec,
): Readonly<{
  readonly bitDepth: BitDepth;
  readonly codec: Codec;
  readonly constraints: typeof AIFF_OUTPUT_CODEC_CONSTRAINTS;
  readonly encoding: null;
  readonly format: 'aiff';
  readonly integer: true;
  readonly kind: 'lossless';
  readonly preset: Readonly<{
    readonly bitDepth: BitDepth;
    readonly container: 'aiff';
    readonly extension: 'aiff';
    readonly id: Id;
    readonly mimeType: 'audio/aiff';
    readonly sampleFormat: 'integer';
  }>;
  readonly wasmCodec: null;
}> {
  const preset = AIFF_OUTPUT_PRESETS.find((candidate) => candidate.id === id);
  if (
    preset === undefined ||
    preset.bitDepth !== bitDepth ||
    preset.container !== 'aiff' ||
    preset.extension !== 'aiff' ||
    preset.mimeType !== 'audio/aiff' ||
    preset.sampleFormat !== 'integer'
  ) {
    throw new Error(`Built-in AIFF preset "${id}" is inconsistent.`);
  }

  return Object.freeze({
    bitDepth,
    codec,
    constraints: AIFF_OUTPUT_CODEC_CONSTRAINTS,
    encoding: null,
    format: 'aiff' as const,
    integer: true,
    kind: 'lossless' as const,
    preset: preset as Readonly<{
      readonly bitDepth: BitDepth;
      readonly container: 'aiff';
      readonly extension: 'aiff';
      readonly id: Id;
      readonly mimeType: 'audio/aiff';
      readonly sampleFormat: 'integer';
    }>,
    wasmCodec: null,
  });
}

function defineAacPreset<
  const Id extends string,
  const Bitrate extends number,
>(
  id: Id,
  bitrate: Bitrate,
): Readonly<{
  readonly bitrate: Bitrate;
  readonly bitrateMode: 'variable';
  readonly codec: 'aac';
  readonly constraints: typeof AAC_OUTPUT_CODEC_CONSTRAINTS;
  readonly encoding: Readonly<{
    readonly bitrate: Bitrate;
    readonly bitrateMode: 'variable';
    readonly codec: 'aac';
  }>;
  readonly format: 'aac';
  readonly kind: 'lossy';
  readonly preset: Readonly<{
    readonly bitDepth: null;
    readonly container: 'adts';
    readonly extension: 'aac';
    readonly id: Id;
    readonly mimeType: 'audio/aac';
    readonly sampleFormat: 'lossy';
  }>;
  readonly wasmCodec: 'aac';
}> {
  return Object.freeze({
    bitrate,
    bitrateMode: 'variable' as const,
    codec: 'aac' as const,
    constraints: AAC_OUTPUT_CODEC_CONSTRAINTS,
    encoding: Object.freeze({
      bitrate,
      bitrateMode: 'variable' as const,
      codec: 'aac' as const,
    }),
    format: 'aac' as const,
    kind: 'lossy' as const,
    preset: Object.freeze({
      bitDepth: null,
      container: 'adts' as const,
      extension: 'aac' as const,
      id,
      mimeType: 'audio/aac' as const,
      sampleFormat: 'lossy' as const,
    }),
    wasmCodec: 'aac' as const,
  });
}

function defineOggOpusPreset<
  const Id extends string,
  const Bitrate extends number,
>(
  id: Id,
  bitrate: Bitrate,
): Readonly<{
  readonly bitrate: Bitrate;
  readonly bitrateMode: 'variable';
  readonly codec: 'opus';
  readonly constraints: typeof OGG_OPUS_OUTPUT_CODEC_CONSTRAINTS;
  readonly encoding: null;
  readonly format: 'ogg';
  readonly kind: 'lossy';
  readonly preset: Readonly<{
    readonly bitDepth: null;
    readonly container: 'ogg';
    readonly extension: 'ogg';
    readonly id: Id;
    readonly mimeType: 'audio/ogg';
    readonly sampleFormat: 'lossy';
  }>;
  readonly wasmCodec: 'ogg-opus';
}> {
  return Object.freeze({
    bitrate,
    bitrateMode: 'variable' as const,
    codec: 'opus' as const,
    constraints: OGG_OPUS_OUTPUT_CODEC_CONSTRAINTS,
    encoding: null,
    format: 'ogg' as const,
    kind: 'lossy' as const,
    preset: Object.freeze({
      bitDepth: null,
      container: 'ogg' as const,
      extension: 'ogg' as const,
      id,
      mimeType: 'audio/ogg' as const,
      sampleFormat: 'lossy' as const,
    }),
    wasmCodec: 'ogg-opus' as const,
  });
}

function defineMp3Preset<
  const Id extends string,
  const Bitrate extends number,
  const Constraints extends StreamOutputCodecConstraints,
>(
  id: Id,
  bitrate: Bitrate,
  constraints: Constraints,
): Readonly<{
  readonly bitrate: Bitrate;
  readonly bitrateMode: 'constant';
  readonly codec: 'mp3';
  readonly constraints: Constraints;
  readonly encoding: Readonly<{
    readonly bitrate: Bitrate;
    readonly bitrateMode: 'constant';
    readonly codec: 'mp3';
    readonly transform: Readonly<{ readonly sampleFormat: 's16' }>;
  }>;
  readonly format: 'mp3';
  readonly kind: 'lossy';
  readonly preset: Readonly<{
    readonly bitDepth: null;
    readonly container: 'mp3';
    readonly extension: 'mp3';
    readonly id: Id;
    readonly mimeType: 'audio/mpeg';
    readonly sampleFormat: 'lossy';
  }>;
  readonly wasmCodec: 'mp3';
}> {
  const transform = Object.freeze({ sampleFormat: 's16' as const });
  return Object.freeze({
    bitrate,
    bitrateMode: 'constant' as const,
    codec: 'mp3' as const,
    constraints,
    encoding: Object.freeze({
      bitrate,
      bitrateMode: 'constant' as const,
      codec: 'mp3' as const,
      transform,
    }),
    format: 'mp3' as const,
    kind: 'lossy' as const,
    preset: Object.freeze({
      bitDepth: null,
      container: 'mp3' as const,
      extension: 'mp3' as const,
      id,
      mimeType: 'audio/mpeg' as const,
      sampleFormat: 'lossy' as const,
    }),
    wasmCodec: 'mp3' as const,
  });
}

function defineFlacPreset<
  const Id extends string,
  const BitDepth extends 16 | 24,
  const SampleFormat extends 's16' | 's32',
>(
  id: Id,
  bitDepth: BitDepth,
  sampleFormat: SampleFormat,
): Readonly<{
  readonly bitDepth: BitDepth;
  readonly codec: 'flac';
  readonly constraints: typeof FLAC_OUTPUT_CODEC_CONSTRAINTS;
  readonly encoding: Readonly<{
    readonly codec: 'flac';
    readonly transform: Readonly<{ readonly sampleFormat: SampleFormat }>;
  }>;
  readonly format: 'flac';
  readonly integer: true;
  readonly kind: 'lossless';
  readonly preset: Readonly<{
    readonly bitDepth: BitDepth;
    readonly container: 'flac';
    readonly extension: 'flac';
    readonly id: Id;
    readonly mimeType: 'audio/flac';
    readonly sampleFormat: 'integer';
  }>;
  readonly wasmCodec: 'flac';
}> {
  const transform = Object.freeze({ sampleFormat });
  return Object.freeze({
    bitDepth,
    codec: 'flac' as const,
    constraints: FLAC_OUTPUT_CODEC_CONSTRAINTS,
    encoding: Object.freeze({ codec: 'flac' as const, transform }),
    format: 'flac' as const,
    integer: true,
    kind: 'lossless' as const,
    preset: Object.freeze({
      bitDepth,
      container: 'flac' as const,
      extension: 'flac' as const,
      id,
      mimeType: 'audio/flac' as const,
      sampleFormat: 'integer' as const,
    }),
    wasmCodec: 'flac' as const,
  });
}

function discreteCodecConstraints<const SampleRates extends readonly number[]>(
  minimumChannels: number,
  maximumChannels: number,
  sampleRates: SampleRates,
): Readonly<{
  readonly channels: Readonly<{
    readonly maximum: number;
    readonly minimum: number;
  }>;
  readonly sampleRate: Readonly<{
    readonly kind: 'discrete';
    readonly values: SampleRates;
  }>;
}> {
  return Object.freeze({
    channels: Object.freeze({
      maximum: maximumChannels,
      minimum: minimumChannels,
    }),
    sampleRate: Object.freeze({
      kind: 'discrete' as const,
      values: sampleRates,
    }),
  });
}

function rangeCodecConstraints(
  minimumChannels: number,
  maximumChannels: number,
  minimumSampleRate: number,
  maximumSampleRate: number,
): Readonly<{
  readonly channels: Readonly<{
    readonly maximum: number;
    readonly minimum: number;
  }>;
  readonly sampleRate: Readonly<{
    readonly kind: 'range';
    readonly maximum: number;
    readonly minimum: number;
  }>;
}> {
  return Object.freeze({
    channels: Object.freeze({
      maximum: maximumChannels,
      minimum: minimumChannels,
    }),
    sampleRate: Object.freeze({
      kind: 'range' as const,
      maximum: maximumSampleRate,
      minimum: minimumSampleRate,
    }),
  });
}
