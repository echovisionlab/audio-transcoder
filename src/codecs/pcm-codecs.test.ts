import { describe, expect, it } from 'vitest';
import {
  AIFF_OUTPUT_PRESETS,
  WAV_OUTPUT_PRESETS,
  createAudioTranscoderEngine,
  type AudioOutputPreset,
  type PcmAudio,
} from '../index.js';
import { AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES } from '../engine/buffer-policy.js';
import { aiffDecoder, aiffEncoder, aiffInspector } from './aiff.js';
import { writeAscii, writeExtended80 } from './binary.js';
import { wavDecoder, wavEncoder, wavInspector } from './wav.js';

const engine = createAudioTranscoderEngine();
const PCM: PcmAudio = {
  channelData: [
    new Float32Array([-2, -0.5, 0, 0.5, 2]),
    new Float32Array([1, 0.25, 0, -0.25, -1]),
  ],
  sampleRate: 48_000,
};

describe('built-in WAV and AIFF codecs', () => {
  it.each([...WAV_OUTPUT_PRESETS, ...AIFF_OUTPUT_PRESETS])(
    'round-trips $id',
    async (preset) => {
      const encoded = await engine.encode(PCM, preset.id);
      const inspection = engine.inspect({ data: encoded.data });
      const decoded = await engine.decode({ data: encoded.data });

      expect(encoded.preset).toEqual(preset);
      expect(Object.isFrozen(encoded.preset)).toBe(true);
      expect(inspection.container.toLowerCase()).toContain(preset.container);
      expect(inspection.bitDepth).toBe(preset.bitDepth);
      expect(inspection.channels).toBe(2);
      expect(inspection.sampleRate).toBe(48_000);
      expect(inspection.decodeSupport).toBe('built-in');
      expect(inspection.sourceEncoding).toEqual({
        bitDepth: preset.bitDepth,
        endianness: preset.container === 'wav' ? 'little' : 'big',
        kind: 'pcm',
        sampleFormat: preset.sampleFormat,
        signedness:
          preset.sampleFormat === 'float' ? 'not-applicable' : 'signed',
      });
      expect(decoded.sampleRate).toBe(48_000);
      expect(decoded.channelData).toHaveLength(2);
      expect(decoded.channelData[0]).toHaveLength(5);
      expect(decoded.channelData[0]?.[0]).toBeCloseTo(-1, 4);
      expect(decoded.channelData[0]?.[3]).toBeCloseTo(0.5, 4);
      expect(decoded.channelData[1]?.[0]).toBeCloseTo(1, 4);
      expect(decoded.durationSeconds).toBeCloseTo(5 / 48_000, 10);
    },
  );

  it('transcodes built-in PCM between containers', async () => {
    const wav = await engine.encode(PCM, 'wav-pcm24');
    const aiff = await engine.transcode({ data: wav.data }, 'aiff-pcm16');

    expect(engine.inspect({ data: aiff.data }).container).toBe('AIFF');
    expect((await engine.decode({ data: aiff.data })).source).toBe(
      'AIFF PCM decoder',
    );
  });

  it('writes the required AIFF pad byte for odd PCM payloads', async () => {
    const encoded = await engine.encode(
      { channelData: [new Float32Array([0, 0, 0])], sampleRate: 44_100 },
      'aiff-pcm24',
    );

    expect(encoded.data.byteLength % 2).toBe(0);
    expect((await engine.decode({ data: encoded.data })).channelData[0]).toHaveLength(
      3,
    );
  });

  it('returns null from format-specific strategies for unrelated data', async () => {
    const input = { data: new Uint8Array([1, 2, 3]).buffer };

    expect(wavInspector.inspect(input)).toBeNull();
    expect(wavDecoder.estimateDecodedPcm?.(input)).toBeNull();
    await expect(wavDecoder.decode(input)).resolves.toBeNull();
    expect(aiffInspector.inspect(input)).toBeNull();
    expect(aiffDecoder.estimateDecodedPcm?.(input)).toBeNull();
    await expect(aiffDecoder.decode(input)).resolves.toBeNull();
  });

  it('rejects presets sent to the wrong encoder strategy', async () => {
    const fake = createPreset('not-supported');

    await expect(wavEncoder.encode(PCM, fake)).rejects.toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_OUTPUT' }),
    );
    await expect(aiffEncoder.encode(PCM, fake)).rejects.toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_OUTPUT' }),
    );
  });

  it.each([
    [
      'WAV',
      () =>
        createWav({
          bitDepth: 8,
          blockAlign: 1,
          payload: new Uint8Array(EXPANDING_PCM_FRAMES),
        }),
    ],
    [
      'AIFF',
      () =>
        createAiff({
          bitDepth: 8,
          frames: EXPANDING_PCM_FRAMES,
          payload: new Uint8Array(EXPANDING_PCM_FRAMES),
        }),
    ],
  ] as const)(
    'rejects a sub-limit %s source that expands past the PCM limit',
    async (container, createInput) => {
      const data = createInput();
      const estimate = await (container === 'WAV'
        ? wavDecoder.estimateDecodedPcm?.({ data })
        : aiffDecoder.estimateDecodedPcm?.({ data }));

      expect(data.byteLength).toBeLessThan(
        AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES,
      );
      expect(estimate).toEqual({ channels: 1, frames: EXPANDING_PCM_FRAMES });
      await expect(engine.decode({ data })).rejects.toMatchObject({
        code: 'RESOURCE_LIMIT_EXCEEDED',
      });
    },
  );
});

