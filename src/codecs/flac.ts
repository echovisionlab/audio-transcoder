import type {
  AudioInput,
  AudioInspection,
} from '../engine/contracts.js';
import { readAscii, readUint64BE } from './binary.js';
import type { AudioInspectorAdapter } from './contracts.js';

interface FlacStreamInfo {
  readonly bitDepth: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly totalSamples: number;
}

export const flacInspector: AudioInspectorAdapter = Object.freeze({
  formats: Object.freeze(['flac']),
  id: 'builtin.flac.inspector',
  inspect(input: AudioInput): AudioInspection | null {
    const view = new DataView(input.data);
    if (readAscii(view, 0, 4) !== 'fLaC') {
      return null;
    }

    const info = readStreamInfo(view);
    return {
      bitDepth: info?.bitDepth ?? null,
      channels: info?.channels ?? null,
      codec: 'FLAC',
      container: 'FLAC',
      decodeSupport: 'browser-dependent',
      durationSeconds:
        info !== null && info.sampleRate > 0 && info.totalSamples > 0
          ? info.totalSamples / info.sampleRate
          : null,
      notes:
        info === null
          ? ['FLAC STREAMINFO metadata was not found.']
          : ['FLAC audio data requires a browser decoder or codec plugin.'],
      sampleRate: info?.sampleRate ?? null,
      sourceEncoding: Object.freeze({
        bitDepth: info?.bitDepth ?? null,
        codec: 'flac',
        kind: 'lossless-compressed',
      }),
    };
  },
});

function readStreamInfo(view: DataView): FlacStreamInfo | null {
  let offset = 4;

  while (offset + 4 <= view.byteLength) {
    const header = view.getUint8(offset);
    const isLast = Boolean(header & 0x80);
    const type = header & 0x7f;
    const length =
      (view.getUint8(offset + 1) << 16) |
      (view.getUint8(offset + 2) << 8) |
      view.getUint8(offset + 3);
    const dataOffset = offset + 4;

    if (type === 0 && length >= 34 && dataOffset + 34 <= view.byteLength) {
      const packed = readUint64BE(view, dataOffset + 10);
      return {
        bitDepth: Number((packed >> 36n) & 0x1fn) + 1,
        channels: Number((packed >> 41n) & 0x7n) + 1,
        sampleRate: Number((packed >> 44n) & 0xfffffn),
        totalSamples: Number(packed & ((1n << 36n) - 1n)),
      };
    }

    offset = dataOffset + length;
    if (isLast) {
      break;
    }
  }

  return null;
}
