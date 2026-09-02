import { describe, expect, it } from 'vitest';
import { writeAscii } from './binary.js';
import { mp3Inspector } from './mp3.js';

describe('MP3 header inspection', () => {
  it('reads a naked MPEG-1 Layer III frame', () => {
    const data = createMp3Frame({
      bitrateIndex: 9,
      channelMode: 0,
      layerBits: 1,
      sampleRateIndex: 0,
      versionBits: 3,
    });
    const inspection = mp3Inspector.inspect({ data, size: 16_000 });

    expect(inspection).toEqual({
      bitDepth: null,
      channels: 2,
      codec: 'MPEG-1 Layer III',
      container: 'MP3',
      decodeSupport: 'likely-browser',
      durationSeconds: 1,
      notes: ['Estimated bitrate 128 kbps.'],
      sampleRate: 44_100,
      sourceEncoding: {
        estimatedBitrateBps: 128_000,
        codec: 'mp3',
        kind: 'lossy-compressed',
      },
    });
  });

  it('skips a synchsafe ID3 tag and detects mono MPEG-2 audio', () => {
    const frame = new Uint8Array(
      createMp3Frame({
        bitrateIndex: 8,
        channelMode: 3,
        layerBits: 1,
        sampleRateIndex: 1,
        versionBits: 2,
      }),
    );
    const data = createId3File(frame, 1);
    const inspection = mp3Inspector.inspect({ data });

    expect(inspection).toMatchObject({
      channels: 1,
      codec: 'MPEG-2 Layer III',
      notes: ['Estimated bitrate 64 kbps.'],
      sampleRate: 24_000,
      sourceEncoding: {
        estimatedBitrateBps: 64_000,
        codec: 'mp3',
        kind: 'lossy-compressed',
      },
    });
  });

  it.each([
    [1, 1, 0, 0, 'MPEG-2.5 Layer III', 11_025],
  ] as const)(
    'handles bitrate=%i layer=%i version=%i sample-index=%i',
    (bitrateIndex, layerBits, versionBits, sampleRateIndex, codec, sampleRate) => {
      const data = createMp3Frame({
        bitrateIndex,
        channelMode: 0,
        layerBits,
        sampleRateIndex,
        versionBits,
      });
      const inspection = mp3Inspector.inspect({ data, size: 0 });

      expect(inspection).toMatchObject({ codec, sampleRate });
      expect(inspection?.durationSeconds).toBe(0);
    },
  );

  it('reports an ID3-tagged input without a visible frame', () => {
    const data = createId3File(new Uint8Array(), 0);

    expect(mp3Inspector.inspect({ data })).toEqual({
      bitDepth: null,
      channels: null,
      codec: 'Unknown',
      container: 'ID3',
      decodeSupport: 'unknown',
      durationSeconds: null,
      notes: ['ID3 metadata was found, but no MPEG Layer III frame was found.'],
      sampleRate: null,
      sourceEncoding: { kind: 'unknown' },
    });
  });

  it('returns null for unrelated or invalid frame data', () => {
    expect(mp3Inspector.inspect({ data: new Uint8Array([1, 2, 3]).buffer })).toBeNull();
    for (const options of [
      {
        bitrateIndex: 0,
        channelMode: 0,
        layerBits: 1,
        sampleRateIndex: 0,
        versionBits: 3,
      },
      {
        bitrateIndex: 1,
        channelMode: 0,
        layerBits: 1,
        sampleRateIndex: 0,
        versionBits: 1,
      },
      {
        bitrateIndex: 1,
        channelMode: 0,
        layerBits: 0,
        sampleRateIndex: 0,
        versionBits: 3,
      },
      {
        bitrateIndex: 1,
        channelMode: 0,
        layerBits: 2,
        sampleRateIndex: 0,
        versionBits: 3,
      },
      {
        bitrateIndex: 1,
        channelMode: 0,
        layerBits: 3,
        sampleRateIndex: 0,
        versionBits: 3,
      },
      {
        bitrateIndex: 15,
        channelMode: 0,
        layerBits: 1,
        sampleRateIndex: 0,
        versionBits: 3,
      },
      {
        bitrateIndex: 1,
        channelMode: 0,
        layerBits: 1,
        sampleRateIndex: 3,
        versionBits: 3,
      },
    ]) {
      expect(mp3Inspector.inspect({ data: createMp3Frame(options) })).toBeNull();
    }
  });

  it('rejects a truncated header and an isolated sync pattern in longer data', () => {
    const frame = createMp3Frame({
      bitrateIndex: 9,
      channelMode: 0,
      layerBits: 1,
      sampleRateIndex: 0,
      versionBits: 3,
    });
    expect(mp3Inspector.inspect({ data: frame.slice(0, 4) })).toBeNull();

    const isolatedSync = new Uint8Array(frame.byteLength + 1);
    isolatedSync.set(new Uint8Array(frame, 0, 4));
    expect(mp3Inspector.inspect({ data: isolatedSync.buffer })).toBeNull();
  });

  it('accepts adjacent compatible Layer III frames with variable bitrate', () => {
    const first = new Uint8Array(
      createMp3Frame({
        bitrateIndex: 9,
        channelMode: 0,
        layerBits: 1,
        sampleRateIndex: 0,
        versionBits: 3,
      }),
    );
    const second = new Uint8Array(
      createMp3Frame({
        bitrateIndex: 10,
        channelMode: 0,
        layerBits: 1,
        sampleRateIndex: 0,
        versionBits: 3,
      }),
    );
    const data = new Uint8Array(first.byteLength + second.byteLength);
    data.set(first);
    data.set(second, first.byteLength);

    expect(mp3Inspector.inspect({ data: data.buffer })).toMatchObject({
      codec: 'MPEG-1 Layer III',
      sourceEncoding: {
        estimatedBitrateBps: 128_000,
        codec: 'mp3',
        kind: 'lossy-compressed',
      },
    });
  });

  it('uses the padding bit when validating the complete frame boundary', () => {
    const data = createMp3Frame({
      bitrateIndex: 9,
      channelMode: 0,
      layerBits: 1,
      padding: 1,
      sampleRateIndex: 0,
      versionBits: 3,
    });

    expect(mp3Inspector.inspect({ data })).toMatchObject({
      codec: 'MPEG-1 Layer III',
      sampleRate: 44_100,
    });
  });
});

