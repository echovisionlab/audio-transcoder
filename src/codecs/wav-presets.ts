import type { AudioOutputPreset, AudioSampleFormat } from '../engine/contracts.js';

export type WavPcmCodec =
  | 'pcm-f32'
  | 'pcm-s16'
  | 'pcm-s24'
  | 'pcm-s32';

export interface WavOutputPresetDescriptor<
  Id extends string = string,
  BitDepth extends 16 | 24 | 32 = 16 | 24 | 32,
> {
  readonly bitDepth: BitDepth;
  readonly codec: WavPcmCodec;
  readonly integer: boolean;
  readonly preset: AudioOutputPreset & {
    readonly bitDepth: BitDepth;
    readonly container: 'wav';
    readonly extension: 'wav';
    readonly id: Id;
    readonly mimeType: 'audio/wav';
    readonly sampleFormat: Exclude<AudioSampleFormat, 'lossy'>;
  };
}

export const WAV_OUTPUT_PRESET_DESCRIPTORS = Object.freeze([
  defineWavPreset('wav-pcm16', 'pcm-s16', 16, 'integer'),
  defineWavPreset('wav-pcm24', 'pcm-s24', 24, 'integer'),
  defineWavPreset('wav-pcm32', 'pcm-s32', 32, 'integer'),
  defineWavPreset('wav-float32', 'pcm-f32', 32, 'float'),
] as const);

export type WavOutputPresetId =
  (typeof WAV_OUTPUT_PRESET_DESCRIPTORS)[number]['preset']['id'];

export const WAV_OUTPUT_PRESETS: readonly AudioOutputPreset[] = Object.freeze(
  WAV_OUTPUT_PRESET_DESCRIPTORS.map(({ preset }) => preset),
);

function defineWavPreset<
  const Id extends string,
  const BitDepth extends 16 | 24 | 32,
>(
  id: Id,
  codec: WavPcmCodec,
  bitDepth: BitDepth,
  sampleFormat: 'float' | 'integer',
): WavOutputPresetDescriptor<Id, BitDepth> {
  return Object.freeze({
    bitDepth,
    codec,
    integer: sampleFormat === 'integer',
    preset: Object.freeze({
      bitDepth,
      container: 'wav',
      extension: 'wav',
      id,
      mimeType: 'audio/wav',
      sampleFormat,
    }),
  });
}
