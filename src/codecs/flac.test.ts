import { describe, expect, it } from 'vitest';
import { createAudioTranscoderEngine } from '../index.js';
import { writeAscii } from './binary.js';
import { flacInspector } from './flac.js';

const engine = createAudioTranscoderEngine();

describe('FLAC header inspection', () => {
  it('reads STREAMINFO metadata', () => {
    const data = createFlac({
      bitDepth: 24,
      channels: 2,
      sampleRate: 48_000,
      totalSamples: 96_000,
    });

    expect(engine.inspect({ data })).toEqual({
      bitDepth: 24,
      channels: 2,
      codec: 'FLAC',
      container: 'FLAC',
      decodeSupport: 'browser-dependent',
      durationSeconds: 2,
      notes: ['FLAC audio data requires a browser decoder or codec plugin.'],
      sampleRate: 48_000,
      sourceEncoding: {
        bitDepth: 24,
        codec: 'flac',
        kind: 'lossless-compressed',
      },
    });
  });

  it('skips unrelated metadata blocks before STREAMINFO', () => {
    const streamInfo = new Uint8Array(
      createFlac({ bitDepth: 16, channels: 1, sampleRate: 44_100, totalSamples: 44_100 }),
      4,
    );
    const data = new ArrayBuffer(4 + 5 + streamInfo.byteLength);
    const view = new DataView(data);
    writeAscii(view, 0, 'fLaC');
    view.setUint8(4, 4);
    view.setUint8(7, 1);
    view.setUint8(8, 0);
    new Uint8Array(data, 9).set(streamInfo);

    expect(flacInspector.inspect({ data })?.sampleRate).toBe(44_100);
  });

  it('reports missing, truncated, and zero-valued STREAMINFO safely', () => {
    const missing = new Uint8Array([
      0x66, 0x4c, 0x61, 0x43, 0x84, 0, 0, 0,
    ]).buffer;
    const truncated = new Uint8Array([
      0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, 0,
    ]).buffer;
    const zeroRate = createFlac({
      bitDepth: 16,
      channels: 1,
      sampleRate: 0,
      totalSamples: 1,
    });
    const zeroSamples = createFlac({
      bitDepth: 16,
      channels: 1,
      sampleRate: 48_000,
      totalSamples: 0,
    });

    for (const data of [missing, truncated]) {
      expect(flacInspector.inspect({ data })).toMatchObject({
        bitDepth: null,
        durationSeconds: null,
        notes: ['FLAC STREAMINFO metadata was not found.'],
        sourceEncoding: {
          bitDepth: null,
          codec: 'flac',
          kind: 'lossless-compressed',
        },
      });
    }
    expect(flacInspector.inspect({ data: zeroRate })?.durationSeconds).toBeNull();
    expect(flacInspector.inspect({ data: zeroSamples })?.durationSeconds).toBeNull();
  });

  it('returns null for unrelated input', () => {
    expect(
      flacInspector.inspect({ data: new Uint8Array([1, 2, 3]).buffer }),
    ).toBeNull();
  });
});

interface FlacFixtureOptions {
  readonly bitDepth: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly totalSamples: number;
}

function createFlac(options: FlacFixtureOptions): ArrayBuffer {
  const buffer = new ArrayBuffer(42);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'fLaC');
  view.setUint8(4, 0x80);
  view.setUint8(5, 0);
  view.setUint8(6, 0);
  view.setUint8(7, 34);

  const packed =
    (BigInt(options.sampleRate) << 44n) |
    (BigInt(options.channels - 1) << 41n) |
    (BigInt(options.bitDepth - 1) << 36n) |
    BigInt(options.totalSamples);
  view.setBigUint64(18, packed, false);
  return buffer;
}
