import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioResampleQuality } from './contracts.js';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  createFactory: vi.fn(),
  moduleLoads: 0,
}));

vi.mock('./resampler-wasm-runtime.js', () => {
  mocks.moduleLoads += 1;
  return {
    createResamplerWasmSessionFactory: mocks.createFactory,
  };
});

import { createStreamingResamplerFactory } from './resampler.js';

const qualityLoaders = {
  balanced: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
  best: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
  fast: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
};

interface ConverterStub {
  readonly close: ReturnType<typeof vi.fn>;
  readonly process: ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  mocks.create.mockReset();
  mocks.createFactory.mockReset();
  mocks.createFactory.mockReturnValue(mocks.create);
});

function createStreamingResampler(
  channels: number,
  inputSampleRate: number,
  outputSampleRate: number,
  quality: AudioResampleQuality,
) {
  return createStreamingResamplerFactory(qualityLoaders[quality])(
    channels,
    inputSampleRate,
    outputSampleRate,
  );
}

describe('streaming resampler', () => {
  it('bypasses equal sample rates without allocating WASM state', async () => {
    await expect(
      createStreamingResampler(2, 384_000, 384_000, 'balanced'),
    ).resolves.toBeNull();
    expect(mocks.moduleLoads).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('uses an injected quality-specific WASM loader and lazy session factory', async () => {
    const converter = createConverter({ channels: 1 });
    const createSession = vi.fn().mockResolvedValue(converter);
    mocks.createFactory.mockReturnValue(createSession);
    const loadWasm = vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>();
    const createResampler = createStreamingResamplerFactory(loadWasm);

    await expect(createResampler(1, 48_000, 48_000)).resolves.toBeNull();
    expect(mocks.createFactory).not.toHaveBeenCalled();
    const resampler = await createResampler(1, 48_000, 24_000);
    const second = await createResampler(1, 48_000, 24_000);

    expect(mocks.createFactory).toHaveBeenCalledOnce();
    expect(mocks.createFactory).toHaveBeenCalledWith(loadWasm);
    expect(createSession).toHaveBeenCalledTimes(2);
    resampler?.close();
    second?.close();
  });

  it('rejects promptly when converter initialization ignores cancellation', async () => {
    const initialization = deferred<ConverterStub>();
    mocks.create.mockImplementation(() => initialization.promise);
    const createResampler = createStreamingResamplerFactory(
      qualityLoaders.balanced,
    );
    const controller = new AbortController();

    const pending = createResampler(
      2,
      48_000,
      44_100,
      controller.signal,
    );
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    expect(mocks.create).toHaveBeenCalledWith(
      2,
      44_100 / 48_000,
      controller.signal,
    );
    controller.abort('resampler setup stopped');

    await expect(pending).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'resampler setup stopped',
    });
    const lateConverter = createConverter({ channels: 2 });
    initialization.resolve(lateConverter);
    await vi.waitFor(() => expect(lateConverter.close).toHaveBeenCalledOnce());
  });

  it.each([
    [7_999, 7_999],
    [384_001, 384_001],
    [8_000, 384_000],
    [384_000, 8_000],
    [48_000.5, 96_000],
    [48_000, 192_001],
  ])(
    'rejects unsupported direct sample-rate pair %s -> %s',
    async (input, output) => {
      await expect(
        createStreamingResampler(2, input, output, 'balanced'),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it.each([0, 33, 1.5])(
    'rejects unsupported channel count %s',
    async (channels) => {
      await expect(
        createStreamingResampler(channels, 48_000, 24_000, 'balanced'),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it.each(['best', 'balanced', 'fast'] as const)(
    'loads the unchanged %s sinc converter and streams aligned frames',
    async (quality) => {
      const converter = createConverter({ channels: 2 });
      mocks.create.mockResolvedValue(converter);
      const resampler = await createStreamingResampler(
        2,
        48_000,
        24_000,
        quality,
      );

      expect(mocks.moduleLoads).toBe(1);
      expect(mocks.createFactory).toHaveBeenCalledWith(
        qualityLoaders[quality],
      );
      expect(mocks.create).toHaveBeenCalledWith(2, 0.5, undefined);
      const [first] = resampler!.process(new Float32Array([1, -1, 0.5, -0.5]));
      expect([...first!]).toEqual([1, -1]);
      const [second] = resampler!.process(
        new Float32Array([0.25, -0.25, 0.125, -0.125]),
      );
      expect([...second!]).toEqual([0.25, -0.25]);

      resampler!.close();
      resampler!.close();
      expect(converter.close).toHaveBeenCalledOnce();
      expect(() => [...resampler!.process(new Float32Array(2))]).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
      expect(() => [...resampler!.flush(2)]).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    },
  );

  it.each([new Error('WASM startup failed'), 'unknown startup failure'])(
    'normalizes converter initialization failure %s',
    async (failure) => {
      mocks.create.mockRejectedValue(failure);

      await expect(
        createStreamingResampler(2, 48_000, 44_100, 'balanced'),
      ).rejects.toMatchObject({
        code: 'WORKER_FAILURE',
        message: `Failed to initialize the runtime-asset sample-rate converter: ${
          failure instanceof Error ? failure.message : failure
        }`,
      });
    },
  );

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid flush frame count %s',
    async (totalInputFrames) => {
      const converter = createConverter({ channels: 1 });
      mocks.create.mockResolvedValue(converter);
      const resampler = await createStreamingResampler(
        1,
        48_000,
        24_000,
        'balanced',
      );

      expect(() => [...resampler!.flush(totalInputFrames)]).toThrow(
        expect.objectContaining({
          code: 'INVALID_AUDIO_DATA',
          message: 'totalInputFrames must be a non-negative safe integer.',
        }),
      );
      resampler!.close();
    },
  );

  it('rejects partial frames and flushes exactly the missing tail', async () => {
    const converter = createConverter({ channels: 2, delayedFrames: 2 });
    mocks.create.mockResolvedValue(converter);
    const resampler = await createStreamingResampler(
      2,
      48_000,
      24_000,
      'balanced',
    );

    expect(() => [...resampler!.process(new Float32Array(3))]).toThrow(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
    const [first] = resampler!.process(new Float32Array(16));
    expect(first).toHaveLength(4);
    const tail = [...resampler!.flush(8)];
    expect(tail).toHaveLength(1);
    expect(tail[0]).toHaveLength(4);
    expect([...resampler!.flush(8)]).toHaveLength(0);
    expect(() => [...resampler!.process(new Float32Array(2))]).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
    resampler!.close();
  });

  it('fails if the converter cannot flush the expected tail', async () => {
    const converter = createConverter({ channels: 1, neverFlush: true });
    mocks.create.mockResolvedValue(converter);
    const resampler = await createStreamingResampler(
      1,
      48_000,
      96_000,
      'balanced',
    );

    expect([...resampler!.process(new Float32Array(4))]).toHaveLength(0);
    expect(() => [...resampler!.flush(4)]).toThrow(
      expect.objectContaining({
        code: 'INVALID_AUDIO_DATA',
        message: expect.stringContaining('flush'),
      }),
    );
    resampler!.close();
  });

  it('returns immediately when processing already produced the exact expected frame count', async () => {
    const converter = createConverter({ channels: 1 });
    mocks.create.mockResolvedValue(converter);
    const resampler = await createStreamingResampler(
      1,
      48_000,
      24_000,
      'balanced',
    );

    expect([...resampler!.process(new Float32Array(4))]).toHaveLength(1);
    expect([...resampler!.flush(4)]).toHaveLength(0);
    resampler!.close();
  });

  it('rejects a converter that does not consume the complete input chunk', async () => {
    const converter: ConverterStub = {
      close: vi.fn(),
      process: vi.fn(() => ({
        inputFramesUsed: 0,
        outputFramesGenerated: 0,
      })),
    };
    mocks.create.mockResolvedValue(converter);
    const resampler = await createStreamingResampler(
      1,
      48_000,
      24_000,
      'balanced',
    );

    expect(() => [...resampler!.process(new Float32Array(4))]).toThrow(
      expect.objectContaining({
        code: 'INVALID_AUDIO_DATA',
        message: expect.stringContaining('consumed 0 of 4'),
      }),
    );
    resampler!.close();
  });

  it('rejects a paused multi-chunk iterator after its resampler is closed', async () => {
    const channels = 32;
    const ratio = 24;
    const converter: ConverterStub = {
      close: vi.fn(),
      process: vi.fn((input: Float32Array) => ({
        inputFramesUsed: input.length / channels,
        outputFramesGenerated: (input.length / channels) * ratio,
      })),
    };
    mocks.create.mockResolvedValue(converter);
    const resampler = await createStreamingResampler(
      channels,
      8_000,
      192_000,
      'balanced',
    );
    const chunks = resampler!
      .process(new Float32Array(3_000 * channels))
      [Symbol.iterator]();

    expect(chunks.next().done).toBe(false);
    resampler!.close();
    expect(() => chunks.next()).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
  });

  it('splits extreme upsampling so each reusable output buffer stays bounded', async () => {
    const channels = 32;
    const ratio = 24;
    const converter: ConverterStub = {
      close: vi.fn(),
      process: vi.fn((input: Float32Array) => {
        return {
          inputFramesUsed: input.length / channels,
          outputFramesGenerated: (input.length / channels) * ratio,
        };
      }),
    };
    mocks.create.mockResolvedValue(converter);
    const resampler = await createStreamingResampler(
      channels,
      8_000,
      192_000,
      'balanced',
    );

    const chunks = [...resampler!.process(new Float32Array(16_384 * channels))];

    expect(chunks.length).toBeGreaterThan(1);
    expect(converter.process).toHaveBeenCalledTimes(chunks.length);
    for (const [, output] of converter.process.mock.calls) {
      expect((output as Float32Array).byteLength).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
    }
    resampler!.close();
  });

  it('bounds input and output allocations during extreme downsampling', async () => {
    const channels = 1;
    const ratio = 8_000 / 192_000;
    const converter: ConverterStub = {
      close: vi.fn(),
      process: vi.fn((input: Float32Array) => {
        return {
          inputFramesUsed: input.length / channels,
          outputFramesGenerated: Math.floor((input.length / channels) * ratio),
        };
      }),
    };
    mocks.create.mockResolvedValue(converter);
    const resampler = await createStreamingResampler(
      channels,
      192_000,
      8_000,
      'balanced',
    );

    const chunks = [...resampler!.process(new Float32Array(2_000_000))];

    expect(chunks.length).toBeGreaterThan(1);
    expect(converter.process).toHaveBeenCalledTimes(chunks.length);
    for (const [input, output] of converter.process.mock.calls) {
      expect((input as Float32Array).byteLength).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
      expect((output as Float32Array).byteLength).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
    }
    resampler!.close();
  });
});

function createConverter(options: {
  readonly channels: number;
  readonly delayedFrames?: number;
  readonly neverFlush?: boolean;
}): ConverterStub {
  let call = 0;
  let pendingFrames = 0;
  return {
    close: vi.fn(),
    process: vi.fn(
      (input: Float32Array, output: Float32Array, endOfInput: boolean) => {
        call += 1;
        const channels = options.channels;
        const projected = Math.floor(input.length / channels / 2);
        const delayed =
          input.length > 0 && call === 1 ? (options.delayedFrames ?? 0) : 0;
        pendingFrames += delayed;
        const frames = options.neverFlush
          ? 0
          : endOfInput
            ? pendingFrames
            : Math.max(0, projected - delayed);
        if (endOfInput) pendingFrames = 0;
        for (let index = 0; index < frames * channels; index += 1) {
          output[index] = input[index] ?? 0;
        }
        return {
          inputFramesUsed: input.length / channels,
          outputFramesGenerated: frames,
        };
      },
    ),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
