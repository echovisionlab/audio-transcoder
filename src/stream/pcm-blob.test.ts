import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectCustomPcmBlob,
  openCustomPcmBlobSource,
} from './pcm-blob.js';

const DEFAULT_INPUT_READ_BYTES = 8 * 1024 * 1024;
const DEFAULT_PCM_CHUNK_BYTES = 4 * 1024 * 1024;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streaming custom PCM Blob parser', () => {
  it('returns null for short and unrelated files', async () => {
    await expect(
      inspectCustomPcmBlob({ blob: new Blob(['short']) }),
    ).resolves.toBeNull();
    const unrelated = new Uint8Array(12);
    writeAscii(new DataView(unrelated.buffer), 0, 'NOPE');
    await expect(
      openCustomPcmBlobSource(
        { blob: new Blob([unrelated.buffer]) },
        DEFAULT_INPUT_READ_BYTES,
        DEFAULT_PCM_CHUNK_BYTES,
      ),
    ).resolves.toBeNull();
  });

  it('streams CAF signed PCM in bounded frame chunks', async () => {
    const values = new Int16Array(16_385);
    values[0] = 16_384;
    values[16_384] = -32_768;
    const payload = new Uint8Array(values.length * 2);
    const payloadView = new DataView(payload.buffer);
    values.forEach((value, index) => payloadView.setInt16(index * 2, value, false));
    const blob = new TrackingBlob([createCaf({ flags: 0, payload })]);

    const inspection = await inspectCustomPcmBlob({ blob });
    const source = await openCustomPcmBlobSource(
      { blob },
      DEFAULT_INPUT_READ_BYTES,
      DEFAULT_PCM_CHUNK_BYTES,
    );
    const chunks: Float32Array[] = [];
    for await (const chunk of source!.chunks()) {
      chunks.push(chunk);
    }

    expect(inspection).toMatchObject({
      bitDepth: 16,
      channels: 1,
      codec: 'lpcm signed integer BE',
      container: 'CAF',
      decodeSupport: 'built-in',
      sampleRate: 48_000,
      size: blob.size,
      sourceEncoding: {
        bitDepth: 16,
        endianness: 'big',
        kind: 'pcm',
        sampleFormat: 'integer',
        signedness: 'signed',
      },
    });
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(source).toMatchObject({
      channels: 1,
      sampleRate: 48_000,
      totalFrames: 16_385,
    });
    expect(chunks.map(({ length }) => length)).toEqual([16_384, 1]);
    expect(chunks[0]?.[0]).toBe(0.5);
    expect(chunks[1]?.[0]).toBe(-1);
    expect(Math.max(...blob.readSizes)).toBeLessThanOrEqual(32_768);
    expect(() => {
      source!.close();
      source!.close();
    }).not.toThrow();
  });

  it('bounds multichannel float64 source reads and decoded PCM chunks', async () => {
    const values = [
      0.25, -0.5, 1,
      -1, 0.125, -0.25,
      0.5, 0.75, -0.75,
      0, 1, -1,
      -0.125, 0.375, 0.625,
    ];
    const createTrackedBlob = (): TrackingBlob =>
      new TrackingBlob([
        createCaf({
          bitDepth: 64,
          channels: 3,
          flags: 1,
          payload: float64Bytes(values, false),
        }),
      ]);

    const readBoundedBlob = createTrackedBlob();
    const readBoundedSource = await openCustomPcmBlobSource(
      { blob: readBoundedBlob },
      48,
      60,
    );
    const readBoundedChunks = await collect(readBoundedSource!.chunks());

    expect(readBoundedChunks.map(({ length }) => length)).toEqual([6, 6, 3]);
    expect(Math.max(...readBoundedBlob.readSizes)).toBeLessThanOrEqual(48);
    expect(Math.max(...readBoundedChunks.map(({ byteLength }) => byteLength)))
      .toBeLessThanOrEqual(60);

    const pcmBoundedBlob = createTrackedBlob();
    const pcmBoundedSource = await openCustomPcmBlobSource(
      { blob: pcmBoundedBlob },
      120,
      36,
    );
    const pcmBoundedChunks = await collect(pcmBoundedSource!.chunks());

    expect(pcmBoundedChunks.map(({ length }) => length)).toEqual([9, 6]);
    expect(Math.max(...pcmBoundedBlob.readSizes)).toBeLessThanOrEqual(120);
    expect(Math.max(...pcmBoundedChunks.map(({ byteLength }) => byteLength)))
      .toBeLessThanOrEqual(36);
    expect(pcmBoundedChunks.flatMap((chunk) => [...chunk])).toEqual(values);
  });

  it.each([
    ['inputReadBytes', 23, 12],
    ['pcmChunkBytes', 24, 11],
  ] as const)(
    'rejects when %s cannot hold one multichannel float64 frame',
    async (name, inputReadBytes, pcmChunkBytes) => {
      const input = {
        blob: new Blob([
          createCaf({
            bitDepth: 64,
            channels: 3,
            flags: 1,
            payload: float64Bytes([0, 0, 0], false),
          }),
        ]),
      };

      await expect(
        openCustomPcmBlobSource(input, inputReadBytes, pcmChunkBytes),
      ).rejects.toMatchObject({
        code: 'INVALID_CONFIGURATION',
        message: expect.stringContaining(name),
      });
    },
  );

  it.each([
    ['inputReadBytes', 0, DEFAULT_PCM_CHUNK_BYTES],
    ['inputReadBytes', 1.5, DEFAULT_PCM_CHUNK_BYTES],
    ['pcmChunkBytes', DEFAULT_INPUT_READ_BYTES, 0],
    ['pcmChunkBytes', DEFAULT_INPUT_READ_BYTES, 1.5],
  ] as const)(
    'rejects an invalid %s limit',
    async (name, inputReadBytes, pcmChunkBytes) => {
      await expect(
        openCustomPcmBlobSource(
          { blob: new Blob([createCaf()]) },
          inputReadBytes,
          pcmChunkBytes,
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_CONFIGURATION',
        message: expect.stringContaining(name),
      });
    },
  );

  it.each([
    [0, 16, 0.5, false, 'signed integer BE', 'big', 'integer', 'signed'],
    [2, 16, -0.5, true, 'signed integer LE', 'little', 'integer', 'signed'],
    [1, 32, 0.25, false, 'float BE', 'big', 'float', 'not-applicable'],
    [3, 32, -0.75, true, 'float LE', 'little', 'float', 'not-applicable'],
  ] as const)(
    'decodes canonical CAF LPCM flags %#',
    async (
      flags,
      bitDepth,
      expected,
      littleEndian,
      label,
      endianness,
      sampleFormat,
      signedness,
    ) => {
      const payload = new Uint8Array(bitDepth / 8);
      const view = new DataView(payload.buffer);
      if (bitDepth === 32) {
        view.setFloat32(0, expected, littleEndian);
      } else {
        view.setInt16(0, expected * 32_768, littleEndian);
      }
      const input = {
        blob: new Blob([createCaf({ bitDepth, flags, payload })]),
      };

      const inspection = await inspectCustomPcmBlob(input);
      const source = await openCustomPcmBlobSource(
        input,
        DEFAULT_INPUT_READ_BYTES,
        DEFAULT_PCM_CHUNK_BYTES,
      );
      const [chunk] = await collect(source!.chunks());

      expect(inspection?.codec).toContain(label);
      expect(inspection?.sourceEncoding).toMatchObject({
        bitDepth,
        endianness,
        kind: 'pcm',
        sampleFormat,
        signedness,
      });
      expect(chunk?.[0]).toBe(expected);
    },
  );

  it('recognizes compressed CAF metadata without treating it as PCM', async () => {
    const input = {
      blob: new Blob([
        createCaf({
          bitDepth: 0,
          bytesPerPacket: 0,
          channels: 2,
          formatId: 'aac ',
          framesPerPacket: 1024,
          payload: new Uint8Array([1, 2]),
        }),
      ]),
    };

    await expect(inspectCustomPcmBlob(input)).resolves.toMatchObject({
      bitDepth: null,
      channels: 2,
      codec: 'aac',
      decodeSupport: 'browser-dependent',
      durationSeconds: null,
      notes: ['CAF format "aac " is not LPCM.'],
      sourceEncoding: {
        estimatedBitrateBps: null,
        codec: 'aac',
        kind: 'lossy-compressed',
      },
    });
    await expect(openCustomPcmBlobSource(
      input,
      DEFAULT_INPUT_READ_BYTES,
      DEFAULT_PCM_CHUNK_BYTES,
    )).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
    });
  });

  it('normalizes the streaming CAF MP3 FourCC to the canonical codec ID', async () => {
    const input = {
      blob: new Blob([
        createCaf({
          bitDepth: 0,
          bytesPerPacket: 0,
          channels: 2,
          formatId: '.mp3',
          framesPerPacket: 1_152,
          payload: new Uint8Array([1, 2]),
        }),
      ]),
    };

    await expect(inspectCustomPcmBlob(input)).resolves.toMatchObject({
      sourceEncoding: {
        codec: 'mp3',
        estimatedBitrateBps: null,
        kind: 'lossy-compressed',
      },
    });
  });

  it.each([
    [
      'alac',
      1,
      { bitDepth: 16, codec: 'alac', kind: 'lossless-compressed' },
    ],
    [
      'alac',
      2,
      { bitDepth: 20, codec: 'alac', kind: 'lossless-compressed' },
    ],
    [
      'alac',
      3,
      { bitDepth: 24, codec: 'alac', kind: 'lossless-compressed' },
    ],
    [
      'alac',
      4,
      { bitDepth: 32, codec: 'alac', kind: 'lossless-compressed' },
    ],
    [
      'alac',
      99,
      { bitDepth: null, codec: 'alac', kind: 'lossless-compressed' },
    ],
    ['flac', 0, { bitDepth: null, codec: 'flac', kind: 'lossless-compressed' }],
    ['flac', 1, { bitDepth: 16, codec: 'flac', kind: 'lossless-compressed' }],
    ['flac', 3, { bitDepth: 24, codec: 'flac', kind: 'lossless-compressed' }],
    [
      'opus',
      0,
      {
        codec: 'opus',
        estimatedBitrateBps: null,
        kind: 'lossy-compressed',
      },
    ],
    ['zzzz', 0, { kind: 'unknown' }],
  ] as const)('classifies streaming CAF codec %s', async (formatId, flags, sourceEncoding) => {
    const input = {
      blob: new Blob([
        createCaf({
          bitDepth: 0,
          bytesPerPacket: 0,
          channels: 2,
          flags,
          formatId,
          framesPerPacket: 1_024,
          payload: new Uint8Array([1, 2]),
        }),
      ]),
    };

    await expect(inspectCustomPcmBlob(input)).resolves.toMatchObject({
      sourceEncoding,
    });
  });

  it.each([
    ['unknown flag bits', { flags: 4 }],
    ['padded frames', { bytesPerPacket: 4 }],
    ['float representation', { bitDepth: 16, flags: 1 }],
    ['integer representation', { bitDepth: 64, flags: 0 }],
  ] as const)('reports unsupported CAF %s', async (_label, options) => {
    const input = {
      blob: new Blob([
        createCaf(options),
      ]),
    };
    const inspection = await inspectCustomPcmBlob(input);

    expect(inspection?.decodeSupport).toBe('browser-dependent');
    expect(inspection?.notes).toHaveLength(1);
    await expect(openCustomPcmBlobSource(
      input,
      DEFAULT_INPUT_READ_BYTES,
      DEFAULT_PCM_CHUNK_BYTES,
    )).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
    });
  });

  it('supports an indefinite final CAF data chunk and skips unknown chunks', async () => {
    const input = {
      blob: new Blob([
        createCaf({
          dataChunkSize: -1n,
          flags: 2,
          prefixChunks: [cafChunk('free', new Uint8Array([1, 2, 3]))],
          payload: int16Bytes([0, 16_384], true),
        }),
      ]),
    };
    const source = await openCustomPcmBlobSource(
      input,
      DEFAULT_INPUT_READ_BYTES,
      DEFAULT_PCM_CHUNK_BYTES,
    );
    const [chunk] = await collect(source!.chunks());

    expect(source?.totalFrames).toBe(2);
    expect([...chunk!]).toEqual([0, 0.5]);
  });

  it.each([
    ['small desc', { descSize: 31n }],
    ['data before desc', { dataFirst: true }],
    ['small data', { dataChunkSize: 3n }],
    ['missing desc', { includeDescription: false }],
    ['missing data', { includeData: false }],
    ['empty data', { payload: new Uint8Array() }],
    ['negative chunk', { descSize: -2n }],
    ['huge chunk', { descSize: BigInt(Number.MAX_SAFE_INTEGER) + 1n }],
    ['chunk past EOF', { descSize: 1_000n }],
  ] as const)('rejects malformed CAF: %s', async (_label, options) => {
    await expect(
      inspectCustomPcmBlob({ blob: new Blob([createCaf(options)]) }),
    ).rejects.toMatchObject({ code: 'INVALID_AUDIO_DATA' });
  });

  it.each([
    ['bit depth', { bitDepth: 12, bytesPerPacket: 2 }],
    ['fractional packet', { bytesPerPacket: 3, framesPerPacket: 2 }],
    ['zero frames per packet', { framesPerPacket: 0 }],
    ['undersized packet', { bytesPerPacket: 1, channels: 2 }],
    ['channels', { channels: 0 }],
    ['many channels', { channels: 33 }],
    ['sample rate', { sampleRate: 0 }],
    ['non-finite sample rate', { sampleRate: Number.POSITIVE_INFINITY }],
  ] as const)('rejects invalid CAF description: %s', async (_label, options) => {
    await expect(
      inspectCustomPcmBlob({
        blob: new Blob([
          createCaf({ ...options, payload: new Uint8Array([0, 0]) }),
        ]),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_AUDIO_DATA' });
  });

  it('streams standard AIFF and honors declared frames and SSND offsets', async () => {
    const input = {
      blob: new Blob([
        createAiff({
          frames: 1,
          prefixChunks: [aiffChunk('JUNK', new Uint8Array([1]))],
          payload: int16Bytes([16_384, -32_768], false),
          soundOffset: 2,
        }),
      ]),
    };
    const inspection = await inspectCustomPcmBlob(input);
    const source = await openCustomPcmBlobSource(
      input,
      DEFAULT_INPUT_READ_BYTES,
      DEFAULT_PCM_CHUNK_BYTES,
    );
    const [chunk] = await collect(source!.chunks());

    expect(inspection).toMatchObject({
      bitDepth: 16,
      channels: 1,
      codec: 'PCM signed integer BE',
      container: 'AIFF',
      decodeSupport: 'built-in',
      sourceEncoding: {
        bitDepth: 16,
        endianness: 'big',
        kind: 'pcm',
        sampleFormat: 'integer',
        signedness: 'signed',
      },
    });
    expect(source?.totalFrames).toBe(1);
    expect([...chunk!]).toEqual([0.5]);
  });

  it('inspects and streams custom PCM from bounded HTTP range reads', async () => {
    const bytes = new Uint8Array(createAiff({
      frames: 2,
      payload: int16Bytes([16_384, -32_768], false),
    }));
    const ranges: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (
      _request: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const range = new Headers(init?.headers).get('range');
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
      if (match === null) {
        return new Response(null, { status: 400 });
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      ranges.push(range!);
      return new Response(bytes.slice(start, end + 1), {
        headers: {
          'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
        },
        status: 206,
      });
    }));
    const input = {
      http: {
        size: bytes.byteLength,
        url: 'https://example.test/api/tools/youtube-audio/source',
      },
      name: 'remote.aiff',
    } as const;

    await expect(inspectCustomPcmBlob(input)).resolves.toMatchObject({
      container: 'AIFF',
      size: bytes.byteLength,
    });
    const source = await openCustomPcmBlobSource(
      input,
      DEFAULT_INPUT_READ_BYTES,
      DEFAULT_PCM_CHUNK_BYTES,
    );
    const [chunk] = await collect(source!.chunks());

    expect([...chunk!]).toEqual([0.5, -1]);
    expect(ranges.length).toBeGreaterThan(2);
    expect(ranges.every((range) => range.startsWith('bytes='))).toBe(true);
  });

  it('rejects a truncated HTTP PCM range body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new Uint8Array([1]),
      {
        headers: { 'Content-Range': 'bytes 0-11/12' },
        status: 206,
      },
    )));

    await expect(inspectCustomPcmBlob({
      http: {
        size: 12,
        url: 'https://example.test/api/tools/youtube-audio/source',
      },
    })).rejects.toMatchObject({ code: 'INVALID_AUDIO_DATA' });
  });

  it('supports uncompressed AIFC and reports compressed AIFC', async () => {
    const uncompressed = {
      blob: new Blob([
        createAiff({ formType: 'AIFC', compression: 'NONE' }),
      ]),
    };
    const compressed = {
      blob: new Blob([
        createAiff({ formType: 'AIFC', compression: 'ulaw' }),
      ]),
    };

    await expect(openCustomPcmBlobSource(
      uncompressed,
      DEFAULT_INPUT_READ_BYTES,
      DEFAULT_PCM_CHUNK_BYTES,
    )).resolves.toMatchObject({ totalFrames: 1 });
    await expect(inspectCustomPcmBlob(compressed)).resolves.toMatchObject({
      codec: 'Compression ulaw',
      decodeSupport: 'browser-dependent',
      notes: ['AIFC compression "ulaw" is unsupported.'],
      sourceEncoding: {
        estimatedBitrateBps: null,
        codec: 'ulaw',
        kind: 'lossy-compressed',
      },
    });
    await expect(openCustomPcmBlobSource(
      compressed,
      DEFAULT_INPUT_READ_BYTES,
      DEFAULT_PCM_CHUNK_BYTES,
    )).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
    });
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
    'classifies streaming AIFC compression %s',
    async (compression, bitDepth, sourceEncoding) => {
      const input = {
        blob: new Blob([
          createAiff({
            bitDepth,
            compression,
            formType: 'AIFC',
            payload: new Uint8Array(bitDepth / 8),
          }),
        ]),
      };

      await expect(inspectCustomPcmBlob(input)).resolves.toMatchObject({
        sourceEncoding,
      });
    },
  );

  it.each([
    ['small COMM', { commonChunkSize: 17 }],
    ['SSND before COMM', { soundFirst: true }],
    ['small SSND', { soundChunkSize: 7 }],
    ['large SSND offset', { soundChunkSize: 8, soundOffset: 1 }],
    ['missing COMM', { includeCommon: false }],
    ['missing SSND', { includeSound: false }],
    ['empty SSND', { frames: 0, payload: new Uint8Array() }],
  ] as const)('rejects malformed AIFF: %s', async (_label, options) => {
    await expect(
      inspectCustomPcmBlob({ blob: new Blob([createAiff(options)]) }),
    ).rejects.toMatchObject({ code: 'INVALID_AUDIO_DATA' });
  });

  it.each([
    ['bit depth', { bitDepth: 12 }],
    ['channels', { channels: 0 }],
    ['many channels', { channels: 33 }],
    ['sample rate', { sampleRate: 0 }],
  ] as const)('rejects invalid AIFF description: %s', async (_label, options) => {
    await expect(
      inspectCustomPcmBlob({ blob: new Blob([createAiff(options)]) }),
    ).rejects.toMatchObject({ code: 'INVALID_AUDIO_DATA' });
  });

  it('maps cancellation before and during bounded reads', async () => {
    const bytes = createCaf({ flags: 2, payload: int16Bytes([0], true) });
    const before = new AbortController();
    before.abort('before read');
    await expect(
      inspectCustomPcmBlob({ blob: new Blob([bytes]) }, before.signal),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'before read',
    });

    const during = new AbortController();
    const source = await openCustomPcmBlobSource(
      { blob: new Blob([bytes]) },
      DEFAULT_INPUT_READ_BYTES,
      DEFAULT_PCM_CHUNK_BYTES,
    );
    during.abort('during read');
    await expect(collect(source!.chunks(during.signal))).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'during read',
    });
  });

  it('rejects a truncated browser range read', async () => {
    const blob = new TruncatedBlob([createCaf()]);
    await expect(inspectCustomPcmBlob({ blob })).rejects.toMatchObject({
      code: 'INVALID_AUDIO_DATA',
      message: expect.stringContaining('truncated'),
    });
  });

  it('rejects a Blob whose reported size shrinks during a range read', async () => {
    const blob = new ShrinkingBlob([createCaf()]);
    await expect(inspectCustomPcmBlob({ blob })).rejects.toMatchObject({
      code: 'INVALID_AUDIO_DATA',
      message: expect.stringContaining('outside'),
    });
  });
});

