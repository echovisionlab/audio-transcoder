import { describe, expect, it } from 'vitest';
import {
  readAscii,
  readExtended80,
  readInt24BE,
  readInt24LE,
  readInt64BE,
  readUint64BE,
  writeAscii,
  writeExtended80,
  writeInt24BE,
  writeInt24LE,
} from './binary.js';
import {
  readPcmSample,
  sampleToInteger,
  validatePcmAudio,
} from './pcm.js';

describe('binary primitives', () => {
  it('reads and writes bounded ASCII', () => {
    const view = new DataView(new ArrayBuffer(4));
    writeAscii(view, 0, 'RIFF');

    expect(readAscii(view, 0, 4)).toBe('RIFF');
    expect(readAscii(view, -1, 1)).toBe('');
    expect(readAscii(view, 0, -1)).toBe('');
    expect(readAscii(view, 1, 4)).toBe('');
  });

  it('round-trips signed 24-bit integers in both byte orders', () => {
    const view = new DataView(new ArrayBuffer(12));
    writeInt24LE(view, 0, 0x123456);
    writeInt24LE(view, 3, -2);
    writeInt24BE(view, 6, 0x123456);
    writeInt24BE(view, 9, -2);

    expect(readInt24LE(view, 0)).toBe(0x123456);
    expect(readInt24LE(view, 3)).toBe(-2);
    expect(readInt24BE(view, 6)).toBe(0x123456);
    expect(readInt24BE(view, 9)).toBe(-2);
  });

  it('reads signed and unsigned 64-bit big-endian integers', () => {
    const positive = new DataView(
      new Uint8Array([0, 0, 0, 0, 0, 0, 1, 2]).buffer,
    );
    const negative = new DataView(
      new Uint8Array([255, 255, 255, 255, 255, 255, 255, 254]).buffer,
    );

    expect(readUint64BE(positive, 0)).toBe(258n);
    expect(readInt64BE(negative, 0)).toBe(-2n);
  });

  it('round-trips zero, positive, and negative extended 80-bit values', () => {
    const view = new DataView(new ArrayBuffer(30));
    writeExtended80(view, 0, 0);
    writeExtended80(view, 10, 48_000);
    writeExtended80(view, 20, -44_100);

    expect(readExtended80(view, 0)).toBe(0);
    expect(readExtended80(view, 10)).toBeCloseTo(48_000, 8);
    expect(readExtended80(view, 20)).toBeCloseTo(-44_100, 8);
  });
});

describe('PCM primitives', () => {
  it('reads supported integer sample widths and byte orders', () => {
    const view = new DataView(new ArrayBuffer(16));
    view.setUint8(0, 255);
    view.setInt8(1, -64);
    view.setInt16(2, 16_384, true);
    writeInt24LE(view, 4, -4_194_304);
    writeInt24BE(view, 7, 4_194_304);
    view.setInt32(10, -1_073_741_824, false);

    expect(readPcmSample(view, 0, 8, integer(true, false))).toBeCloseTo(
      127 / 128,
    );
    expect(readPcmSample(view, 1, 8, integer(true, true))).toBe(-0.5);
    expect(readPcmSample(view, 2, 16, integer(true, true))).toBe(0.5);
    expect(readPcmSample(view, 4, 24, integer(true, true))).toBe(-0.5);
    expect(readPcmSample(view, 7, 24, integer(false, true))).toBe(0.5);
    expect(readPcmSample(view, 10, 32, integer(false, true))).toBe(-0.5);
  });

  it('reads 32-bit and 64-bit floating-point samples', () => {
    const view = new DataView(new ArrayBuffer(12));
    view.setFloat32(0, 0.25, true);
    view.setFloat64(4, -0.75, false);

    expect(readPcmSample(view, 0, 32, floating(true))).toBe(0.25);
    expect(readPcmSample(view, 4, 64, floating(false))).toBe(-0.75);
  });

  it('rejects unsupported integer and floating-point sample widths', () => {
    const view = new DataView(new ArrayBuffer(8));

    expect(() => readPcmSample(view, 0, 12, integer(true, true))).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_INPUT' }),
    );
    expect(() => readPcmSample(view, 0, 24, floating(true))).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_INPUT' }),
    );
    for (const bitDepth of [16, 24, 32]) {
      expect(() =>
        readPcmSample(view, 0, bitDepth, integer(true, false)),
      ).toThrowError(
        expect.objectContaining({
          code: 'UNSUPPORTED_INPUT',
          message: expect.stringContaining('unsigned'),
        }),
      );
    }
  });

  it('clips and scales integer output symmetrically', () => {
    expect(sampleToInteger(-2, 16)).toBe(-32_768);
    expect(sampleToInteger(-0.5, 16)).toBe(-16_384);
    expect(sampleToInteger(0.5, 16)).toBe(16_384);
    expect(sampleToInteger(2, 16)).toBe(32_767);
  });

  it('validates PCM shape and sample rate', () => {
    expect(
      validatePcmAudio({
        channelData: [new Float32Array([0]), new Float32Array([0])],
        sampleRate: 48_000,
      }),
    ).toEqual({ channels: 2, frames: 1, sampleRate: 48_000 });

    for (const sampleRate of [0, Number.POSITIVE_INFINITY]) {
      expect(() =>
        validatePcmAudio({
          channelData: [new Float32Array([0])],
          sampleRate,
        }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }));
    }
    for (const channelData of [[], [new Float32Array()]]) {
      expect(() =>
        validatePcmAudio({ channelData, sampleRate: 48_000 }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }));
    }
    expect(() =>
      validatePcmAudio({
        channelData: [new Float32Array([0]), new Float32Array([0, 1])],
        sampleRate: 48_000,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }));
  });
});

function integer(littleEndian: boolean, signed: boolean) {
  return { float: false, littleEndian, signed };
}

function floating(littleEndian: boolean) {
  return { float: true, littleEndian, signed: true };
}