interface Mp3HeaderOptions {
  readonly bitrateIndex: number;
  readonly channelMode: number;
  readonly layerBits: number;
  readonly padding?: number;
  readonly sampleRateIndex: number;
  readonly versionBits: number;
}

function createMp3Frame(options: Mp3HeaderOptions): ArrayBuffer {
  const sampleRates = [44_100, 48_000, 32_000];
  const mpeg1Bitrates = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
  ];
  const mpeg2Bitrates = [
    0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
  ];
  const baseSampleRate = sampleRates[options.sampleRateIndex] ?? 44_100;
  const sampleRate =
    options.versionBits === 3
      ? baseSampleRate
      : options.versionBits === 2
        ? baseSampleRate / 2
        : baseSampleRate / 4;
  const bitrate =
    (options.versionBits === 3 ? mpeg1Bitrates : mpeg2Bitrates)[
      options.bitrateIndex
    ] ?? 0;
  const coefficient = options.versionBits === 3 ? 144_000 : 72_000;
  const validFrameLength =
    Math.floor((coefficient * bitrate) / sampleRate) + (options.padding ?? 0);
  const buffer = new ArrayBuffer(Math.max(4, validFrameLength));
  const view = new DataView(buffer);
  const header =
    0xffe00000 |
    (options.versionBits << 19) |
    (options.layerBits << 17) |
    (1 << 16) |
    (options.bitrateIndex << 12) |
    (options.sampleRateIndex << 10) |
    ((options.padding ?? 0) << 9) |
    (options.channelMode << 6);
  view.setUint32(0, header >>> 0, false);
  return buffer;
}

function createId3File(frame: Uint8Array, tagSize: number): ArrayBuffer {
  const buffer = new ArrayBuffer(10 + tagSize + frame.byteLength);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'ID3');
  view.setUint8(3, 4);
  view.setUint8(9, tagSize & 0x7f);
  new Uint8Array(buffer, 10 + tagSize).set(frame);
  return buffer;
}