interface CafOptions {
  readonly bitDepth?: number;
  readonly bytesPerPacket?: number;
  readonly channels?: number;
  readonly dataChunkSize?: bigint;
  readonly dataFirst?: boolean;
  readonly descSize?: bigint;
  readonly flags?: number;
  readonly formatId?: string;
  readonly framesPerPacket?: number;
  readonly includeData?: boolean;
  readonly includeDescription?: boolean;
  readonly payload?: Uint8Array;
  readonly prefixChunks?: readonly Uint8Array[];
  readonly sampleRate?: number;
}

function createCaf(options: CafOptions = {}): ArrayBuffer {
  const bitDepth = options.bitDepth ?? 16;
  const channels = options.channels ?? 1;
  const framesPerPacket = options.framesPerPacket ?? 1;
  const bytesPerPacket =
    options.bytesPerPacket ?? channels * Math.ceil(bitDepth / 8) * framesPerPacket;
  const payload = options.payload ?? new Uint8Array([0, 0]);
  const description = new Uint8Array(32);
  const descriptionView = new DataView(description.buffer);
  descriptionView.setFloat64(0, options.sampleRate ?? 48_000, false);
  writeAscii(descriptionView, 8, options.formatId ?? 'lpcm');
  descriptionView.setUint32(12, options.flags ?? 0, false);
  descriptionView.setUint32(16, bytesPerPacket, false);
  descriptionView.setUint32(20, framesPerPacket, false);
  descriptionView.setUint32(24, channels, false);
  descriptionView.setUint32(28, bitDepth, false);
  const desc = cafChunk('desc', description, options.descSize);
  const dataPayload = concat([new Uint8Array(4), payload]);
  const data = cafChunk('data', dataPayload, options.dataChunkSize);
  const chunks: Uint8Array[] = [...(options.prefixChunks ?? [])];
  const appendDescription = (): void => {
    if (options.includeDescription !== false) {
      chunks.push(desc);
    }
  };
  const appendData = (): void => {
    if (options.includeData !== false) {
      chunks.push(data);
    }
  };
  if (options.dataFirst) {
    appendData();
    appendDescription();
  } else {
    appendDescription();
    appendData();
  }
  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  writeAscii(headerView, 0, 'caff');
  headerView.setUint16(4, 1, false);
  return concat([header, ...chunks]).buffer as ArrayBuffer;
}

