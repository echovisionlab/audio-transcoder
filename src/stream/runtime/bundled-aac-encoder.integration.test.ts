import {
  AdtsOutputFormat,
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  Output,
} from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { createBundledAacEncoderRegistration } from './bundled-aac-encoder.js';

const bundledAacEncoder = createBundledAacEncoderRegistration(
  async () => {
    // Node types are deliberately absent from the browser package's tsconfig.
    // @ts-expect-error Vitest runs this integration fixture in Node.
    const { readFile } = await import('node:fs/promises');
    return Uint8Array.from(
      await readFile(
        new URL('../../../codec-build/aac/aac.wasm', import.meta.url),
      ),
    );
  },
);

describe('bundled AAC encoder integration', () => {
  it('emits deterministic AAC-LC ADTS through MediaBunny', async () => {
    bundledAacEncoder.register();

    const first = await encodeAdts();
    const second = await encodeAdts();

    expect(second).toEqual(first);
    const frames = parseAdtsFrames(first);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(({ channelConfiguration }) => channelConfiguration === 2)).toBe(
      true,
    );
    expect(frames.every(({ objectType }) => objectType === 2)).toBe(true);
    expect(frames.every(({ sampleRateIndex }) => sampleRateIndex === 3)).toBe(
      true,
    );
  });
});

async function encodeAdts(): Promise<Uint8Array> {
  const target = new BufferTarget();
  const output = new Output({
    format: new AdtsOutputFormat(),
    target,
  });
  const source = new AudioSampleSource({
    bitrate: 128_000,
    bitrateMode: 'variable',
    codec: 'aac',
    onEncoderConfig: bundledAacEncoder.bind,
  });
  output.addAudioTrack(source);
  await output.start();

  const samples = Float32Array.from({ length: 2_048 * 2 }, (_value, index) =>
    Math.sin((index * Math.PI) / 32) * 0.25,
  );
  const sample = new AudioSample({
    data: samples,
    format: 'f32',
    numberOfChannels: 2,
    sampleRate: 48_000,
    timestamp: 0,
  });
  try {
    await source.add(sample);
  } finally {
    sample.close();
  }
  source.close();
  await output.finalize();

  if (target.buffer === null) {
    throw new Error('MediaBunny did not finalize the ADTS buffer.');
  }
  return new Uint8Array(target.buffer);
}

interface AdtsFrame {
  readonly channelConfiguration: number;
  readonly objectType: number;
  readonly sampleRateIndex: number;
}

function parseAdtsFrames(bytes: Uint8Array): AdtsFrame[] {
  const frames: AdtsFrame[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (
      bytes[offset] !== 0xff ||
      (bytes[offset + 1] ?? 0) >> 4 !== 0x0f
    ) {
      throw new Error(`Invalid ADTS sync word at byte ${offset}.`);
    }
    const third = bytes[offset + 2] ?? 0;
    const fourth = bytes[offset + 3] ?? 0;
    const fifth = bytes[offset + 4] ?? 0;
    const sixth = bytes[offset + 5] ?? 0;
    const frameLength =
      ((fourth & 0x03) << 11) | (fifth << 3) | ((sixth & 0xe0) >> 5);
    if (frameLength < 7 || offset + frameLength > bytes.byteLength) {
      throw new Error(`Invalid ADTS frame length at byte ${offset}.`);
    }
    frames.push({
      channelConfiguration: ((third & 0x01) << 2) | (fourth >> 6),
      objectType: (third >> 6) + 1,
      sampleRateIndex: (third >> 2) & 0x0f,
    });
    offset += frameLength;
  }
  return frames;
}
