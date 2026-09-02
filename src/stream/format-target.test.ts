import { describe, expect, it } from 'vitest';
import type { AudioInspection } from '../engine/contracts.js';
import {
  AUDIO_TRANSCODER_STREAM_CAPABILITIES,
  type AudioTranscoderStreamCapabilities,
} from './capabilities.js';
import {
  AUDIO_STREAM_AUTOMATIC_SAMPLE_RATE,
  getAudioStreamOutputEncodingOptions,
  getAudioStreamOutputParameters,
  getAudioStreamOutputSampleRateOptions,
  resolveAudioStreamFormatTarget,
  resolveAudioStreamSourceAwareFormatTarget,
} from './format-target.js';

const MONO_192K_SOURCE = Object.freeze({
  bitDepth: 32,
  channels: 1,
  codec: 'lpcm float BE',
  container: 'CAF',
  decodeSupport: 'built-in',
  durationSeconds: 1,
  notes: Object.freeze([]),
  sampleRate: 192_000,
} satisfies AudioInspection);

describe('semantic stream output parameters', () => {
  it('describes WAV sample format and dependent bit depth without UI labels', () => {
    expect(getAudioStreamOutputParameters('wav')).toEqual([
      {
        id: 'sample-format',
        options: [
          {
            presetIds: ['wav-pcm16', 'wav-pcm24', 'wav-pcm32'],
            value: 'integer',
          },
          { presetIds: ['wav-float32'], value: 'float' },
        ],
      },
      {
        id: 'bit-depth',
        options: [
          { presetIds: ['wav-pcm16'], value: 16 },
          { presetIds: ['wav-pcm24'], value: 24 },
          { presetIds: ['wav-pcm32', 'wav-float32'], value: 32 },
        ],
      },
    ]);

    expect(
      getAudioStreamOutputParameters('wav', { sampleFormat: 'float' }),
    ).toEqual([
      {
        id: 'sample-format',
        options: [
          {
            presetIds: ['wav-pcm16', 'wav-pcm24', 'wav-pcm32'],
            value: 'integer',
          },
          { presetIds: ['wav-float32'], value: 'float' },
        ],
      },
      {
        id: 'bit-depth',
        options: [{ presetIds: ['wav-float32'], value: 32 }],
      },
    ]);
  });

  it('describes MP3 bitrate values and stable preset identities', () => {
    expect(getAudioStreamOutputParameters('mp3')).toEqual([
      {
        id: 'bitrate-bps',
        options: [
          { presetIds: ['mp3-128kbps'], value: 128_000 },
          { presetIds: ['mp3-192kbps'], value: 192_000 },
          { presetIds: ['mp3-256kbps'], value: 256_000 },
          { presetIds: ['mp3-320kbps'], value: 320_000 },
        ],
      },
    ]);
    expect(getAudioStreamOutputEncodingOptions('missing')).toEqual([]);
  });

  it('describes the exact AAC and Ogg Opus bitrate choices', () => {
    expect(getAudioStreamOutputParameters('aac')).toEqual([
      {
        id: 'bitrate-bps',
        options: [
          { presetIds: ['aac-96kbps'], value: 96_000 },
          { presetIds: ['aac-128kbps'], value: 128_000 },
          { presetIds: ['aac-192kbps'], value: 192_000 },
          { presetIds: ['aac-256kbps'], value: 256_000 },
        ],
      },
    ]);
    expect(getAudioStreamOutputParameters('ogg')).toEqual([
      {
        id: 'bitrate-bps',
        options: [
          { presetIds: ['ogg-opus-64kbps'], value: 64_000 },
          { presetIds: ['ogg-opus-96kbps'], value: 96_000 },
          { presetIds: ['ogg-opus-128kbps'], value: 128_000 },
          { presetIds: ['ogg-opus-192kbps'], value: 192_000 },
        ],
      },
    ]);
    expect(getAudioStreamOutputEncodingOptions('aac')[0]).toEqual({
      bitDepth: null,
      bitrateBps: 96_000,
      codec: 'aac',
      kind: 'lossy',
      presetId: 'aac-96kbps',
      sampleFormat: 'lossy',
    });
  });
});

