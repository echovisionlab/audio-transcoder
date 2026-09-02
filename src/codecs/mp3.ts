import type {
  AudioInput,
  AudioInspection,
} from '../engine/contracts.js';
import { readAscii } from './binary.js';
import type { AudioInspectorAdapter } from './contracts.js';

const MPEG_1_LAYER_3_BITRATES = Object.freeze([
  null,
  32,
  40,
  48,
  56,
  64,
  80,
  96,
  112,
  128,
  160,
  192,
  224,
  256,
  320,
]);
const MPEG_2_LAYER_3_BITRATES = Object.freeze([
  null,
  8,
  16,
  24,
  32,
  40,
  48,
  56,
  64,
  80,
  96,
  112,
  128,
  144,
  160,
]);

export const mp3Inspector: AudioInspectorAdapter = Object.freeze({
  formats: Object.freeze(['mp3']),
  id: 'builtin.mp3.inspector',
  inspect(input: AudioInput): AudioInspection | null {
    const view = new DataView(input.data);
    const hasId3 = readAscii(view, 0, 3) === 'ID3';
    const frame = findMp3Frame(view);
    if (!hasId3 && frame === null) {
      return null;
    }

    if (frame === null) {
      return {
        bitDepth: null,
        channels: null,
        codec: 'Unknown',
        container: 'ID3',
        decodeSupport: 'unknown',
        durationSeconds: null,
        notes: ['ID3 metadata was found, but no MPEG Layer III frame was found.'],
        sampleRate: null,
        sourceEncoding: Object.freeze({ kind: 'unknown' }),
      };
    }

    const { bitrate, channelMode, offset: frameOffset, sampleRate, versionBits } =
      frame;
    const version =
      versionBits === 3
        ? 'MPEG-1'
        : versionBits === 2
          ? 'MPEG-2'
          : 'MPEG-2.5';
    const layer = 'Layer III';
    const audioBytes = Math.max(
      0,
      (input.size ?? input.data.byteLength) - frameOffset,
    );

    return {
      bitDepth: null,
      channels: channelMode === 3 ? 1 : 2,
      codec: `${version} ${layer}`,
      container: 'MP3',
      decodeSupport: 'likely-browser',
      durationSeconds: (audioBytes * 8) / (bitrate * 1000),
      notes: [`Estimated bitrate ${bitrate} kbps.`],
      sampleRate,
      sourceEncoding: Object.freeze({
        estimatedBitrateBps: bitrate * 1000,
        codec: 'mp3',
        kind: 'lossy-compressed',
      }),
    };
  },
});

interface Mp3Frame {
  readonly bitrate: number;
  readonly channelMode: number;
  readonly frameLength: number;
  readonly offset: number;
  readonly sampleRate: number;
  readonly sampleRateIndex: number;
  readonly versionBits: number;
}

function parseMp3Frame(view: DataView, offset: number): Mp3Frame | null {
  if (offset + 4 > view.byteLength) {
    return null;
  }
  const header = view.getUint32(offset, false);
  const versionBits = (header >> 19) & 0x3;
  const layerBits = (header >> 17) & 0x3;
  const bitrateIndex = (header >> 12) & 0xf;
  const sampleRateIndex = (header >> 10) & 0x3;
  if (
    header >>> 21 !== 0x7ff ||
    versionBits === 1 ||
    layerBits !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3
  ) {
    return null;
  }
  const bitrate = mp3Bitrate(versionBits, bitrateIndex);
  const sampleRate = mp3SampleRate(versionBits, sampleRateIndex);
  const padding = (header >> 9) & 0x1;
  const coefficient = versionBits === 3 ? 144_000 : 72_000;
  const frameLength = Math.floor((coefficient * bitrate) / sampleRate) + padding;
  if (offset + frameLength > view.byteLength) {
    return null;
  }
  return {
    bitrate,
    channelMode: (header >> 6) & 0x3,
    frameLength,
    offset,
    sampleRate,
    sampleRateIndex,
    versionBits,
  };
}

function findMp3Frame(view: DataView): Mp3Frame | null {
  let offset = 0;
  if (readAscii(view, 0, 3) === 'ID3' && view.byteLength >= 10) {
    offset = 10 + readSynchsafeInteger(view, 6);
  }

  for (let index = offset; index + 4 <= view.byteLength; index += 1) {
    const frame = parseMp3Frame(view, index);
    if (frame === null) {
      continue;
    }
    const nextOffset = index + frame.frameLength;
    if (nextOffset === view.byteLength) {
      return frame;
    }
    // A lone frame followed by tags or arbitrary bytes is deliberately not
    // enough evidence. Files with trailing metadata need two coherent frames.
    const nextFrame = parseMp3Frame(view, nextOffset);
    if (
      nextFrame !== null &&
      nextFrame.versionBits === frame.versionBits &&
      nextFrame.sampleRateIndex === frame.sampleRateIndex
    ) {
      return frame;
    }
  }
  return null;
}

function readSynchsafeInteger(view: DataView, offset: number): number {
  return (
    (view.getUint8(offset) << 21) |
    (view.getUint8(offset + 1) << 14) |
    (view.getUint8(offset + 2) << 7) |
    view.getUint8(offset + 3)
  );
}

function mp3SampleRate(versionBits: number, index: number): number {
  const base = [44_100, 48_000, 32_000][index]!;
  if (versionBits === 3) {
    return base;
  }
  if (versionBits === 2) {
    return base / 2;
  }
  return base / 4;
}

function mp3Bitrate(versionBits: number, index: number): number {
  const table =
    versionBits === 3
      ? MPEG_1_LAYER_3_BITRATES
      : MPEG_2_LAYER_3_BITRATES;
  return table[index]!;
}
