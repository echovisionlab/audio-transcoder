import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AudioStreamOutputPresetId } from './contracts.js';
import {
  AUDIO_STREAM_INPUT_FORMATS,
  AUDIO_STREAM_OUTPUT_FORMATS,
  AUDIO_TRANSCODER_STREAM_CAPABILITIES,
  type AudioStreamBuiltInOutputFormatDescriptor,
  type AudioStreamRuntimeAssetOutputFormatDescriptor,
  type AudioStreamInputFormatId,
  type AudioStreamLosslessOutputPresetDescriptor,
  type AudioStreamLossyOutputPresetDescriptor,
} from './capabilities.js';

describe('stream capability discovery', () => {
  it('describes installed input paths without asserting extension support', () => {
    expect(AUDIO_STREAM_INPUT_FORMATS.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: 'caf-lpcm', path: 'built-in-pcm' },
      { id: 'aiff-pcm', path: 'built-in-pcm' },
      { id: 'aifc-pcm', path: 'built-in-pcm' },
      { id: 'mp4', path: 'runtime-probed' },
      { id: 'quicktime', path: 'runtime-probed' },
      { id: 'matroska', path: 'runtime-probed' },
      { id: 'webm', path: 'runtime-probed' },
      { id: 'wave', path: 'runtime-probed' },
      { id: 'ogg', path: 'runtime-probed' },
      { id: 'flac', path: 'runtime-probed' },
      { id: 'mp3', path: 'runtime-probed' },
      { id: 'adts', path: 'runtime-probed' },
      { id: 'mpeg-ts', path: 'runtime-probed' },
    ]);
    expect(AUDIO_STREAM_INPUT_FORMATS.every(Object.isFrozen)).toBe(true);
    expect(
      AUDIO_STREAM_INPUT_FORMATS.every(
        ({ extensionHints, mimeTypeHints }) =>
          Object.isFrozen(extensionHints) && Object.isFrozen(mimeTypeHints),
      ),
    ).toBe(true);
    expect(AUDIO_TRANSCODER_STREAM_CAPABILITIES.inputFormats).toBe(
      AUDIO_STREAM_INPUT_FORMATS,
    );
    expectTypeOf(AUDIO_STREAM_INPUT_FORMATS[0].id).toEqualTypeOf<'caf-lpcm'>();
    expectTypeOf<AudioStreamInputFormatId>().toEqualTypeOf<
      | 'adts'
      | 'aifc-pcm'
      | 'aiff-pcm'
      | 'caf-lpcm'
      | 'flac'
      | 'matroska'
      | 'mp3'
      | 'mp4'
      | 'mpeg-ts'
      | 'ogg'
      | 'quicktime'
      | 'wave'
      | 'webm'
    >();
  });

  it('exposes deterministic built-in and runtime-asset outputs', () => {
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS.map(
        ({ id, implementation, loading, requiresSeekableOutput }) => ({
          id,
          implementation,
          loading,
          requiresSeekableOutput,
        }),
      ),
    ).toEqual([
      {
        id: 'wav',
        implementation: 'built-in',
        loading: 'eager',
        requiresSeekableOutput: true,
      },
      {
        id: 'aiff',
        implementation: 'built-in',
        loading: 'eager',
        requiresSeekableOutput: true,
      },
      {
        id: 'aac',
        implementation: 'runtime-asset',
        loading: 'lazy',
        requiresSeekableOutput: false,
      },
      {
        id: 'ogg',
        implementation: 'runtime-asset',
        loading: 'lazy',
        requiresSeekableOutput: false,
      },
      {
        id: 'mp3',
        implementation: 'runtime-asset',
        loading: 'lazy',
        requiresSeekableOutput: true,
      },
      {
        id: 'flac',
        implementation: 'runtime-asset',
        loading: 'lazy',
        requiresSeekableOutput: true,
      },
    ]);
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS[0].presets.map(
        ({ bitDepth, codec, processingPrecision }) => ({
          bitDepth,
          codec,
          processingPrecision,
        }),
      ),
    ).toEqual([
      {
        bitDepth: 16,
        codec: 'pcm-s16',
        processingPrecision: {
          effectiveIntegerPrecisionBits: 16,
          sampleFormat: 'float32',
        },
      },
      {
        bitDepth: 24,
        codec: 'pcm-s24',
        processingPrecision: {
          effectiveIntegerPrecisionBits: 24,
          sampleFormat: 'float32',
        },
      },
      {
        bitDepth: 32,
        codec: 'pcm-s32',
        processingPrecision: {
          effectiveIntegerPrecisionBits: 24,
          sampleFormat: 'float32',
        },
      },
      {
        bitDepth: 32,
        codec: 'pcm-f32',
        processingPrecision: {
          effectiveIntegerPrecisionBits: 24,
          sampleFormat: 'float32',
        },
      },
    ]);
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS[1].presets.map(
        ({ bitDepth, codec, processingPrecision }) => ({
          bitDepth,
          codec,
          processingPrecision,
        }),
      ),
    ).toEqual([
      {
        bitDepth: 16,
        codec: 'pcm-s16be',
        processingPrecision: {
          effectiveIntegerPrecisionBits: 16,
          sampleFormat: 'float32',
        },
      },
      {
        bitDepth: 24,
        codec: 'pcm-s24be',
        processingPrecision: {
          effectiveIntegerPrecisionBits: 24,
          sampleFormat: 'float32',
        },
      },
    ]);
    expect(AUDIO_STREAM_OUTPUT_FORMATS[1]).toMatchObject({
      container: 'aiff',
      extension: 'aiff',
      mimeType: 'audio/aiff',
      presets: [
        { preset: { id: 'aiff-pcm16' } },
        { preset: { id: 'aiff-pcm24' } },
      ],
    });
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS[2].presets.map(
        ({ bitrate, bitrateMode, preset }) => [preset.id, bitrate, bitrateMode],
      ),
    ).toEqual([
      ['aac-96kbps', 96_000, 'variable'],
      ['aac-128kbps', 128_000, 'variable'],
      ['aac-192kbps', 192_000, 'variable'],
      ['aac-256kbps', 256_000, 'variable'],
    ]);
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS[3].presets.map(
        ({ bitrate, bitrateMode, preset }) => [preset.id, bitrate, bitrateMode],
      ),
    ).toEqual([
      ['ogg-opus-64kbps', 64_000, 'variable'],
      ['ogg-opus-96kbps', 96_000, 'variable'],
      ['ogg-opus-128kbps', 128_000, 'variable'],
      ['ogg-opus-192kbps', 192_000, 'variable'],
    ]);
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS[4].presets.map(
        ({ bitrate, bitrateMode, preset }) => [preset.id, bitrate, bitrateMode],
      ),
    ).toEqual([
      ['mp3-128kbps', 128_000, 'constant'],
      ['mp3-192kbps', 192_000, 'constant'],
      ['mp3-256kbps', 256_000, 'constant'],
      ['mp3-320kbps', 320_000, 'constant'],
    ]);
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS[5].presets.map(
        ({ bitDepth, preset, processingPrecision }) => [
          preset.id,
          bitDepth,
          processingPrecision.effectiveIntegerPrecisionBits,
        ],
      ),
    ).toEqual([
      ['flac-16bit', 16, 16],
      ['flac-24bit', 24, 24],
    ]);
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS[2].presets.map(({ preset, target }) => ({
        presetId: preset.id,
        channels: target.channels,
        sampleRates:
          target.sampleRate.kind === 'discrete'
            ? target.sampleRate.values
            : [],
      })),
    ).toEqual([
      {
        presetId: 'aac-96kbps',
        channels: { maximum: 2, minimum: 1 },
        sampleRates: [32_000, 44_100, 48_000],
      },
      {
        presetId: 'aac-128kbps',
        channels: { maximum: 2, minimum: 1 },
        sampleRates: [32_000, 44_100, 48_000],
      },
      {
        presetId: 'aac-192kbps',
        channels: { maximum: 2, minimum: 1 },
        sampleRates: [32_000, 44_100, 48_000],
      },
      {
        presetId: 'aac-256kbps',
        channels: { maximum: 2, minimum: 1 },
        sampleRates: [32_000, 44_100, 48_000],
      },
    ]);
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS[3].presets.map(({ preset, target }) => ({
        presetId: preset.id,
        channels: target.channels,
        sampleRates:
          target.sampleRate.kind === 'discrete'
            ? target.sampleRate.values
            : [],
      })),
    ).toEqual([
      {
        presetId: 'ogg-opus-64kbps',
        channels: { maximum: 2, minimum: 1 },
        sampleRates: [48_000],
      },
      {
        presetId: 'ogg-opus-96kbps',
        channels: { maximum: 2, minimum: 1 },
        sampleRates: [48_000],
      },
      {
        presetId: 'ogg-opus-128kbps',
        channels: { maximum: 2, minimum: 1 },
        sampleRates: [48_000],
      },
      {
        presetId: 'ogg-opus-192kbps',
        channels: { maximum: 2, minimum: 1 },
        sampleRates: [48_000],
      },
    ]);
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS[4].presets.map(({ preset, target }) => ({
        presetId: preset.id,
        sampleRates: target.sampleRate.kind === 'discrete'
          ? target.sampleRate.values
          : [],
      })),
    ).toEqual([
      {
        presetId: 'mp3-128kbps',
        sampleRates: [16_000, 22_050, 24_000, 32_000, 44_100, 48_000],
      },
      { presetId: 'mp3-192kbps', sampleRates: [32_000, 44_100, 48_000] },
      { presetId: 'mp3-256kbps', sampleRates: [32_000, 44_100, 48_000] },
      { presetId: 'mp3-320kbps', sampleRates: [32_000, 44_100, 48_000] },
    ]);
    expect(AUDIO_STREAM_OUTPUT_FORMATS[5].presets[0].target).toEqual({
      channels: { maximum: 8, minimum: 1 },
      sampleRate: {
        kind: 'discrete',
        values: [8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000],
      },
    });
    expect(Object.isFrozen(AUDIO_STREAM_OUTPUT_FORMATS)).toBe(true);
    for (const format of AUDIO_STREAM_OUTPUT_FORMATS) {
      expect(Object.isFrozen(format)).toBe(true);
      for (const preset of format.presets) {
        expect(Object.isFrozen(preset)).toBe(true);
        expect(Object.isFrozen(preset.target)).toBe(true);
        expect(Object.isFrozen(preset.target.channels)).toBe(true);
        expect(Object.isFrozen(preset.target.sampleRate)).toBe(true);
        if (preset.target.sampleRate.kind === 'discrete') {
          expect(Object.isFrozen(preset.target.sampleRate.values)).toBe(true);
        }
        if (preset.kind === 'lossless') {
          expect(Object.isFrozen(preset.processingPrecision)).toBe(true);
        }
      }
    }
    expect(AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputFormats).toBe(
      AUDIO_STREAM_OUTPUT_FORMATS,
    );
    expect(AUDIO_TRANSCODER_STREAM_CAPABILITIES.requiresSeekableOutput).toBe(
      true,
    );
    expectTypeOf(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputPresets[0]!.id,
    ).toEqualTypeOf<AudioStreamOutputPresetId>();
    expectTypeOf(
      AUDIO_STREAM_OUTPUT_FORMATS[0].presets[0].preset.id,
    ).toEqualTypeOf<'wav-pcm16'>();
    expectTypeOf(
      AUDIO_STREAM_OUTPUT_FORMATS[1].presets[0].preset.id,
    ).toEqualTypeOf<'aiff-pcm16'>();
    expectTypeOf(
      AUDIO_STREAM_OUTPUT_FORMATS[2].presets[0].preset.id,
    ).toEqualTypeOf<'aac-96kbps'>();
    expectTypeOf(
      AUDIO_STREAM_OUTPUT_FORMATS[3].presets[0].preset.id,
    ).toEqualTypeOf<'ogg-opus-64kbps'>();
    expectTypeOf(
      AUDIO_STREAM_OUTPUT_FORMATS[4].presets[0].preset.id,
    ).toEqualTypeOf<'mp3-128kbps'>();
    expectTypeOf(
      AUDIO_STREAM_OUTPUT_FORMATS[5].presets[0].preset.id,
    ).toEqualTypeOf<'flac-16bit'>();
    expectTypeOf<
      AudioStreamBuiltInOutputFormatDescriptor['loading']
    >().toEqualTypeOf<'eager'>();
    expectTypeOf<
      AudioStreamRuntimeAssetOutputFormatDescriptor['loading']
    >().toEqualTypeOf<'lazy'>();
    expectTypeOf<
      AudioStreamLosslessOutputPresetDescriptor['bitDepth']
    >().toEqualTypeOf<number>();
    expectTypeOf<
      AudioStreamLossyOutputPresetDescriptor['bitrate']
    >().toEqualTypeOf<number>();
    expectTypeOf<
      AudioStreamLossyOutputPresetDescriptor['bitrateMode']
    >().toEqualTypeOf<'constant' | 'variable'>();
  });

  it('separates source pass-through, resampling, queue, and concurrency limits', () => {
    expect(AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits).toMatchObject({
      maximumConcurrency: 4,
      queue: { defaultMaximumQueued: 8, maximumQueued: 64 },
      recommendedConcurrency: 1,
      sampleRate: {
        maximum: 384_000,
        minimum: 8_000,
        passThrough: { maximum: 384_000, minimum: 8_000 },
        resampling: { maximum: 192_000, minimum: 8_000 },
      },
    });
    expect(Object.isFrozen(AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.queue)).toBe(
      true,
    );
    expect(
      Object.isFrozen(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.sampleRate.passThrough,
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.sampleRate.resampling,
      ),
    ).toBe(true);
  });
});