describe('semantic stream target resolution', () => {
  it('preserves source rate and channels while resolving an exact preset', () => {
    const result = resolveAudioStreamFormatTarget(
      {
        formatId: 'wav',
        parameters: { bitDepth: 24, sampleFormat: 'integer' },
      },
      MONO_192K_SOURCE,
    );

    expect(result).toMatchObject({
      probeTarget: {
        channels: 1,
        presetId: 'wav-pcm24',
        sampleRate: 192_000,
      },
      status: 'resolved',
      target: { presetId: 'wav-pcm24' },
    });
    expect(Object.keys(result.status === 'resolved' ? result.target : {})).toEqual([
      'presetId',
    ]);
  });

  it('includes an explicit resampling rate only when selected', () => {
    const result = resolveAudioStreamFormatTarget(
      {
        formatId: 'wav',
        presetId: 'wav-float32',
        sampleRate: 48_000,
      },
      MONO_192K_SOURCE,
    );

    expect(result).toMatchObject({
      probeTarget: {
        channels: 1,
        presetId: 'wav-float32',
        sampleRate: 48_000,
      },
      status: 'resolved',
      target: { presetId: 'wav-float32', sampleRate: 48_000 },
    });
  });

  it('requires an explicit 48 kHz target when Ogg Opus needs resampling', () => {
    expect(
      resolveAudioStreamFormatTarget(
        {
          formatId: 'ogg',
          parameters: { bitrateBps: 128_000 },
        },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({ reason: 'sample-rate', status: 'unsupported' });

    expect(
      resolveAudioStreamFormatTarget(
        {
          formatId: 'ogg',
          parameters: { bitrateBps: 128_000 },
          sampleRate: 48_000,
        },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({
      probeTarget: {
        channels: 1,
        presetId: 'ogg-opus-128kbps',
        sampleRate: 48_000,
      },
      status: 'resolved',
      target: { presetId: 'ogg-opus-128kbps', sampleRate: 48_000 },
    });
  });

  it('returns structured errors for ambiguous and unsupported selections', () => {
    expect(
      resolveAudioStreamFormatTarget({ formatId: 'wav' }, MONO_192K_SOURCE),
    ).toMatchObject({ reason: 'parameters', status: 'unsupported' });
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'mp3', parameters: { bitrateBps: 320_000 } },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({ reason: 'sample-rate', status: 'unsupported' });
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'flac', presetId: 'wav-pcm24' },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({ reason: 'preset', status: 'unsupported' });
  });

  it('rejects unknown formats and incomplete source inspection', () => {
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'not-installed' },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({ reason: 'format', status: 'unsupported' });
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'aiff', presetId: 'aiff-pcm16' },
        { ...MONO_192K_SOURCE, channels: null },
      ),
    ).toMatchObject({ reason: 'source-inspection', status: 'unsupported' });
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'aiff', presetId: 'aiff-pcm16' },
        { ...MONO_192K_SOURCE, sampleRate: null },
      ),
    ).toMatchObject({ reason: 'source-inspection', status: 'unsupported' });
    expect(
      resolveAudioStreamFormatTarget(
        {
          formatId: 'wav',
          presetId: 'wav-pcm16',
          sampleRate: 48_000,
        },
        { ...MONO_192K_SOURCE, sampleRate: 48_000.5 },
      ),
    ).toMatchObject({ reason: 'source-inspection', status: 'unsupported' });
  });

  it.each([0, 1.5, 33])(
    'rejects an invalid source channel count of %s',
    (channels) => {
      expect(
        resolveAudioStreamFormatTarget(
          { formatId: 'aiff', presetId: 'aiff-pcm16' },
          { ...MONO_192K_SOURCE, channels },
        ),
      ).toMatchObject({ reason: 'channels', status: 'unsupported' });
    },
  );

  it('rejects source channels outside the selected preset range', () => {
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'mp3', presetId: 'mp3-192kbps' },
        { ...MONO_192K_SOURCE, channels: 3, sampleRate: 48_000 },
      ),
    ).toMatchObject({ reason: 'channels', status: 'unsupported' });
  });

  it('keeps automatic selection outside the legacy resolver contract', () => {
    expect(
      resolveAudioStreamFormatTarget(
        {
          formatId: 'ogg',
          presetId: 'ogg-opus-128kbps',
          sampleRate: 'automatic' as never,
        },
        { ...MONO_192K_SOURCE, sampleRate: 96_000 },
      ),
    ).toMatchObject({ reason: 'sample-rate', status: 'unsupported' });
  });

  it('rejects a preset that conflicts with semantic parameters', () => {
    expect(
      resolveAudioStreamFormatTarget(
        {
          formatId: 'wav',
          parameters: { bitDepth: 16 },
          presetId: 'wav-pcm24',
        },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({ reason: 'parameters', status: 'unsupported' });
  });

  it('distinguishes no semantic match from an ambiguous selection', () => {
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'wav', parameters: { bitDepth: 12 } },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({
      message: expect.stringContaining('No preset'),
      reason: 'parameters',
      status: 'unsupported',
    });
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'wav', parameters: { codec: 'pcm' } },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({
      message: expect.stringContaining('do not select one exact preset'),
      reason: 'parameters',
      status: 'unsupported',
    });
  });
});

