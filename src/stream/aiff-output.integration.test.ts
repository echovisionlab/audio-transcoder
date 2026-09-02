import { describe, expect, it } from 'vitest';
import { aiffEncoder, AIFF_OUTPUT_PRESETS } from '../codecs/aiff.js';
import { readAscii, readInt24BE } from '../codecs/binary.js';
import { createAudioTranscoderStreamEngine } from './engine.js';
import type { AudioStreamOutputChunk } from './contracts.js';

describe('stream engine AIFF output', () => {
  it('probes and transcodes a source-preserving 24-bit AIFF target', async () => {
    const encodedInput = await aiffEncoder.encode(
      {
        channelData: [new Float32Array([-1, -0.5, 0, 0.5, 1])],
        sampleRate: 96_000,
      },
      AIFF_OUTPUT_PRESETS[0]!,
    );
    const engine = createAudioTranscoderStreamEngine();

    await expect(
      engine.probeOutputSupport({
        channels: 1,
        presetId: 'aiff-pcm24',
        sampleRate: 96_000,
      }),
    ).resolves.toEqual({
      code: 'SUPPORTED',
      message: 'The output runtime probe succeeded.',
      reason: 'runtime-verified',
      status: 'supported',
    });

    const destination = createDestination();
    const result = await engine.transcode(
      {
        blob: new Blob([encodedInput.data]),
        name: 'mono-source.aiff',
      },
      { presetId: 'aiff-pcm24' },
      destination.stream,
      { outputChunkBytes: 64 * 1024 },
    );

    expect(result).toMatchObject({
      bytesWritten: 70,
      channels: 1,
      details: { format: 'aiff' },
      durationSeconds: 5 / 96_000,
      format: 'aiff',
      preset: { bitDepth: 24, id: 'aiff-pcm24' },
      sampleRate: 96_000,
    });
    expect('rf64' in result).toBe(false);
    expect(destination.closed).toBe(true);

    const bytes = destination.bytes();
    const view = new DataView(bytes.buffer);
    expect(readAscii(view, 0, 4)).toBe('FORM');
    expect(readAscii(view, 8, 4)).toBe('AIFF');
    expect(view.getUint16(20, false)).toBe(1);
    expect(view.getUint32(22, false)).toBe(5);
    expect(view.getUint16(26, false)).toBe(24);
    expect(view.getUint32(42, false)).toBe(23);
    expect(readInt24BE(view, 54)).toBe(-8_388_608);
    // The 16-bit source's positive full-scale value is 32767/32768.
    expect(readInt24BE(view, 66)).toBe(8_388_351);
    expect(view.getUint8(69)).toBe(0);
  });

  it('returns static probe failures for unsupported AIFF boundaries', async () => {
    const engine = createAudioTranscoderStreamEngine();

    await expect(
      engine.probeOutputSupport({
        channels: 33,
        presetId: 'aiff-pcm16',
        sampleRate: 48_000,
      }),
    ).resolves.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      reason: 'channels',
      status: 'unsupported-configuration',
    });
    await expect(
      engine.probeOutputSupport({
        channels: 1,
        presetId: 'aiff-pcm16',
        sampleRate: 384_001,
      }),
    ).resolves.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      reason: 'sample-rate',
      status: 'unsupported-configuration',
    });
  });
});

function createDestination(): {
  bytes(): Uint8Array<ArrayBuffer>;
  readonly closed: boolean;
  readonly stream: WritableStream<AudioStreamOutputChunk>;
} {
  let bytes = new Uint8Array(0);
  let closed = false;
  const stream = new WritableStream<AudioStreamOutputChunk>({
    close() {
      closed = true;
    },
    write({ data, position }) {
      const end = position + data.byteLength;
      if (end > bytes.byteLength) {
        const grown = new Uint8Array(end);
        grown.set(bytes);
        bytes = grown;
      }
      bytes.set(data, position);
    },
  });
  return {
    bytes: () => bytes,
    get closed() {
      return closed;
    },
    stream,
  };
}
