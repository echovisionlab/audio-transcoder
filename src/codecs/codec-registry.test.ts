import { describe, expect, it, vi } from 'vitest';
import { AudioTranscoderError } from '../errors.js';
import type { DecodedAudio } from '../engine/contracts.js';
import { CodecRegistry } from './codec-registry.js';
import type {
  AudioCodecOperationContext,
  AudioDecoderAdapter,
} from './contracts.js';

const DECODED: DecodedAudio = {
  channelData: [new Float32Array([0])],
  durationSeconds: 1,
  sampleRate: 1,
  source: 'test',
};

describe('CodecRegistry decode preflight', () => {
  it('skips adapters whose estimator does not recognize the input', async () => {
    const skippedDecode = vi.fn(async () => DECODED);
    const selectedDecode = vi.fn(async () => DECODED);
    const preflight = vi.fn();
    const registry = createRegistry([
      {
        decode: skippedDecode,
        estimateDecodedPcm: () => null,
        formats: ['first'],
        id: 'first',
      },
      {
        decode: selectedDecode,
        estimateDecodedPcm: () => ({ channels: 1, frames: 1 }),
        formats: ['second'],
        id: 'second',
      },
    ]);

    await expect(
      registry.decode(input(), context(), preflight),
    ).resolves.toEqual(DECODED);
    expect(skippedDecode).not.toHaveBeenCalled();
    expect(selectedDecode).toHaveBeenCalledOnce();
    expect(preflight).toHaveBeenCalledWith({ channels: 1, frames: 1 });
  });

  it('keeps estimators optional', async () => {
    const skippedDecode = vi.fn(async () => null);
    const selectedDecode = vi.fn(async () => DECODED);
    const preflight = vi.fn();
    const registry = createRegistry([
      { decode: skippedDecode, formats: ['first'], id: 'first' },
      { decode: selectedDecode, formats: ['second'], id: 'second' },
    ]);

    await expect(
      registry.decode(input(), context(), preflight),
    ).resolves.toEqual(DECODED);
    expect(skippedDecode).toHaveBeenCalledOnce();
    expect(selectedDecode).toHaveBeenCalledOnce();
    expect(preflight).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    'invalid',
    {},
    { channels: 0, frames: 1 },
    { channels: 1, frames: 1.5 },
    { channels: 1, frames: -1 },
  ])('rejects an invalid plugin estimate %#', async (estimate) => {
    const decode = vi.fn(async () => DECODED);
    const estimateDecodedPcm = (() => estimate) as NonNullable<
      AudioDecoderAdapter['estimateDecodedPcm']
    >;
    const registry = createRegistry([
      {
        decode,
        estimateDecodedPcm,
        formats: ['invalid'],
        id: 'invalid',
      },
    ]);

    await expect(registry.decode(input(), context())).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it('checks cancellation after an asynchronous estimator', async () => {
    const controller = new AbortController();
    const decode = vi.fn(async () => DECODED);
    const preflight = vi.fn();
    const registry = createRegistry([
      {
        decode,
        estimateDecodedPcm: async () => {
          controller.abort('cancel estimate');
          return { channels: 1, frames: 1 };
        },
        formats: ['test'],
        id: 'test',
      },
    ]);

    await expect(
      registry.decode(input(), context(controller.signal), preflight),
    ).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(preflight).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });
});

describe('CodecRegistry inspection normalization', () => {
  it('keeps legacy inspector plugins compatible and supplies unknown encoding', () => {
    const registry = new CodecRegistry({
      decoders: [],
      encoders: [],
      inspectors: [
        {
          formats: ['legacy'],
          id: 'legacy',
          inspect: () => ({
            bitDepth: 32,
            channels: 1,
            codec: 'Legacy codec label',
            container: 'LEGACY',
            decodeSupport: 'browser-dependent',
            durationSeconds: null,
            notes: [],
            sampleRate: 192_000,
          }),
        },
      ],
    });

    const inspection = registry.inspect(input());

    expect(inspection.sourceEncoding).toEqual({ kind: 'unknown' });
    expect(Object.isFrozen(inspection.sourceEncoding)).toBe(true);
  });
});

function createRegistry(
  decoders: ConstructorParameters<typeof CodecRegistry>[0]['decoders'],
): CodecRegistry {
  return new CodecRegistry({ decoders, encoders: [], inspectors: [] });
}

function context(signal?: AbortSignal): AudioCodecOperationContext {
  return {
    async checkpoint(): Promise<void> {},
    reportProgress(): void {},
    signal,
    throwIfAborted(): void {
      if (signal?.aborted) {
        throw new AudioTranscoderError(
          'OPERATION_ABORTED',
          String(signal.reason),
        );
      }
    },
  };
}

function input() {
  return { data: new ArrayBuffer(1) };
}
