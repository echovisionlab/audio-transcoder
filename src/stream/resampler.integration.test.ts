import { describe, expect, it } from 'vitest';
import type { AudioResampleQuality } from './contracts.js';
import { createStreamingResamplerFactory } from './resampler.js';
import { createTestCodecAssetProvider } from './codec-assets.test-support.js';

const QUALITIES = ['best', 'balanced', 'fast'] as const;
const CODEC_ASSETS = createTestCodecAssetProvider();
const RESAMPLER_FACTORIES = {
  balanced: createStreamingResamplerFactory(() =>
    CODEC_ASSETS.load('resampler-balanced'),
  ),
  best: createStreamingResamplerFactory(() =>
    CODEC_ASSETS.load('resampler-best'),
  ),
  fast: createStreamingResamplerFactory(() =>
    CODEC_ASSETS.load('resampler-fast'),
  ),
} as const;

describe('real libsamplerate WASM sessions', () => {
  it.each(QUALITIES)(
    'keeps %s output deterministic and continuous across arbitrary chunk boundaries',
    async (quality) => {
      const channels = 2;
      const inputSampleRate = 44_100;
      const outputSampleRate = 48_000;
      const inputFrames = 4_097;
      const input = createSignal(inputFrames, channels, inputSampleRate);

      const contiguous = await resample(
        input,
        channels,
        inputSampleRate,
        outputSampleRate,
        quality,
        [inputFrames],
      );
      const chunked = await resample(
        input,
        channels,
        inputSampleRate,
        outputSampleRate,
        quality,
        [1, 7, 113, 2, 509, 31],
      );
      const repeated = await resample(
        input,
        channels,
        inputSampleRate,
        outputSampleRate,
        quality,
        [1, 7, 113, 2, 509, 31],
      );
      const expectedSamples =
        Math.floor((inputFrames * outputSampleRate) / inputSampleRate) *
        channels;

      expect(contiguous).toHaveLength(expectedSamples);
      expect(chunked).toHaveLength(expectedSamples);
      expect(repeated).toEqual(chunked);
      expect(maximumDifference(contiguous, chunked)).toBeLessThan(1e-6);
    },
  );

  it.each(QUALITIES)(
    'keeps the unchanged %s sinc filter from aliasing 60 kHz into 48 kHz output',
    async (quality) => {
      const inputSampleRate = 192_000;
      const inputFrames = 8_192;
      const input = new Float32Array(inputFrames);
      for (let frame = 0; frame < inputFrames; frame += 1) {
        input[frame] =
          0.8 * Math.sin((2 * Math.PI * 60_000 * frame) / inputSampleRate);
      }
      const output = await resample(
        input,
        1,
        inputSampleRate,
        48_000,
        quality,
        [127, 509, 17],
      );
      const settled = output.subarray(256, output.length - 256);
      const rms = Math.sqrt(
        settled.reduce((sum, sample) => sum + sample * sample, 0) /
          settled.length,
      );

      expect(output).toHaveLength(inputFrames / 4);
      expect(rms).toBeLessThan(0.01);
    },
  );

  it('supports the 32-channel and 8-192 kHz contract endpoints with bounded chunks', async () => {
    const channels = 32;
    const inputFrames = 65;
    const input = createSignal(inputFrames, channels, 8_000);
    const output = await resample(
      input,
      channels,
      8_000,
      192_000,
      'fast',
      [3, 11, 1],
    );

    expect(output).toHaveLength(inputFrames * 24 * channels);
    expect(output.every(Number.isFinite)).toBe(true);
  });
});

async function resample(
  input: Float32Array,
  channels: number,
  inputSampleRate: number,
  outputSampleRate: number,
  quality: AudioResampleQuality,
  chunkPattern: readonly number[],
): Promise<Float32Array> {
  const resampler = await RESAMPLER_FACTORIES[quality](
    channels,
    inputSampleRate,
    outputSampleRate,
  );
  if (resampler === null) throw new Error('Expected an active resampler.');

  const chunks: Float32Array[] = [];
  const totalInputFrames = input.length / channels;
  let startFrame = 0;
  let patternIndex = 0;
  try {
    while (startFrame < totalInputFrames) {
      const frames = Math.min(
        chunkPattern[patternIndex % chunkPattern.length]!,
        totalInputFrames - startFrame,
      );
      const endFrame = startFrame + frames;
      for (const converted of resampler.process(
        input.subarray(startFrame * channels, endFrame * channels),
      )) {
        chunks.push(converted.slice());
      }
      startFrame = endFrame;
      patternIndex += 1;
    }
    for (const tail of resampler.flush(totalInputFrames)) {
      chunks.push(tail.slice());
    }
  } finally {
    resampler.close();
  }
  return concatenate(chunks);
}

function createSignal(
  frames: number,
  channels: number,
  sampleRate: number,
): Float32Array {
  const signal = new Float32Array(frames * channels);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      signal[frame * channels + channel] =
        0.45 *
          Math.sin(
            (2 * Math.PI * (440 + channel * 13) * frame) / sampleRate,
          ) +
        0.1 * Math.sin((2 * Math.PI * 1_731 * frame) / sampleRate);
    }
  }
  return signal;
}

function concatenate(chunks: readonly Float32Array[]): Float32Array {
  const output = new Float32Array(
    chunks.reduce((samples, chunk) => samples + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function maximumDifference(left: Float32Array, right: Float32Array): number {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference = Math.max(
      difference,
      Math.abs(left[index]! - right[index]!),
    );
  }
  return difference;
}