describe('source-aware stream target resolution', () => {
  it('preserves a 384 kHz source through a range preset', () => {
    expect(
      resolveAudioStreamSourceAwareFormatTarget(
        {
          formatId: 'wav',
          presetId: 'wav-pcm24',
          sampleRate: AUDIO_STREAM_AUTOMATIC_SAMPLE_RATE,
        },
        { ...MONO_192K_SOURCE, sampleRate: 384_000 },
      ),
    ).toMatchObject({
      probeTarget: {
        channels: 1,
        presetId: 'wav-pcm24',
        sampleRate: 384_000,
      },
      status: 'resolved',
      target: { presetId: 'wav-pcm24' },
    });
  });

  it('rejects an explicit resampling target outside the global path', () => {
    expect(
      resolveAudioStreamSourceAwareFormatTarget(
        {
          formatId: 'wav',
          presetId: 'wav-pcm24',
          sampleRate: 384_000,
        },
        { ...MONO_192K_SOURCE, sampleRate: 48_000 },
      ),
    ).toMatchObject({ reason: 'sample-rate', status: 'unsupported' });
  });

  it('does not resample a source outside the global resampling range', () => {
    expect(
      resolveAudioStreamSourceAwareFormatTarget(
        {
          formatId: 'ogg',
          presetId: 'ogg-opus-128kbps',
          sampleRate: 'automatic',
        },
        { ...MONO_192K_SOURCE, sampleRate: 384_000 },
      ),
    ).toMatchObject({ reason: 'sample-rate', status: 'unsupported' });
  });

  it.each([
    ['ogg', 'ogg-opus-128kbps', 96_000, 48_000],
    ['mp3', 'mp3-320kbps', 24_000, 32_000],
  ])(
    'selects the closest valid exact rate for %s',
    (formatId, presetId, sourceSampleRate, expectedSampleRate) => {
      expect(
        resolveAudioStreamSourceAwareFormatTarget(
          { formatId, presetId, sampleRate: 'automatic' },
          { ...MONO_192K_SOURCE, sampleRate: sourceSampleRate },
        ),
      ).toMatchObject({
        probeTarget: { sampleRate: expectedSampleRate },
        status: 'resolved',
        target: { presetId, sampleRate: expectedSampleRate },
      });
    },
  );

  it('preserves a valid AAC source rate', () => {
    const result = resolveAudioStreamSourceAwareFormatTarget(
      {
        formatId: 'aac',
        presetId: 'aac-128kbps',
        sampleRate: 'automatic',
      },
      { ...MONO_192K_SOURCE, sampleRate: 44_100 },
    );

    expect(result).toMatchObject({
      probeTarget: { sampleRate: 44_100 },
      status: 'resolved',
      target: { presetId: 'aac-128kbps' },
    });
    expect(Object.keys(result.status === 'resolved' ? result.target : {})).toEqual([
      'presetId',
    ]);
  });

  it('prefers the higher exact rate when distances tie', () => {
    expect(
      resolveAudioStreamSourceAwareFormatTarget(
        {
          formatId: 'aac',
          presetId: 'aac-128kbps',
          sampleRate: 'automatic',
        },
        { ...MONO_192K_SOURCE, sampleRate: 46_050 },
      ),
    ).toMatchObject({
      probeTarget: { sampleRate: 48_000 },
      status: 'resolved',
    });
  });

  it('validates source-owned channels before selecting a rate', () => {
    expect(
      resolveAudioStreamSourceAwareFormatTarget(
        {
          formatId: 'ogg',
          presetId: 'ogg-opus-128kbps',
          sampleRate: 'automatic',
        },
        { ...MONO_192K_SOURCE, channels: 3, sampleRate: 96_000 },
      ),
    ).toMatchObject({ reason: 'channels', status: 'unsupported' });
  });

  it('does not invent an automatic rate for a range-constrained preset', () => {
    expect(
      resolveAudioStreamSourceAwareFormatTarget(
        {
          formatId: 'wav',
          presetId: 'wav-pcm24',
          sampleRate: 'automatic',
        },
        { ...MONO_192K_SOURCE, sampleRate: 48_000 },
        capabilitiesWithWavRateRange(96_000, 192_000),
      ),
    ).toMatchObject({ reason: 'sample-rate', status: 'unsupported' });
  });
});

