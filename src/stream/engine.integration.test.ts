import { describe, expect, it, vi } from 'vitest';
import type {
  AudioStreamOutput,
  AudioStreamOutputChunk,
} from './contracts.js';
import { createAudioTranscoderStreamEngine } from './engine.js';
import { createAudioTranscoderEngine } from '../engine/factory.js';
import { createTestCodecAssetProvider } from './codec-assets.test-support.js';

const CODEC_ASSETS = createTestCodecAssetProvider();

describe('real streaming pipeline', () => {
  it('requires explicit codec assets before resampling', async () => {
    const input = createFloatCaf(192_000, 1_920, () => 0);

    await expect(
      createAudioTranscoderStreamEngine().transcode(
        { blob: input, name: 'tone.caf' },
        { presetId: 'wav-pcm16', sampleRate: 48_000 },
        new SeekableMemorySink().stream,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message:
        'Codec asset resampler-balanced requires an explicit codecAssets provider.',
    });
  });

  it('converts 192 kHz CAF to exact 48 kHz 24-bit WAV frames', async () => {
    const inputFrames = 19_200;
    const input = createFloatCaf(192_000, inputFrames, (frame) =>
      0.5 * Math.sin((2 * Math.PI * 1_000 * frame) / 192_000),
    );
    const sink = new SeekableMemorySink();
    const progress = vi.fn();

    const result = await createAudioTranscoderStreamEngine({
      codecAssets: CODEC_ASSETS,
    }).transcode(
      { blob: input, name: 'tone.caf' },
      { presetId: 'wav-pcm24', sampleRate: 48_000 },
      sink.stream,
      { onProgress: progress },
    );
    const output = sink.bytes();
    const inspection = createAudioTranscoderEngine().inspect({ data: output.buffer });
    const decoded = await createAudioTranscoderEngine().decode({ data: output.buffer });

    expect(result).toMatchObject({
      bytesWritten: output.byteLength,
      channels: 1,
      durationSeconds: 0.1,
      rf64: false,
      sampleRate: 48_000,
    });
    expect(inspection).toMatchObject({
      bitDepth: 24,
      channels: 1,
      container: 'WAV',
      sampleRate: 48_000,
    });
    expect(decoded.channelData[0]).toHaveLength(4_800);
    expect(sink.closed).toBe(true);
    expect(sink.aborted).toBe(false);
    expect(progress.mock.calls[0]?.[0]).toMatchObject({ progress: 0 });
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ progress: 1 });
  });

  it('attenuates out-of-band audio instead of aliasing it into the output', async () => {
    const input = createFloatCaf(192_000, 19_200, (frame) =>
      0.8 * Math.sin((2 * Math.PI * 60_000 * frame) / 192_000),
    );
    const sink = new SeekableMemorySink();

    await createAudioTranscoderStreamEngine({
      codecAssets: CODEC_ASSETS,
    }).transcode(
      { blob: input, name: 'ultrasonic.caf' },
      {
        dither: 'none',
        presetId: 'wav-float32',
        resampleQuality: 'balanced',
        sampleRate: 48_000,
      },
      sink.stream,
    );
    const output = sink.bytes();
    const decoded = await createAudioTranscoderEngine().decode({ data: output.buffer });
    const channel = decoded.channelData[0]!;
    const settled = channel.subarray(256, channel.length - 256);
    const rms = Math.sqrt(
      settled.reduce((sum, sample) => sum + sample * sample, 0) /
        settled.length,
    );

    expect(rms).toBeLessThan(0.01);
  });
});

function createFloatCaf(
  sampleRate: number,
  frames: number,
  sampleAt: (frame: number) => number,
): Blob {
  const payloadBytes = frames * Float32Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(8 + 44 + 16 + payloadBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'caff');
  view.setUint16(4, 1, false);
  writeAscii(view, 8, 'desc');
  view.setBigInt64(12, 32n, false);
  view.setFloat64(20, sampleRate, false);
  writeAscii(view, 28, 'lpcm');
  // CAF LPCM flags: float (1) plus little-endian (2).
  view.setUint32(32, 1 | 2, false);
  view.setUint32(36, 4, false);
  view.setUint32(40, 1, false);
  view.setUint32(44, 1, false);
  view.setUint32(48, 32, false);
  writeAscii(view, 52, 'data');
  view.setBigInt64(56, BigInt(payloadBytes + 4), false);
  for (let frame = 0; frame < frames; frame += 1) {
    view.setFloat32(68 + frame * 4, sampleAt(frame), true);
  }
  return new Blob([buffer], { type: 'audio/x-caf' });
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

class SeekableMemorySink {
  aborted = false;
  closed = false;
  private data = new Uint8Array();
  readonly stream: AudioStreamOutput;

  constructor() {
    this.stream = new WritableStream<AudioStreamOutputChunk>({
      abort: () => {
        this.aborted = true;
      },
      close: () => {
        this.closed = true;
      },
      write: ({ data, position }) => {
        const end = position + data.byteLength;
        if (end > this.data.byteLength) {
          const expanded = new Uint8Array(end);
          expanded.set(this.data);
          this.data = expanded;
        }
        this.data.set(data, position);
      },
    });
  }

  bytes(): Uint8Array<ArrayBuffer> {
    return this.data;
  }
}