describe('WAV malformed and extended inputs', () => {
  it('reports missing chunks and uses byte-rate duration fallback', async () => {
    const headerOnly = createWav({ includeData: false, includeFormat: false });
    const formatOnly = createWav({ includeData: false });
    const dataOnly = createWav({ includeFormat: false });

    expect(wavInspector.inspect({ data: headerOnly })).toMatchObject({
      codec: 'Unknown',
      durationSeconds: null,
      notes: ['WAV fmt chunk was not found.'],
    });
    expect(wavInspector.inspect({ data: formatOnly, size: 96_000 })?.durationSeconds).toBe(1);
    expect(wavInspector.inspect({ data: formatOnly })?.durationSeconds).toBeCloseTo(
      formatOnly.byteLength / 96_000,
    );
    expect(wavInspector.inspect({ data: dataOnly })?.codec).toBe('Unknown');
    await expect(wavDecoder.decode({ data: headerOnly })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
    await expect(wavDecoder.decode({ data: formatOnly })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('recognizes unknown and extensible WAVE format tags', async () => {
    const unknown = createWav({ formatTag: 2 });
    const extensible = createWav({
      extensibleSubformat: 1,
      formatChunkSize: 40,
      formatTag: 0xfffe,
    });
    const extensibleFloat = createWav({
      bitDepth: 32,
      blockAlign: 4,
      extensibleSubformat: 3,
      formatChunkSize: 40,
      formatTag: 0xfffe,
      payload: new Uint8Array(4),
    });
    const extensibleUnsupported = createWav({
      extensibleSubformat: 2,
      formatChunkSize: 40,
      formatTag: 0xfffe,
    });

    expect(wavInspector.inspect({ data: unknown })).toMatchObject({
      codec: 'WAVE format 2',
      decodeSupport: 'browser-dependent',
      sourceEncoding: { kind: 'unknown' },
    });
    await expect(wavDecoder.decode({ data: unknown })).rejects.toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_INPUT' }),
    );
    expect(wavInspector.inspect({ data: extensible })?.codec).toBe('PCM integer');
    expect(wavInspector.inspect({ data: extensible })?.sourceEncoding).toEqual({
      bitDepth: 16,
      endianness: 'little',
      kind: 'pcm',
      sampleFormat: 'integer',
      signedness: 'signed',
    });
    await expect(wavDecoder.decode({ data: extensible })).resolves.not.toBeNull();
    expect(wavInspector.inspect({ data: extensibleFloat })?.codec).toBe(
      'PCM float',
    );
    expect(
      wavInspector.inspect({ data: extensibleFloat })?.sourceEncoding,
    ).toEqual({
      bitDepth: 32,
      endianness: 'little',
      kind: 'pcm',
      sampleFormat: 'float',
      signedness: 'not-applicable',
    });
    await expect(wavDecoder.decode({ data: extensibleFloat })).resolves.not.toBeNull();
    expect(wavInspector.inspect({ data: extensibleUnsupported })).toMatchObject({
      codec: 'WAVE format 65534',
      decodeSupport: 'browser-dependent',
    });
  });

  it('does not overclaim malformed WAVE extensible subformats', async () => {
    const mismatchedDepth = createWav({
      extensibleSubformat: 1,
      extensibleValidBitDepth: 8,
      formatChunkSize: 40,
      formatTag: 0xfffe,
    });
    const invalidGuid = createWav({
      extensibleSubformat: 1,
      formatChunkSize: 40,
      formatTag: 0xfffe,
      invalidExtensibleGuid: true,
    });

    for (const data of [mismatchedDepth, invalidGuid]) {
      expect(wavInspector.inspect({ data })).toMatchObject({
        codec: 'WAVE format 65534',
        decodeSupport: 'browser-dependent',
      });
      await expect(engine.decode({ data })).rejects.toMatchObject({
        code: 'UNSUPPORTED_INPUT',
      });
    }
  });

  it.each([
    ['channels', 22],
    ['sample rate', 24],
    ['block alignment', 32],
    ['bit depth', 34],
  ] as const)('rejects invalid %s fields', async (_field, offset) => {
    const data = createWav();
    new DataView(data).setUint16(offset, 0, true);

    expect(wavInspector.inspect({ data })?.decodeSupport).toBe(
      'browser-dependent',
    );
    await expect(wavDecoder.decode({ data })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('rejects non-byte-aligned depth, undersized frames, and empty data', async () => {
    const nonAligned = createWav({ bitDepth: 12, blockAlign: 2 });
    const undersized = createWav({ bitDepth: 16, blockAlign: 1, channels: 2 });
    const empty = createWav({ payload: new Uint8Array() });

    for (const data of [nonAligned, undersized, empty]) {
      await expect(wavDecoder.decode({ data })).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
      );
    }
  });

  it('decodes unsigned 8-bit PCM and rejects an unsupported width', async () => {
    const eightBit = createWav({
      bitDepth: 8,
      blockAlign: 1,
      payload: new Uint8Array([0, 128, 255]),
    });
    const fortyBit = createWav({
      bitDepth: 40,
      blockAlign: 5,
      payload: new Uint8Array(5),
    });

    const decoded = await wavDecoder.decode({ data: eightBit });

    expect(wavInspector.inspect({ data: eightBit })?.sourceEncoding).toEqual({
      bitDepth: 8,
      endianness: 'not-applicable',
      kind: 'pcm',
      sampleFormat: 'integer',
      signedness: 'unsigned',
    });
    expect([...(decoded?.channelData[0] ?? [])]).toEqual([
      -1,
      0,
      127 / 128,
    ]);
    await expect(wavDecoder.decode({ data: fortyBit })).rejects.toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_INPUT' }),
    );
    expect(wavInspector.inspect({ data: fortyBit })?.decodeSupport).toBe(
      'browser-dependent',
    );
  });

  it('supports float64 WAV and rejects unsupported float widths', async () => {
    const float64 = createWav({
      bitDepth: 64,
      blockAlign: 8,
      formatTag: 3,
      payload: new Uint8Array(8),
    });
    const float16 = createWav({
      bitDepth: 16,
      blockAlign: 2,
      formatTag: 3,
      payload: new Uint8Array(2),
    });

    expect(wavInspector.inspect({ data: float64 })?.decodeSupport).toBe(
      'built-in',
    );
    await expect(engine.decode({ data: float64 })).resolves.toMatchObject({
      source: 'WAV PCM decoder',
    });
    expect(wavInspector.inspect({ data: float16 })?.decodeSupport).toBe(
      'browser-dependent',
    );
    await expect(engine.decode({ data: float16 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
    });
  });

  it('rejects RIFF data that is not WAVE', () => {
    const data = new ArrayBuffer(12);
    const view = new DataView(data);
    writeAscii(view, 0, 'RIFF');
    writeAscii(view, 8, 'AVI ');

    expect(wavInspector.inspect({ data })).toBeNull();
  });

  it('handles short and truncated extensible fmt chunks safely', () => {
    const short = createWav({ formatChunkSize: 15 });
    const truncated = createWav({
      formatChunkSize: 40,
      formatTag: 0xfffe,
      includeData: false,
    }).slice(0, 36);

    expect(wavInspector.inspect({ data: short })?.codec).toBe('Unknown');
    expect(wavInspector.inspect({ data: truncated })?.codec).toBe(
      'WAVE format 65534',
    );
  });
});

describe('AIFF malformed and compressed inputs', () => {
  it('reports missing COMM and SSND chunks', async () => {
    const headerOnly = createAiff({ includeCommon: false, includeSound: false });
    const commonOnly = createAiff({ includeSound: false });

    expect(aiffInspector.inspect({ data: headerOnly })).toMatchObject({
      codec: 'Unknown',
      durationSeconds: null,
      notes: ['AIFF COMM chunk was not found.'],
    });
    expect(aiffInspector.inspect({ data: commonOnly })).toMatchObject({
      codec: 'PCM integer',
      notes: ['AIFF SSND chunk was not found.'],
    });
    await expect(aiffDecoder.decode({ data: headerOnly })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
    await expect(aiffDecoder.decode({ data: commonOnly })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('reports and rejects compressed AIFC', async () => {
    const data = createAiff({ compression: 'ulaw', formType: 'AIFC' });

    expect(aiffInspector.inspect({ data })).toMatchObject({
      codec: 'Compression ulaw',
      container: 'AIFC',
      decodeSupport: 'browser-dependent',
      sourceEncoding: {
        estimatedBitrateBps: null,
        codec: 'ulaw',
        kind: 'lossy-compressed',
      },
    });
    await expect(aiffDecoder.decode({ data })).rejects.toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_INPUT' }),
    );
  });

  it.each([
    [
      'twos',
      16,
      {
        bitDepth: 16,
        endianness: 'big',
        kind: 'pcm',
        sampleFormat: 'integer',
        signedness: 'signed',
      },
    ],
    [
      'sowt',
      16,
      {
        bitDepth: 16,
        endianness: 'little',
        kind: 'pcm',
        sampleFormat: 'integer',
        signedness: 'signed',
      },
    ],
    [
      'raw ',
      8,
      {
        bitDepth: 8,
        endianness: 'not-applicable',
        kind: 'pcm',
        sampleFormat: 'integer',
        signedness: 'unsigned',
      },
    ],
    [
      'fl32',
      32,
      {
        bitDepth: 32,
        endianness: 'big',
        kind: 'pcm',
        sampleFormat: 'float',
        signedness: 'not-applicable',
      },
    ],
    [
      'FL32',
      8,
      {
        bitDepth: 8,
        endianness: 'not-applicable',
        kind: 'pcm',
        sampleFormat: 'float',
        signedness: 'not-applicable',
      },
    ],
    [
      'fl64',
      64,
      {
        bitDepth: 64,
        endianness: 'big',
        kind: 'pcm',
        sampleFormat: 'float',
        signedness: 'not-applicable',
      },
    ],
    [
      'FL64',
      32,
      {
        bitDepth: 32,
        endianness: 'big',
        kind: 'pcm',
        sampleFormat: 'float',
        signedness: 'not-applicable',
      },
    ],
    [
      'ALAC',
      16,
      { bitDepth: null, codec: 'alac', kind: 'lossless-compressed' },
    ],
    [
      'alac',
      24,
      { bitDepth: null, codec: 'alac', kind: 'lossless-compressed' },
    ],
    [
      'alaw',
      16,
      {
        codec: 'alaw',
        estimatedBitrateBps: null,
        kind: 'lossy-compressed',
      },
    ],
    [
      'ima4',
      16,
      {
        codec: 'ima4',
        estimatedBitrateBps: null,
        kind: 'lossy-compressed',
      },
    ],
    ['zzzz', 16, { kind: 'unknown' }],
  ] as const)(
    'classifies AIFC compression %s without overclaiming decode support',
    (compression, bitDepth, sourceEncoding) => {
      const data = createAiff({ bitDepth, compression, formType: 'AIFC' });

      expect(aiffInspector.inspect({ data })).toMatchObject({
        decodeSupport: 'browser-dependent',
        sourceEncoding,
      });
    },
  );

  it('rejects AIFC without a compression type', async () => {
    const data = createAiff({ commonChunkSize: 18, formType: 'AIFC' });

    expect(aiffInspector.inspect({ data })).toMatchObject({
      codec: 'Unknown compression',
      decodeSupport: 'browser-dependent',
      notes: ['AIFC COMM compression type was not found.'],
    });
    await expect(engine.decode({ data })).rejects.toMatchObject({
      code: 'INVALID_AUDIO_DATA',
    });
  });

  it.each([
    ['channels', 20, 'uint16'],
    ['sample rate', 28, 'extended'],
    ['bit depth', 26, 'uint16'],
  ] as const)('rejects invalid %s fields', async (_field, offset, kind) => {
    const data = createAiff();
    const view = new DataView(data);
    if (kind === 'extended') {
      writeExtended80(view, offset, 0);
    } else {
      view.setUint16(offset, 0, false);
    }

    expect(aiffInspector.inspect({ data })?.decodeSupport).toBe(
      'browser-dependent',
    );
    await expect(aiffDecoder.decode({ data })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('rejects non-byte-aligned depth and an empty sound payload', async () => {
    const nonAligned = createAiff({ bitDepth: 12, payload: new Uint8Array([0, 0]) });
    const empty = createAiff({ frames: 0, payload: new Uint8Array() });

    await expect(aiffDecoder.decode({ data: nonAligned })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
    await expect(aiffDecoder.decode({ data: empty })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('rejects unsupported byte-aligned AIFF sample widths', async () => {
    const data = createAiff({
      bitDepth: 40,
      payload: new Uint8Array(5),
    });

    expect(aiffInspector.inspect({ data })?.decodeSupport).toBe(
      'browser-dependent',
    );
    await expect(engine.decode({ data })).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
    });
  });

  it('rejects a non-finite extended sample rate', async () => {
    const data = createAiff();
    const view = new DataView(data);
    view.setUint16(28, 0x7fff, false);
    view.setUint32(30, 0x80000000, false);
    view.setUint32(34, 0, false);

    expect(aiffInspector.inspect({ data })?.durationSeconds).toBeNull();
    await expect(aiffDecoder.decode({ data })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('rejects FORM data with an unrelated form type', () => {
    const data = createAiff();
    writeAscii(new DataView(data), 8, '8SVX');

    expect(aiffInspector.inspect({ data })).toBeNull();
  });

  it('handles short COMM and SSND chunks safely', async () => {
    const shortCommon = createAiff({ commonChunkSize: 17, includeSound: false });
    const shortSound = createAiff({ soundChunkSize: 7 });
    const offsetPastData = createAiff({ soundChunkSize: 8, soundOffset: 20 });

    expect(aiffInspector.inspect({ data: shortCommon })?.codec).toBe('Unknown');
    expect(aiffInspector.inspect({ data: shortSound })?.notes).toEqual([
      'AIFF SSND chunk was not found.',
    ]);
    await expect(aiffDecoder.decode({ data: offsetPastData })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });
});

function createPreset(id: string): AudioOutputPreset {
  return {
    bitDepth: null,
    container: 'test',
    extension: 'test',
    id,
    mimeType: 'audio/test',
    sampleFormat: 'lossy',
  };
}

interface WavFixtureOptions {
  readonly bitDepth?: number;
  readonly blockAlign?: number;
  readonly channels?: number;
  readonly extensibleSubformat?: number;
  readonly extensibleValidBitDepth?: number;
  readonly formatChunkSize?: number;
  readonly formatTag?: number;
  readonly includeData?: boolean;
  readonly includeFormat?: boolean;
  readonly invalidExtensibleGuid?: boolean;
  readonly payload?: Uint8Array;
  readonly sampleRate?: number;
}

function createWav(options: WavFixtureOptions = {}): ArrayBuffer {
  const includeFormat = options.includeFormat ?? true;
  const includeData = options.includeData ?? true;
  const formatChunkSize = options.formatChunkSize ?? 16;
  const channels = options.channels ?? 1;
  const bitDepth = options.bitDepth ?? 16;
  const blockAlign = options.blockAlign ?? channels * Math.ceil(bitDepth / 8);
  const sampleRate = options.sampleRate ?? 48_000;
  const payload = options.payload ?? new Uint8Array(blockAlign);
  const formatBytes = includeFormat ? 8 + formatChunkSize : 0;
  const dataBytes = includeData ? 8 + payload.byteLength : 0;
  const buffer = new ArrayBuffer(12 + formatBytes + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, 'WAVE');

  let offset = 12;
  if (includeFormat) {
    writeAscii(view, offset, 'fmt ');
    view.setUint32(offset + 4, formatChunkSize, true);
    if (formatChunkSize >= 16) {
      const dataOffset = offset + 8;
      view.setUint16(dataOffset, options.formatTag ?? 1, true);
      view.setUint16(dataOffset + 2, channels, true);
      view.setUint32(dataOffset + 4, sampleRate, true);
      view.setUint32(dataOffset + 8, sampleRate * blockAlign, true);
      view.setUint16(dataOffset + 12, blockAlign, true);
      view.setUint16(dataOffset + 14, bitDepth, true);
      if (formatChunkSize >= 40 && options.extensibleSubformat !== undefined) {
        view.setUint16(dataOffset + 16, 22, true);
        view.setUint16(
          dataOffset + 18,
          options.extensibleValidBitDepth ?? bitDepth,
          true,
        );
        view.setUint32(dataOffset + 24, options.extensibleSubformat, true);
        view.setUint16(dataOffset + 28, 0, true);
        view.setUint16(dataOffset + 30, 0x10, true);
        view.setUint32(
          dataOffset + 32,
          options.invalidExtensibleGuid ? 0 : 0x800000aa,
          false,
        );
        view.setUint32(dataOffset + 36, 0x00389b71, false);
      }
    }
    offset += 8 + formatChunkSize;
  }

  if (includeData) {
    writeAscii(view, offset, 'data');
    view.setUint32(offset + 4, payload.byteLength, true);
    new Uint8Array(buffer, offset + 8).set(payload);
  }
  return buffer;
}

const EXPANDING_PCM_FRAMES =
  AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES /
    Float32Array.BYTES_PER_ELEMENT +
  1;

interface AiffFixtureOptions {
  readonly bitDepth?: number;
  readonly channels?: number;
  readonly commonChunkSize?: number;
  readonly compression?: string;
  readonly formType?: 'AIFC' | 'AIFF';
  readonly frames?: number;
  readonly includeCommon?: boolean;
  readonly includeSound?: boolean;
  readonly payload?: Uint8Array;
  readonly sampleRate?: number;
  readonly soundChunkSize?: number;
  readonly soundOffset?: number;
}

function createAiff(options: AiffFixtureOptions = {}): ArrayBuffer {
  const formType = options.formType ?? 'AIFF';
  const includeCommon = options.includeCommon ?? true;
  const includeSound = options.includeSound ?? true;
  const commonChunkSize =
    options.commonChunkSize ?? (formType === 'AIFC' ? 22 : 18);
  const channels = options.channels ?? 1;
  const bitDepth = options.bitDepth ?? 16;
  const payload = options.payload ?? new Uint8Array([0, 0]);
  const frames = options.frames ?? 1;
  const soundOffset = options.soundOffset ?? 0;
  const soundChunkSize = options.soundChunkSize ?? 8 + soundOffset + payload.byteLength;
  const commonBytes = includeCommon ? 8 + commonChunkSize : 0;
  const soundBytes = includeSound ? 8 + soundChunkSize : 0;
  const buffer = new ArrayBuffer(12 + commonBytes + soundBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'FORM');
  view.setUint32(4, buffer.byteLength - 8, false);
  writeAscii(view, 8, formType);

  let offset = 12;
  if (includeCommon) {
    writeAscii(view, offset, 'COMM');
    view.setUint32(offset + 4, commonChunkSize, false);
    if (commonChunkSize >= 18) {
      const dataOffset = offset + 8;
      view.setUint16(dataOffset, channels, false);
      view.setUint32(dataOffset + 2, frames, false);
      view.setUint16(dataOffset + 6, bitDepth, false);
      writeExtended80(view, dataOffset + 8, options.sampleRate ?? 48_000);
      if (commonChunkSize >= 22) {
        writeAscii(view, dataOffset + 18, options.compression ?? 'NONE');
      }
    }
    offset += 8 + commonChunkSize;
  }

  if (includeSound) {
    writeAscii(view, offset, 'SSND');
    view.setUint32(offset + 4, soundChunkSize, false);
    if (soundChunkSize >= 8) {
      view.setUint32(offset + 8, soundOffset, false);
      view.setUint32(offset + 12, 0, false);
      const payloadOffset = offset + 16 + soundOffset;
      if (payloadOffset <= buffer.byteLength) {
        const available = buffer.byteLength - payloadOffset;
        new Uint8Array(
          buffer,
          payloadOffset,
          Math.min(available, payload.byteLength),
        ).set(payload.subarray(0, available));
      }
    }
  }
  return buffer;
}