describe('source-aware sample-rate options', () => {
  it('enumerates discrete source and preset rates with path-specific reasons', () => {
    expect(
      getAudioStreamOutputSampleRateOptions(
        { formatId: 'ogg', presetId: 'ogg-opus-128kbps' },
        { ...MONO_192K_SOURCE, sampleRate: 384_000 },
      ),
    ).toEqual({
      options: [
        {
          path: 'pass-through',
          reason: 'preset-sample-rate',
          sampleRate: 384_000,
          status: 'unsupported',
        },
        {
          path: 'resampling',
          reason: 'resampling-source-sample-rate',
          sampleRate: 48_000,
          status: 'unsupported',
        },
      ],
      status: 'resolved',
    });
  });

  it('does not invent range candidates and evaluates caller candidates', () => {
    expect(
      getAudioStreamOutputSampleRateOptions(
        { formatId: 'wav', presetId: 'wav-pcm24' },
        { ...MONO_192K_SOURCE, sampleRate: 48_000 },
      ),
    ).toEqual({
      options: [
        { path: 'pass-through', sampleRate: 48_000, status: 'supported' },
      ],
      status: 'resolved',
    });

    const result = getAudioStreamOutputSampleRateOptions(
      {
        candidateSampleRates: [96_000, 384_000, 7_999, 48_000.5],
        formatId: 'wav',
        presetId: 'wav-pcm24',
      },
      { ...MONO_192K_SOURCE, sampleRate: 48_000 },
    );
    expect(result).toEqual({
      options: [
        { path: 'pass-through', sampleRate: 48_000, status: 'supported' },
        { path: 'resampling', sampleRate: 96_000, status: 'supported' },
        {
          path: 'resampling',
          reason: 'resampling-target-sample-rate',
          sampleRate: 384_000,
          status: 'unsupported',
        },
        {
          path: 'resampling',
          reason: 'preset-sample-rate',
          sampleRate: 7_999,
          status: 'unsupported',
        },
        {
          path: 'resampling',
          reason: 'invalid-sample-rate',
          sampleRate: 48_000.5,
          status: 'unsupported',
        },
      ],
      status: 'resolved',
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === 'resolved') {
      expect(Object.isFrozen(result.options)).toBe(true);
      expect(result.options.every(Object.isFrozen)).toBe(true);
    }
  });

  it.each([
    ['unknown format', { formatId: 'missing', presetId: 'wav-pcm24' }, MONO_192K_SOURCE, 'format'],
    ['wrong preset', { formatId: 'wav', presetId: 'ogg-opus-128kbps' }, MONO_192K_SOURCE, 'preset'],
    ['missing channels', { formatId: 'ogg', presetId: 'ogg-opus-128kbps' }, { ...MONO_192K_SOURCE, channels: null }, 'source-inspection'],
    ['missing sample rate', { formatId: 'ogg', presetId: 'ogg-opus-128kbps' }, { ...MONO_192K_SOURCE, sampleRate: null }, 'source-inspection'],
    ['invalid sample rate', { formatId: 'ogg', presetId: 'ogg-opus-128kbps' }, { ...MONO_192K_SOURCE, sampleRate: 48_000.5 }, 'source-inspection'],
    ['unsupported channels', { formatId: 'ogg', presetId: 'ogg-opus-128kbps' }, { ...MONO_192K_SOURCE, channels: 3 }, 'channels'],
  ] as const)(
    'returns a structured error for %s',
    (_case, selection, inspection, reason) => {
      const result = getAudioStreamOutputSampleRateOptions(
        selection,
        inspection,
      );
      expect(result).toMatchObject({ reason, status: 'unsupported' });
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it('rejects channels outside the global source limit', () => {
    expect(
      getAudioStreamOutputSampleRateOptions(
        { formatId: 'wav', presetId: 'wav-pcm24' },
        { ...MONO_192K_SOURCE, channels: 33, sampleRate: 48_000 },
      ),
    ).toMatchObject({ reason: 'channels', status: 'unsupported' });
  });

  it('reports a source outside a custom pass-through path', () => {
    const result = getAudioStreamOutputSampleRateOptions(
      { formatId: 'aac', presetId: 'aac-128kbps' },
      { ...MONO_192K_SOURCE, sampleRate: 44_100 },
      capabilitiesWithPassThroughMaximum(32_000),
    );
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.options[0]).toEqual({
        path: 'pass-through',
        reason: 'pass-through-sample-rate',
        sampleRate: 44_100,
        status: 'unsupported',
      });
    }
  });
});

function capabilitiesWithWavRateRange(
  minimum: number,
  maximum: number,
): AudioTranscoderStreamCapabilities {
  const format = AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputFormats.find(
    ({ id }) => id === 'wav',
  )!;
  const preset = format.presets.find(
    ({ preset: candidate }) => candidate.id === 'wav-pcm24',
  )!;
  return Object.freeze({
    ...AUDIO_TRANSCODER_STREAM_CAPABILITIES,
    outputFormats: Object.freeze([
      Object.freeze({
        ...format,
        presets: Object.freeze([
          Object.freeze({
            ...preset,
            target: Object.freeze({
              ...preset.target,
              sampleRate: Object.freeze({ kind: 'range' as const, maximum, minimum }),
            }),
          }),
        ]),
      }),
    ]),
  });
}

function capabilitiesWithPassThroughMaximum(
  maximum: number,
): AudioTranscoderStreamCapabilities {
  const sampleRate = AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.sampleRate;
  return Object.freeze({
    ...AUDIO_TRANSCODER_STREAM_CAPABILITIES,
    limits: Object.freeze({
      ...AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits,
      sampleRate: Object.freeze({
        ...sampleRate,
        passThrough: Object.freeze({ ...sampleRate.passThrough, maximum }),
      }),
    }),
  });
}