function cafChunk(
  type: string,
  payload: Uint8Array,
  encodedSize: bigint = BigInt(payload.length),
): Uint8Array {
  const chunk = new Uint8Array(12 + payload.length);
  const view = new DataView(chunk.buffer);
  writeAscii(view, 0, type);
  view.setBigInt64(4, encodedSize, false);
  chunk.set(payload, 12);
  return chunk;
}

interface AiffOptions {
  readonly bitDepth?: number;
  readonly channels?: number;
  readonly commonChunkSize?: number;
  readonly compression?: string;
  readonly formType?: 'AIFC' | 'AIFF';
  readonly frames?: number;
  readonly includeCommon?: boolean;
  readonly includeSound?: boolean;
  readonly payload?: Uint8Array;
  readonly prefixChunks?: readonly Uint8Array[];
  readonly sampleRate?: number;
  readonly soundChunkSize?: number;
  readonly soundFirst?: boolean;
  readonly soundOffset?: number;
}

function createAiff(options: AiffOptions = {}): ArrayBuffer {
  const formType = options.formType ?? 'AIFF';
  const commonSize = options.commonChunkSize ?? (formType === 'AIFC' ? 22 : 18);
  const commonPayload = new Uint8Array(commonSize);
  if (commonSize >= 18) {
    const view = new DataView(commonPayload.buffer);
    view.setUint16(0, options.channels ?? 1, false);
    view.setUint32(2, options.frames ?? 1, false);
    view.setUint16(6, options.bitDepth ?? 16, false);
    writeExtended80(view, 8, options.sampleRate ?? 48_000);
    if (commonSize >= 22) {
      writeAscii(view, 18, options.compression ?? 'NONE');
    }
  }
  const common = aiffChunk('COMM', commonPayload, commonSize);
  const soundOffset = options.soundOffset ?? 0;
  const payload = options.payload ?? new Uint8Array([0, 0]);
  const soundPayload = concat([
    uint32Bytes(soundOffset),
    new Uint8Array(4),
    new Uint8Array(soundOffset),
    payload,
  ]);
  const sound = aiffChunk(
    'SSND',
    soundPayload,
    options.soundChunkSize ?? soundPayload.length,
  );
  const selected: Uint8Array[] = [...(options.prefixChunks ?? [])];
  const appendCommon = (): void => {
    if (options.includeCommon !== false) {
      selected.push(common);
    }
  };
  const appendSound = (): void => {
    if (options.includeSound !== false) {
      selected.push(sound);
    }
  };
  if (options.soundFirst) {
    appendSound();
    appendCommon();
  } else {
    appendCommon();
    appendSound();
  }
  const body = concat(selected);
  const header = new Uint8Array(12);
  const headerView = new DataView(header.buffer);
  writeAscii(headerView, 0, 'FORM');
  headerView.setUint32(4, body.length + 4, false);
  writeAscii(headerView, 8, formType);
  return concat([header, body]).buffer as ArrayBuffer;
}

