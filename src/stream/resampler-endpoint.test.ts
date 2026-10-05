import { describe, expect, it } from "vitest";
import { createStreamingResamplerFactory } from "./resampler.js";
import { getResamplerWasmBytes } from "./resampler-wasm-balanced-binary.js";

const createResampler = createStreamingResamplerFactory(async () =>
  getResamplerWasmBytes(),
);

describe("balanced resampler finite-signal endpoint", () => {
  it.each([
    [1, 44_100],
    [1, 48_000],
    [1, 192_000],
    [2, 44_100],
    [2, 48_000],
  ])(
    "preserves the original 18 second output quota at %i channels/%i Hz",
    async (channels, sampleRate) => {
      const resampler = await createResampler(channels, sampleRate, 8_000);
      const totalInputFrames = sampleRate * 18;
      let outputFrames = 0;
      let tailEnergy = 0;
      try {
        for (let start = 0; start < totalInputFrames; start += 16_384) {
          const frames = Math.min(16_384, totalInputFrames - start);
          const pcm = new Float32Array(frames * channels);
          for (let frame = 0; frame < frames; frame++) {
            const sample =
              Math.sin((2 * Math.PI * 997 * (start + frame)) / sampleRate) *
              0.5;
            for (let channel = 0; channel < channels; channel++) {
              pcm[frame * channels + channel] = sample;
            }
          }
          for (const chunk of resampler!.process(pcm)) {
            outputFrames += chunk.length / channels;
          }
        }
        for (const tail of resampler!.flush(totalInputFrames)) {
          outputFrames += tail.length / channels;
          expect(tail.every(Number.isFinite)).toBe(true);
          for (const sample of tail) {
            tailEnergy += sample * sample;
          }
        }
        expect(outputFrames).toBe(144_000);
        expect(tailEnergy).toBeGreaterThan(0.1);
        expect([...resampler!.flush(totalInputFrames)]).toHaveLength(0);
      } finally {
        resampler!.close();
      }
    },
  );
});
