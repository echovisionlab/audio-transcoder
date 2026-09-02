import { describe, expect, it } from 'vitest';
import { AIFF_OUTPUT_PRESETS } from './aiff.js';
import { WAV_OUTPUT_PRESET_DESCRIPTORS } from './wav-presets.js';
import {
  AAC_OUTPUT_CODEC_CONSTRAINTS,
  AAC_OUTPUT_PRESET_DESCRIPTORS,
  AAC_OUTPUT_SAMPLE_RATES,
  AIFF_OUTPUT_CODEC_CONSTRAINTS,
  AIFF_STREAM_OUTPUT_PRESET_DESCRIPTORS,
  FLAC_OUTPUT_CODEC_CONSTRAINTS,
  FLAC_OUTPUT_PRESET_DESCRIPTORS,
  FLAC_OUTPUT_SAMPLE_RATES,
  findStreamOutputPresetDescriptor,
  isStreamOutputConfigurationSupported,
  MP3_128KBPS_OUTPUT_CODEC_CONSTRAINTS,
  MP3_128KBPS_OUTPUT_SAMPLE_RATES,
  MP3_HIGH_BITRATE_OUTPUT_CODEC_CONSTRAINTS,
  MP3_HIGH_BITRATE_OUTPUT_SAMPLE_RATES,
  MP3_OUTPUT_PRESET_DESCRIPTORS,
  OGG_OPUS_OUTPUT_CODEC_CONSTRAINTS,
  OGG_OPUS_OUTPUT_PRESET_DESCRIPTORS,
  OGG_OPUS_OUTPUT_SAMPLE_RATES,
  STREAM_OUTPUT_PRESET_DESCRIPTORS,
  STREAM_OUTPUT_PRESETS,
  WAV_OUTPUT_CODEC_CONSTRAINTS,
  WAV_STREAM_OUTPUT_PRESET_DESCRIPTORS,
} from './stream-output-presets.js';