function aiffChunk(
  id: string,
  payload: Uint8Array,
  declaredSize = payload.length,
): Uint8Array {
  const chunk = new Uint8Array(8 + payload.length + (payload.length % 2));
  const view = new DataView(chunk.buffer);
  writeAscii(view, 0, id);
  view.setUint32(4, declaredSize, false);
  chunk.set(payload, 8);
  return chunk;
}

function int16Bytes(values: readonly number[], littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setInt16(index * 2, value, littleEndian));
  return bytes;
}

function float64Bytes(
  values: readonly number[],
  littleEndian: boolean,
): Uint8Array {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) =>
    view.setFloat64(index * 8, value, littleEndian));
  return bytes;
}

function uint32Bytes(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function writeExtended80(view: DataView, offset: number, value: number): void {
  if (value === 0) {
    return;
  }
  const power = Math.floor(Math.log2(value));
  const exponent = power + 16_383;
  const mantissa = BigInt(Math.round((value / 2 ** power) * 2 ** 63));
  view.setUint16(offset, exponent, false);
  view.setUint32(offset + 2, Number((mantissa >> 32n) & 0xffff_ffffn), false);
  view.setUint32(offset + 6, Number(mantissa & 0xffff_ffffn), false);
}

async function collect(
  chunks: AsyncIterable<Float32Array>,
): Promise<Float32Array[]> {
  const result: Float32Array[] = [];
  for await (const chunk of chunks) {
    result.push(chunk);
  }
  return result;
}

class TrackingBlob extends Blob {
  readonly readSizes: number[] = [];

  override slice(start?: number, end?: number, contentType?: string): Blob {
    this.readSizes.push((end ?? this.size) - (start ?? 0));
    return super.slice(start, end, contentType);
  }
}

class TruncatedBlob extends Blob {
  override slice(): Blob {
    return new Blob();
  }
}

class ShrinkingBlob extends Blob {
  private sizeReads = 0;

  override get size(): number {
    this.sizeReads += 1;
    return this.sizeReads === 1 ? super.size : 0;
  }
}
