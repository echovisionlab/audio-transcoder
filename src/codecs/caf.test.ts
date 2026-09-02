import { describe, expect, it } from 'vitest';
import { createAudioTranscoderEngine } from '../index.js';
import { AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES } from '../engine/buffer-policy.js';
import { writeAscii } from './binary.js';
import { cafDecoder, cafInspector } from './caf.js';

const engine = createAudioTranscoderEngine();

describe('CAF LPCM codec', () => {
  it('inspects and decodes signed big-endian integer PCM', async () => {
    const data = createCaf({
      bitDepth: 16,
      channels: 2,
      flags: 0,
      payload: int16Payload([16_384, -16_384, 32_767, -32_768], false),
    });
    const inspection = engine.inspect({ data });
    const decoded = await engine.decode({ data });

    expect(inspection).toMatchObject({
      bitDepth: 16,
      channels: 2,
      codec: 'lpcm signed int BE',
      container: 'CAF',
      decodeSupport: 'built-in',
      sampleRate: 48_000,
      sourceEncoding: {
        bitDepth: 16,
        endianness: 'big',
        kind: 'pcm',
        sampleFormat: 'integer',
        signedness: 'signed',
      },
    });
    expect(inspection.durationSeconds).toBeCloseTo(2 / 48_000, 10);
    expect(cafDecoder.estimateDecodedPcm?.({ data })).toEqual({
      channels: 2,
      frames: 2,
    });
    expect(decoded.source).toBe('CAF LPCM decoder');
    expect([...decoded.channelData[0]!]).toEqual([0.5, 32_767 / 32_768]);
    expect([...decoded.channelData[1]!]).toEqual([-0.5, -1]);
  });

  it('decodes little-endian floating-point PCM', async () => {
    const payload = new ArrayBuffer(8);
    const payloadView = new DataView(payload);
    payloadView.setFloat32(0, 0.25, true);
    payloadView.setFloat32(4, -0.75, true);
    const data = createCaf({
      bitDepth: 32,
      channels: 1,
      flags: 3,
      payload: new Uint8Array(payload),
    });

    expect(engine.inspect({ data })).toMatchObject({
      codec: 'lpcm float LE',
      sourceEncoding: {
        bitDepth: 32,
        endianness: 'little',
        kind: 'pcm',
        sampleFormat: 'float',
        signedness: 'not-applicable',
      },
    });
    expect([...(await engine.decode({ data })).channelData[0]!]).toEqual([
      0.25,
      -0.75,
    ]);
  });

  it('decodes 64-bit floating-point PCM into Float32 channels', async () => {
    const payload = new ArrayBuffer(8);
    new DataView(payload).setFloat64(0, 0.25, true);
    const data = createCaf({
      bitDepth: 64,
      bytesPerPacket: 8,
      flags: 3,
      payload: new Uint8Array(payload),
    });

    expect([...(await engine.decode({ data })).channelData[0]!]).toEqual([
      0.25,
    ]);
  });

  it('decodes signed 8-bit integer PCM', async () => {
    const data = createCaf({
      bitDepth: 8,
      channels: 1,
      flags: 0,
      payload: new Uint8Array([128, 0, 127]),
    });

    expect(engine.inspect({ data })).toMatchObject({
      codec: 'lpcm signed int BE',
      sourceEncoding: {
        bitDepth: 8,
        endianness: 'not-applicable',
        kind: 'pcm',
        sampleFormat: 'integer',
        signedness: 'signed',
      },
    });
    expect([...(await engine.decode({ data })).channelData[0]!]).toEqual([
      -1,
      0,
      127 / 128,
    ]);
  });

  it('rejects a sub-limit CAF source that expands past the PCM limit', async () => {
    const frames =
      AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES /
        Float32Array.BYTES_PER_ELEMENT +
      1;
    const data = createCaf({
      bitDepth: 8,
      bytesPerPacket: 1,
      flags: 0,
      payload: new Uint8Array(frames),
    });

    expect(data.byteLength).toBeLessThan(
      AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES,
    );
    expect(await cafDecoder.estimateDecodedPcm?.({ data })).toEqual({
      channels: 1,
      frames,
    });
    await expect(engine.decode({ data })).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
    });
  });

  it.each([16, 24, 32] as const)(
    'decodes little-endian signed %i-bit integer PCM',
    async (bitDepth) => {
      const data = createCaf({
        bitDepth,
        bytesPerPacket: bitDepth / 8,
        flags: 2,
        payload: new Uint8Array(bitDepth / 8),
      });

      expect(cafInspector.inspect({ data })).toMatchObject({
        codec: `lpcm signed int LE`,
        decodeSupport: 'built-in',
        notes: [],
        sourceEncoding: {
          bitDepth,
          endianness: 'little',
          kind: 'pcm',
          sampleFormat: 'integer',
          signedness: 'signed',
        },
      });
      expect([...(await engine.decode({ data })).channelData[0]!]).toEqual([0]);
    },
  );

  it('decodes big-endian floating-point PCM', async () => {
    const payload = new ArrayBuffer(4);
    new DataView(payload).setFloat32(0, -0.25, false);
    const data = createCaf({
      bitDepth: 32,
      bytesPerPacket: 4,
      flags: 1,
      payload: new Uint8Array(payload),
    });

    expect(cafInspector.inspect({ data })).toMatchObject({
      codec: 'lpcm float BE',
      decodeSupport: 'built-in',
      sourceEncoding: {
        bitDepth: 32,
        endianness: 'big',
        kind: 'pcm',
        sampleFormat: 'float',
        signedness: 'not-applicable',
      },
    });
    expect([...(await engine.decode({ data })).channelData[0]!]).toEqual([
      -0.25,
    ]);
  });

  it('supports an indefinite final data chunk using the logical file size', () => {
    const data = createCaf({
      bitDepth: 16,
      channels: 1,
      dataChunkSize: -1n,
      flags: 2,
      payload: int16Payload([0, 1], true),
    });
    const inspection = cafInspector.inspect({ data, size: data.byteLength });

    expect(inspection?.durationSeconds).toBeCloseTo(2 / 48_000, 10);
  });

  it('bounds an oversized final data chunk to the available bytes', () => {
    const data = createCaf({
      bitDepth: 16,
      channels: 1,
      dataChunkSize: 1_000n,
      flags: 2,
      payload: int16Payload([0, 1], true),
    });

    expect(cafInspector.inspect({ data })?.durationSeconds).toBeCloseTo(
      2 / 48_000,
      10,
    );
  });

  it('reports compressed and missing descriptions without claiming built-in decode', async () => {
    const compressed = createCaf({
      bitDepth: 0,
      bytesPerPacket: 0,
      channels: 2,
      flags: 0,
      formatId: 'aac ',
      framesPerPacket: 1024,
      payload: new Uint8Array([1, 2]),
    });
    const losslessCompressed = createCaf({
      bitDepth: 0,
      bytesPerPacket: 0,
      channels: 2,
      flags: 3,
      formatId: 'alac',
      framesPerPacket: 4096,
      payload: new Uint8Array([1, 2]),
    });
    const missing = createCaf({ includeDescription: false });

    expect(cafInspector.inspect({ data: compressed })).toMatchObject({
      bitDepth: null,
      codec: 'aac',
      decodeSupport: 'browser-dependent',
      durationSeconds: null,
      notes: ['Compressed CAF requires a browser decoder or codec plugin.'],
      sourceEncoding: {
        estimatedBitrateBps: null,
        codec: 'aac',
        kind: 'lossy-compressed',
      },
    });
    expect(cafInspector.inspect({ data: losslessCompressed })).toMatchObject({
      sourceEncoding: {
        bitDepth: 24,
        codec: 'alac',
        kind: 'lossless-compressed',
      },
    });
    expect(
      cafInspector.inspect({
        data: createCaf({
          bitDepth: 0,
          bytesPerPacket: 0,
          flags: 99,
          formatId: 'alac',
          framesPerPacket: 4096,
        }),
      }),
    ).toMatchObject({
      bitDepth: null,
      codec: 'alac',
      sourceEncoding: {
        bitDepth: null,
        codec: 'alac',
        kind: 'lossless-compressed',
      },
    });
    expect(cafInspector.inspect({ data: missing })).toMatchObject({
      codec: 'Unknown',
      notes: ['CAF desc chunk was not found.'],
      sourceEncoding: { kind: 'unknown' },
    });
    await expect(cafDecoder.decode({ data: compressed })).rejects.toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_INPUT' }),
    );
  });

  it.each([
    [1, 16],
    [2, 20],
    [3, 24],
    [4, 32],
  ] as const)('maps CAF ALAC source-depth flag %i to %i-bit', (flags, bitDepth) => {
    const data = createCaf({
      bitDepth: 0,
      bytesPerPacket: 0,
      flags,
      formatId: 'alac',
      framesPerPacket: 4096,
    });

    expect(cafInspector.inspect({ data })?.sourceEncoding).toEqual({
      bitDepth,
      codec: 'alac',
      kind: 'lossless-compressed',
    });
  });

  it.each([
    [0, null],
    [1, 16],
    [3, 24],
  ] as const)('maps CAF FLAC source-depth flag %i to %s', (flags, bitDepth) => {
    const data = createCaf({
      bitDepth: 0,
      bytesPerPacket: 0,
      flags,
      formatId: 'flac',
      framesPerPacket: 4096,
    });

    expect(cafInspector.inspect({ data })?.sourceEncoding).toEqual({
      bitDepth,
      codec: 'flac',
      kind: 'lossless-compressed',
    });
  });

  it('normalizes the CAF MP3 FourCC to the canonical codec ID', () => {
    const data = createCaf({
      bitDepth: 0,
      bytesPerPacket: 0,
      channels: 2,
      flags: 0,
      formatId: '.mp3',
      framesPerPacket: 1_152,
      payload: new Uint8Array([1, 2]),
    });

    expect(cafInspector.inspect({ data })?.sourceEncoding).toEqual({
      codec: 'mp3',
      estimatedBitrateBps: null,
      kind: 'lossy-compressed',
    });
  });

  it.each([
    ['flac', { bitDepth: null, codec: 'flac', kind: 'lossless-compressed' }],
    [
      'opus',
      {
        codec: 'opus',
        estimatedBitrateBps: null,
        kind: 'lossy-compressed',
      },
    ],
    ['zzzz', { kind: 'unknown' }],
  ] as const)('classifies CAF codec %s', (formatId, sourceEncoding) => {
    const data = createCaf({
      bitDepth: 0,
      bytesPerPacket: 0,
      channels: 2,
      flags: 0,
      formatId,
      framesPerPacket: 1_024,
      payload: new Uint8Array([1, 2]),
    });

    expect(cafInspector.inspect({ data })?.sourceEncoding).toEqual(
      sourceEncoding,
    );
  });

  it.each([4, 16, 32])(
    'routes unknown LPCM flag bit %i to plugins',
    async (unknownFlag) => {
      const data = createCaf({
        flags: unknownFlag,
        payload: int16Payload([0], false),
      });

      expect(cafInspector.inspect({ data })).toMatchObject({
        decodeSupport: 'browser-dependent',
        notes: [
          'CAF LPCM sample representation requires a codec plugin.',
        ],
      });
      await expect(cafDecoder.decode({ data })).rejects.toThrowError(
        expect.objectContaining({ code: 'UNSUPPORTED_INPUT' }),
      );
    },
  );

  it('routes padded LPCM layouts to plugins', async () => {
    const data = createCaf({
      bytesPerPacket: 4,
      payload: new Uint8Array(4),
    });

    expect(cafInspector.inspect({ data })).toMatchObject({
      decodeSupport: 'browser-dependent',
      notes: ['CAF LPCM layout requires a codec plugin.'],
    });
    await expect(engine.decode({ data })).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
    });
  });

  it('returns null for unrelated input', async () => {
    const input = { data: new Uint8Array([1, 2, 3]).buffer };

    expect(cafInspector.inspect(input)).toBeNull();
    expect(cafDecoder.estimateDecodedPcm?.(input)).toBeNull();
    await expect(cafDecoder.decode(input)).resolves.toBeNull();
  });

  it('rejects CAF files missing required chunks', async () => {
    await expect(
      cafDecoder.decode({ data: createCaf({ includeDescription: false }) }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }));
    await expect(
      cafDecoder.decode({ data: createCaf({ includeData: false }) }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }));
  });

  it.each([
    ['channels', DESC_CHANNELS, 'uint32'],
    ['sample rate', DESC_SAMPLE_RATE, 'float64'],
    ['frames per packet', DESC_FRAMES_PER_PACKET, 'uint32'],
    ['bytes per packet', DESC_BYTES_PER_PACKET, 'uint32'],
    ['bit depth', DESC_BIT_DEPTH, 'uint32'],
  ] as const)('rejects invalid %s', async (_field, offset, kind) => {
    const data = createCaf({ payload: int16Payload([0], false) });
    const view = new DataView(data);
    if (kind === 'float64') {
      view.setFloat64(offset, 0, false);
    } else {
      view.setUint32(offset, 0, false);
    }

    expect(cafInspector.inspect({ data })).toMatchObject({
      decodeSupport: 'browser-dependent',
      notes: ['CAF LPCM description is invalid.'],
    });
    await expect(cafDecoder.decode({ data })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('rejects a non-byte-aligned bit depth', async () => {
    const data = createCaf({
      bitDepth: 12,
      bytesPerPacket: 2,
      payload: new Uint8Array([0, 0]),
    });

    await expect(cafDecoder.decode({ data })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('rejects a non-finite sample rate', async () => {
    const data = createCaf({
      payload: int16Payload([0], false),
      sampleRate: Number.POSITIVE_INFINITY,
    });

    expect(cafInspector.inspect({ data })?.durationSeconds).toBeNull();
    await expect(cafDecoder.decode({ data })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('rejects fractional and undersized packet layouts', async () => {
    const fractional = createCaf({
      bytesPerPacket: 3,
      framesPerPacket: 2,
      payload: new Uint8Array([0, 0, 0]),
    });
    const undersized = createCaf({
      bytesPerPacket: 1,
      channels: 2,
      payload: new Uint8Array([0]),
    });

    await expect(cafDecoder.decode({ data: fractional })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
    await expect(cafDecoder.decode({ data: undersized })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('rejects a data chunk without a complete frame', async () => {
    const data = createCaf({ payload: new Uint8Array() });

    await expect(cafDecoder.decode({ data })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('stops safely at an unrepresentable chunk size', () => {
    const data = new ArrayBuffer(20);
    const view = new DataView(data);
    writeAscii(view, 0, 'caff');
    writeAscii(view, 8, 'huge');
    view.setBigInt64(12, 0x7fffffffffffffffn, false);

    expect(cafInspector.inspect({ data })).toMatchObject({
      codec: 'Unknown',
    });
  });

  it('stops safely at an invalid negative chunk size', () => {
    const data = new ArrayBuffer(20);
    const view = new DataView(data);
    writeAscii(view, 0, 'caff');
    writeAscii(view, 8, 'bad!');
    view.setBigInt64(12, -2n, false);

    expect(cafInspector.inspect({ data })).toMatchObject({ codec: 'Unknown' });
  });
});

const DESC_SAMPLE_RATE = 20;
const DESC_BYTES_PER_PACKET = 36;
const DESC_FRAMES_PER_PACKET = 40;
const DESC_CHANNELS = 44;
const DESC_BIT_DEPTH = 48;

interface CafFixtureOptions {
  readonly bitDepth?: number;
  readonly bytesPerPacket?: number;
  readonly channels?: number;
  readonly dataChunkSize?: bigint;
  readonly flags?: number;
  readonly formatId?: string;
  readonly framesPerPacket?: number;
  readonly includeData?: boolean;
  readonly includeDescription?: boolean;
  readonly payload?: Uint8Array;
  readonly sampleRate?: number;
}

function createCaf(options: CafFixtureOptions = {}): ArrayBuffer {
  const includeDescription = options.includeDescription ?? true;
  const includeData = options.includeData ?? true;
  const payload = options.payload ?? new Uint8Array([0, 0]);
  const channels = options.channels ?? 1;
  const bitDepth = options.bitDepth ?? 16;
  const framesPerPacket = options.framesPerPacket ?? 1;
  const bytesPerPacket =
    options.bytesPerPacket ?? channels * Math.ceil(bitDepth / 8) * framesPerPacket;
  const descriptionBytes = includeDescription ? 44 : 0;
  const dataBytes = includeData ? 16 + payload.byteLength : 0;
  const buffer = new ArrayBuffer(8 + descriptionBytes + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'caff');
  view.setUint16(4, 1, false);
  view.setUint16(6, 0, false);

  let chunkOffset = 8;
  if (includeDescription) {
    writeAscii(view, chunkOffset, 'desc');
    view.setBigInt64(chunkOffset + 4, 32n, false);
    const dataOffset = chunkOffset + 12;
    view.setFloat64(dataOffset, options.sampleRate ?? 48_000, false);
    writeAscii(view, dataOffset + 8, options.formatId ?? 'lpcm');
    view.setUint32(dataOffset + 12, options.flags ?? 0, false);
    view.setUint32(dataOffset + 16, bytesPerPacket, false);
    view.setUint32(dataOffset + 20, framesPerPacket, false);
    view.setUint32(dataOffset + 24, channels, false);
    view.setUint32(dataOffset + 28, bitDepth, false);
    chunkOffset += 44;
  }

  if (includeData) {
    writeAscii(view, chunkOffset, 'data');
    view.setBigInt64(
      chunkOffset + 4,
      options.dataChunkSize ?? BigInt(4 + payload.byteLength),
      false,
    );
    view.setUint32(chunkOffset + 12, 0, false);
    new Uint8Array(buffer, chunkOffset + 16).set(payload);
  }

  return buffer;
}

function int16Payload(values: readonly number[], littleEndian: boolean): Uint8Array {
  const buffer = new ArrayBuffer(values.length * 2);
  const view = new DataView(buffer);
  values.forEach((value, index) => {
    view.setInt16(index * 2, value, littleEndian);
  });
  return new Uint8Array(buffer);
}