describe('stream output presets', () => {
  it('maps every existing WAV preset without changing its public object', () => {
    expect(WAV_STREAM_OUTPUT_PRESET_DESCRIPTORS).toHaveLength(4);
    WAV_STREAM_OUTPUT_PRESET_DESCRIPTORS.forEach((descriptor, index) => {
      const wav = WAV_OUTPUT_PRESET_DESCRIPTORS[index];
      expect(descriptor).toMatchObject({
        bitDepth: wav?.bitDepth,
        codec: wav?.codec,
        constraints: WAV_OUTPUT_CODEC_CONSTRAINTS,
        encoding: { codec: wav?.codec },
        format: 'wav',
        integer: wav?.integer,
        kind: 'lossless',
        wasmCodec: null,
      });
      expect(descriptor.preset).toBe(wav?.preset);
    });
  });

  it('reuses the whole-buffer AIFF presets for bounded big-endian PCM output', () => {
    expect(AIFF_STREAM_OUTPUT_PRESET_DESCRIPTORS).toEqual([
      {
        bitDepth: 16,
        codec: 'pcm-s16be',
        constraints: AIFF_OUTPUT_CODEC_CONSTRAINTS,
        encoding: null,
        format: 'aiff',
        integer: true,
        kind: 'lossless',
        preset: AIFF_OUTPUT_PRESETS[0],
        wasmCodec: null,
      },
      {
        bitDepth: 24,
        codec: 'pcm-s24be',
        constraints: AIFF_OUTPUT_CODEC_CONSTRAINTS,
        encoding: null,
        format: 'aiff',
        integer: true,
        kind: 'lossless',
        preset: AIFF_OUTPUT_PRESETS[1],
        wasmCodec: null,
      },
    ]);
    expect(AIFF_OUTPUT_CODEC_CONSTRAINTS).toEqual({
      channels: { maximum: 32, minimum: 1 },
      sampleRate: { kind: 'range', maximum: 384_000, minimum: 8_000 },
    });
  });

  it('defines fixed MP3 bitrates and a 16-bit integer encoder transform', () => {
    expect(MP3_OUTPUT_PRESET_DESCRIPTORS).toEqual(
      [128_000, 192_000, 256_000, 320_000].map((bitrate, index) => ({
        bitrate,
        bitrateMode: 'constant',
        codec: 'mp3',
        constraints:
          index === 0
            ? MP3_128KBPS_OUTPUT_CODEC_CONSTRAINTS
            : MP3_HIGH_BITRATE_OUTPUT_CODEC_CONSTRAINTS,
        encoding: {
          bitrate,
          bitrateMode: 'constant',
          codec: 'mp3',
          transform: { sampleFormat: 's16' },
        },
        format: 'mp3',
        kind: 'lossy',
        preset: {
          bitDepth: null,
          container: 'mp3',
          extension: 'mp3',
          id: `mp3-${bitrate / 1_000}kbps`,
          mimeType: 'audio/mpeg',
          sampleFormat: 'lossy',
        },
        wasmCodec: 'mp3',
      })),
    );
  });

  it('defines deterministic AAC-LC ADTS targets with explicit bitrates', () => {
    expect(AAC_OUTPUT_PRESET_DESCRIPTORS).toEqual(
      [96_000, 128_000, 192_000, 256_000].map((bitrate) => ({
        bitrate,
        bitrateMode: 'variable',
        codec: 'aac',
        constraints: AAC_OUTPUT_CODEC_CONSTRAINTS,
        encoding: { bitrate, bitrateMode: 'variable', codec: 'aac' },
        format: 'aac',
        kind: 'lossy',
        preset: {
          bitDepth: null,
          container: 'adts',
          extension: 'aac',
          id: `aac-${bitrate / 1_000}kbps`,
          mimeType: 'audio/aac',
          sampleFormat: 'lossy',
        },
        wasmCodec: 'aac',
      })),
    );
    expect(AAC_OUTPUT_SAMPLE_RATES).toEqual([32_000, 44_100, 48_000]);
    expect(AAC_OUTPUT_CODEC_CONSTRAINTS.channels).toEqual({
      maximum: 2,
      minimum: 1,
    });
  });

  it('defines gapless Ogg Opus targets at the codec clock rate', () => {
    expect(OGG_OPUS_OUTPUT_PRESET_DESCRIPTORS).toEqual(
      [64_000, 96_000, 128_000, 192_000].map((bitrate) => ({
        bitrate,
        bitrateMode: 'variable',
        codec: 'opus',
        constraints: OGG_OPUS_OUTPUT_CODEC_CONSTRAINTS,
        encoding: null,
        format: 'ogg',
        kind: 'lossy',
        preset: {
          bitDepth: null,
          container: 'ogg',
          extension: 'ogg',
          id: `ogg-opus-${bitrate / 1_000}kbps`,
          mimeType: 'audio/ogg',
          sampleFormat: 'lossy',
        },
        wasmCodec: 'ogg-opus',
      })),
    );
    expect(OGG_OPUS_OUTPUT_SAMPLE_RATES).toEqual([48_000]);
    expect(OGG_OPUS_OUTPUT_CODEC_CONSTRAINTS.channels).toEqual({
      maximum: 2,
      minimum: 1,
    });
  });

  it('models the official FLAC extension as 16-bit or 24-bit integer output', () => {
    expect(FLAC_OUTPUT_PRESET_DESCRIPTORS).toEqual([
      {
        bitDepth: 16,
        codec: 'flac',
        constraints: FLAC_OUTPUT_CODEC_CONSTRAINTS,
        encoding: { codec: 'flac', transform: { sampleFormat: 's16' } },
        format: 'flac',
        integer: true,
        kind: 'lossless',
        preset: {
          bitDepth: 16,
          container: 'flac',
          extension: 'flac',
          id: 'flac-16bit',
          mimeType: 'audio/flac',
          sampleFormat: 'integer',
        },
        wasmCodec: 'flac',
      },
      {
        bitDepth: 24,
        codec: 'flac',
        constraints: FLAC_OUTPUT_CODEC_CONSTRAINTS,
        encoding: { codec: 'flac', transform: { sampleFormat: 's32' } },
        format: 'flac',
        integer: true,
        kind: 'lossless',
        preset: {
          bitDepth: 24,
          container: 'flac',
          extension: 'flac',
          id: 'flac-24bit',
          mimeType: 'audio/flac',
          sampleFormat: 'integer',
        },
        wasmCodec: 'flac',
      },
    ]);
  });

  it('publishes deeply immutable aggregate descriptors and preset lookup', () => {
    expect(STREAM_OUTPUT_PRESET_DESCRIPTORS).toHaveLength(20);
    expect(STREAM_OUTPUT_PRESETS).toEqual(
      STREAM_OUTPUT_PRESET_DESCRIPTORS.map(({ preset }) => preset),
    );
    expect(Object.isFrozen(STREAM_OUTPUT_PRESET_DESCRIPTORS)).toBe(true);
    expect(Object.isFrozen(STREAM_OUTPUT_PRESETS)).toBe(true);

    for (const descriptor of STREAM_OUTPUT_PRESET_DESCRIPTORS) {
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.constraints)).toBe(true);
      expect(Object.isFrozen(descriptor.constraints.channels)).toBe(true);
      expect(Object.isFrozen(descriptor.constraints.sampleRate)).toBe(true);
      if (descriptor.encoding !== null) {
        expect(Object.isFrozen(descriptor.encoding)).toBe(true);
      }
      expect(Object.isFrozen(descriptor.preset)).toBe(true);
      if (descriptor.encoding !== null && 'transform' in descriptor.encoding) {
        expect(Object.isFrozen(descriptor.encoding.transform)).toBe(true);
      }
      if (descriptor.constraints.sampleRate.kind === 'discrete') {
        expect(
          Object.isFrozen(descriptor.constraints.sampleRate.values),
        ).toBe(true);
      }
      expect(findStreamOutputPresetDescriptor(descriptor.preset.id)).toBe(
        descriptor,
      );
    }
    expect(findStreamOutputPresetDescriptor('missing')).toBeUndefined();
  });

  it('encodes every exact MP3 preset, channel, and sample-rate combination', () => {
    expect(MP3_128KBPS_OUTPUT_SAMPLE_RATES).toEqual([
      16_000,
      22_050,
      24_000,
      32_000,
      44_100,
      48_000,
    ]);
    expect(MP3_HIGH_BITRATE_OUTPUT_SAMPLE_RATES).toEqual([
      32_000,
      44_100,
      48_000,
    ]);
    expect(MP3_128KBPS_OUTPUT_CODEC_CONSTRAINTS.channels).toEqual({
      maximum: 2,
      minimum: 1,
    });
    expect(MP3_HIGH_BITRATE_OUTPUT_CODEC_CONSTRAINTS.channels).toEqual({
      maximum: 2,
      minimum: 1,
    });

    for (const [descriptor, sampleRates] of [
      [MP3_OUTPUT_PRESET_DESCRIPTORS[0], MP3_128KBPS_OUTPUT_SAMPLE_RATES],
      [MP3_OUTPUT_PRESET_DESCRIPTORS[1], MP3_HIGH_BITRATE_OUTPUT_SAMPLE_RATES],
      [MP3_OUTPUT_PRESET_DESCRIPTORS[2], MP3_HIGH_BITRATE_OUTPUT_SAMPLE_RATES],
      [MP3_OUTPUT_PRESET_DESCRIPTORS[3], MP3_HIGH_BITRATE_OUTPUT_SAMPLE_RATES],
    ] as const) {
      for (const sampleRate of sampleRates) {
        expect(
          isStreamOutputConfigurationSupported(descriptor, 1, sampleRate),
        ).toBe(true);
        expect(
          isStreamOutputConfigurationSupported(descriptor, 2, sampleRate),
        ).toBe(true);
      }
    }

    const descriptor = MP3_OUTPUT_PRESET_DESCRIPTORS[0];
    expect(
      isStreamOutputConfigurationSupported(descriptor, 0, 44_100),
    ).toBe(false);
    expect(
      isStreamOutputConfigurationSupported(descriptor, 3, 44_100),
    ).toBe(false);
    expect(
      isStreamOutputConfigurationSupported(descriptor, 2, 96_000),
    ).toBe(false);
    expect(
      isStreamOutputConfigurationSupported(descriptor, 2, 384_000),
    ).toBe(false);
    expect(
      isStreamOutputConfigurationSupported(descriptor, 1.5, 44_100),
    ).toBe(false);
    expect(
      isStreamOutputConfigurationSupported(descriptor, 2, 44_100.5),
    ).toBe(false);

    for (const sampleRate of [8_000, 11_025, 12_000]) {
      expect(
        isStreamOutputConfigurationSupported(descriptor, 1, sampleRate),
      ).toBe(false);
      expect(
        isStreamOutputConfigurationSupported(descriptor, 2, sampleRate),
      ).toBe(false);
    }

    for (const highBitrateDescriptor of MP3_OUTPUT_PRESET_DESCRIPTORS.slice(1)) {
      for (const sampleRate of [8_000, 11_025, 12_000, 16_000, 22_050, 24_000]) {
        for (const channels of [1, 2]) {
          expect(
            isStreamOutputConfigurationSupported(
              highBitrateDescriptor,
              channels,
              sampleRate,
            ),
          ).toBe(false);
        }
      }
    }
  });

  it('enforces exact AAC and Ogg Opus channel-rate matrices', () => {
    for (const descriptor of AAC_OUTPUT_PRESET_DESCRIPTORS) {
      for (const sampleRate of AAC_OUTPUT_SAMPLE_RATES) {
        expect(isStreamOutputConfigurationSupported(descriptor, 1, sampleRate)).toBe(
          true,
        );
        expect(isStreamOutputConfigurationSupported(descriptor, 2, sampleRate)).toBe(
          true,
        );
      }
      expect(isStreamOutputConfigurationSupported(descriptor, 3, 48_000)).toBe(
        false,
      );
      expect(isStreamOutputConfigurationSupported(descriptor, 2, 24_000)).toBe(
        false,
      );
    }

    for (const descriptor of OGG_OPUS_OUTPUT_PRESET_DESCRIPTORS) {
      expect(isStreamOutputConfigurationSupported(descriptor, 1, 48_000)).toBe(
        true,
      );
      expect(isStreamOutputConfigurationSupported(descriptor, 2, 48_000)).toBe(
        true,
      );
      expect(isStreamOutputConfigurationSupported(descriptor, 3, 48_000)).toBe(
        false,
      );
      expect(isStreamOutputConfigurationSupported(descriptor, 2, 44_100)).toBe(
        false,
      );
    }
  });

  it('encodes the exact FLAC extension channel and sample-rate boundaries', () => {
    const descriptor = FLAC_OUTPUT_PRESET_DESCRIPTORS[0];
    expect(FLAC_OUTPUT_SAMPLE_RATES).toEqual([
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
    expect(FLAC_OUTPUT_CODEC_CONSTRAINTS.channels).toEqual({
      maximum: 8,
      minimum: 1,
    });
    for (const sampleRate of FLAC_OUTPUT_SAMPLE_RATES) {
      expect(
        isStreamOutputConfigurationSupported(descriptor, 1, sampleRate),
      ).toBe(true);
      expect(
        isStreamOutputConfigurationSupported(descriptor, 8, sampleRate),
      ).toBe(true);
    }
    expect(
      isStreamOutputConfigurationSupported(descriptor, 0, 48_000),
    ).toBe(false);
    expect(
      isStreamOutputConfigurationSupported(descriptor, 9, 48_000),
    ).toBe(false);
    expect(
      isStreamOutputConfigurationSupported(descriptor, 2, 11_025),
    ).toBe(false);
    expect(
      isStreamOutputConfigurationSupported(descriptor, 2, 384_000),
    ).toBe(false);
  });

  it('retains explicit WAV ranges and rejects malformed numeric inputs', () => {
    const descriptor = WAV_STREAM_OUTPUT_PRESET_DESCRIPTORS[0];
    expect(isStreamOutputConfigurationSupported(descriptor, 1, 8_000)).toBe(
      true,
    );
    expect(
      isStreamOutputConfigurationSupported(descriptor, 32, 384_000),
    ).toBe(true);
    expect(isStreamOutputConfigurationSupported(descriptor, 1, 7_999)).toBe(
      false,
    );
    expect(
      isStreamOutputConfigurationSupported(descriptor, 1, 384_001),
    ).toBe(false);
    expect(
      isStreamOutputConfigurationSupported(descriptor, 1.5, 48_000),
    ).toBe(false);
    expect(
      isStreamOutputConfigurationSupported(descriptor, 2, 48_000.5),
    ).toBe(false);
  });
});
