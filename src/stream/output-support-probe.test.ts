import { describe, expect, it, vi } from 'vitest';
import { AudioTranscoderError } from '../errors.js';
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from './capabilities.js';
import type {
  AudioStreamOutputChunk,
  AudioStreamOutputProbeTarget,
  AudioStreamOutputSupportResult,
} from './contracts.js';
import type {
  AudioStreamEncoder,
  AudioStreamEncoderAdapter,
  AudioStreamEncoderConfiguration,
} from './runtime/contracts.js';
import {
  AUDIO_STREAM_OUTPUT_PROBE_MAX_CACHED_SUPPORTED,
  AUDIO_STREAM_OUTPUT_PROBE_MAX_QUEUED_UNIQUE,
  createAudioStreamOutputProbeCoordinator,
  exerciseAudioStreamOutputRuntime,
  probeAudioStreamOutputSupport,
} from './output-support-probe.js';

const WAV_TARGET = {
  channels: 2,
  presetId: 'wav-pcm16',
  sampleRate: 48_000,
} satisfies AudioStreamOutputProbeTarget;
const MP3_TARGET = {
  channels: 2,
  presetId: 'mp3-128kbps',
  sampleRate: 44_100,
} satisfies AudioStreamOutputProbeTarget;
const SUPPORTED = Object.freeze({
  code: 'SUPPORTED',
  message: 'The output runtime probe succeeded.',
  reason: 'runtime-verified',
  status: 'supported',
} satisfies AudioStreamOutputSupportResult);
const UNAVAILABLE = Object.freeze({
  code: 'OUTPUT_RUNTIME_UNAVAILABLE',
  message: 'The encoder runtime is unavailable.',
  reason: 'encoder-create',
  status: 'runtime-unavailable',
} satisfies AudioStreamOutputSupportResult);

describe('output support probe validation and coordinator', () => {
  it.each([
    [
      { ...WAV_TARGET, presetId: 'missing' },
      'preset',
      'Preset "missing" is not installed.',
    ],
    [
      { ...WAV_TARGET, channels: 0 },
      'channels',
      'Preset "wav-pcm16" does not support 0 channels.',
    ],
    [
      { ...MP3_TARGET, sampleRate: 8_000 },
      'sample-rate',
      'Preset "mp3-128kbps" does not support 8000 Hz.',
    ],
  ])('returns an immutable static mismatch without running the codec %#', async (
    target,
    reason,
    message,
  ) => {
    const operation = vi.fn(async () => SUPPORTED);

    const result = await probeAudioStreamOutputSupport(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      createAudioStreamOutputProbeCoordinator(),
      target as AudioStreamOutputProbeTarget,
      undefined,
      operation,
    );

    expect(result).toEqual({
      code: 'UNSUPPORTED_OUTPUT',
      message,
      reason,
      status: 'unsupported-configuration',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'An output support probe target is required.'],
    [{ ...WAV_TARGET, presetId: '' }, 'Output probe presetId must be a non-empty string.'],
    [{ ...WAV_TARGET, channels: 1.5 }, 'Output probe channels must be a safe integer.'],
    [{ ...WAV_TARGET, sampleRate: Number.NaN }, 'Output probe sampleRate must be a safe integer.'],
  ])('rejects malformed programmer input %#', async (target, message) => {
    expect(() =>
      probeAudioStreamOutputSupport(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES,
        createAudioStreamOutputProbeCoordinator(),
        target as AudioStreamOutputProbeTarget,
        undefined,
        async () => SUPPORTED,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION', message }));
  });

  it('rejects a pre-aborted caller even when the target is statically unsupported', async () => {
    const controller = new AbortController();
    controller.abort('stop');

    expect(() =>
      probeAudioStreamOutputSupport(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES,
        createAudioStreamOutputProbeCoordinator(),
        { ...WAV_TARGET, channels: 0 },
        controller.signal,
        async () => SUPPORTED,
      ),
    ).toThrow(expect.objectContaining({ code: 'OPERATION_ABORTED' }));
  });

  it('coalesces concurrent exact targets and caches successful results', async () => {
    let resolve!: (result: AudioStreamOutputSupportResult) => void;
    const operation = vi.fn(
      () =>
        new Promise<AudioStreamOutputSupportResult>((done) => {
          resolve = done;
        }),
    );
    const cache = createAudioStreamOutputProbeCoordinator();
    const first = probeAudioStreamOutputSupport(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      cache,
      WAV_TARGET,
      undefined,
      operation,
    );
    const second = probeAudioStreamOutputSupport(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      cache,
      WAV_TARGET,
      undefined,
      operation,
    );
    await Promise.resolve();
    resolve(SUPPORTED);

    await expect(Promise.all([first, second])).resolves.toEqual([
      SUPPORTED,
      SUPPORTED,
    ]);
    await expect(
      probeAudioStreamOutputSupport(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES,
        cache,
        WAV_TARGET,
        undefined,
        operation,
      ),
    ).resolves.toBe(SUPPORTED);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('uses preset, channels, and sample rate as the exact cache key', async () => {
    const operation = vi.fn(async () => SUPPORTED);
    const cache = createAudioStreamOutputProbeCoordinator();
    const targets = [
      WAV_TARGET,
      { ...WAV_TARGET, channels: 1 },
      { ...WAV_TARGET, sampleRate: 44_100 },
      { ...WAV_TARGET, presetId: 'wav-pcm24' as const },
    ];

    await Promise.all(
      targets.map((target) =>
        probeAudioStreamOutputSupport(
          AUDIO_TRANSCODER_STREAM_CAPABILITIES,
          cache,
          target,
          undefined,
          operation,
        ),
      ),
    );

    expect(operation).toHaveBeenCalledTimes(4);
  });

  it('removes rejected entries and retries them', async () => {
    const failure = new AudioTranscoderError('WORKER_TERMINATED', 'gone');
    const operation = vi
      .fn<() => Promise<AudioStreamOutputSupportResult>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(SUPPORTED);
    const cache = createAudioStreamOutputProbeCoordinator();

    await expect(
      probeAudioStreamOutputSupport(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES,
        cache,
        WAV_TARGET,
        undefined,
        operation,
      ),
    ).rejects.toBe(failure);
    await expect(
      probeAudioStreamOutputSupport(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES,
        cache,
        WAV_TARGET,
        undefined,
        operation,
      ),
    ).resolves.toEqual(SUPPORTED);
  });

  it('does not cache runtime-unavailable results', async () => {
    const operation = vi
      .fn<() => Promise<AudioStreamOutputSupportResult>>()
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValueOnce(SUPPORTED);
    const coordinator = createAudioStreamOutputProbeCoordinator();

    await expect(
      coordinator.run(WAV_TARGET, undefined, operation),
    ).resolves.toBe(UNAVAILABLE);
    await expect(
      coordinator.run(WAV_TARGET, undefined, operation),
    ).resolves.toBe(SUPPORTED);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('bounds successful results with exact-target LRU eviction', async () => {
    expect(AUDIO_STREAM_OUTPUT_PROBE_MAX_CACHED_SUPPORTED).toBe(32);
    const coordinator = createAudioStreamOutputProbeCoordinator();
    const operation = vi.fn(async () => SUPPORTED);
    const targets = Array.from(
      { length: AUDIO_STREAM_OUTPUT_PROBE_MAX_CACHED_SUPPORTED + 1 },
      (_, index) => ({
        ...WAV_TARGET,
        sampleRate: 10_000 + index,
      }),
    );

    for (const target of targets.slice(0, -1)) {
      await coordinator.run(target, undefined, operation);
    }
    await coordinator.run(targets[0]!, undefined, operation);
    await coordinator.run(targets.at(-1)!, undefined, operation);
    await coordinator.run(targets[0]!, undefined, operation);
    await coordinator.run(targets[1]!, undefined, operation);

    expect(operation).toHaveBeenCalledTimes(
      AUDIO_STREAM_OUTPUT_PROBE_MAX_CACHED_SUPPORTED + 2,
    );
  });

  it('serializes unique runtime probes to one active operation', async () => {
    const coordinator = createAudioStreamOutputProbeCoordinator();
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const operation = vi.fn(
      () =>
        new Promise<AudioStreamOutputSupportResult>((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          releases.push(() => {
            active -= 1;
            resolve(SUPPORTED);
          });
        }),
    );
    const pending = [0, 1, 2].map((index) =>
      coordinator.run(
        { ...WAV_TARGET, sampleRate: 20_000 + index },
        undefined,
        operation,
      ),
    );

    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    releases.shift()!();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
    releases.shift()!();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(3));
    releases.shift()!();

    await expect(Promise.all(pending)).resolves.toEqual([
      SUPPORTED,
      SUPPORTED,
      SUPPORTED,
    ]);
    expect(maximumActive).toBe(1);
  });

  it('bounds waiting unique probes while still coalescing an identical target', async () => {
    expect(AUDIO_STREAM_OUTPUT_PROBE_MAX_QUEUED_UNIQUE).toBe(8);
    const coordinator = createAudioStreamOutputProbeCoordinator();
    let releaseActive!: () => void;
    const operation = vi.fn(
      () =>
        new Promise<AudioStreamOutputSupportResult>((resolve) => {
          releaseActive = () => resolve(SUPPORTED);
        }),
    );
    const active = coordinator.run(WAV_TARGET, undefined, operation);
    const queuedTargets = Array.from(
      { length: AUDIO_STREAM_OUTPUT_PROBE_MAX_QUEUED_UNIQUE },
      (_, index) => ({ ...WAV_TARGET, sampleRate: 30_000 + index }),
    );
    const queued = queuedTargets.map((target) =>
      coordinator.run(target, undefined, operation),
    );
    const coalesced = coordinator.run(
      queuedTargets[0]!,
      undefined,
      operation,
    );

    await expect(
      coordinator.run(
        { ...WAV_TARGET, sampleRate: 31_000 },
        undefined,
        operation,
      ),
    ).rejects.toMatchObject({
      code: 'QUEUE_CAPACITY_EXCEEDED',
      message:
        'Audio output probe queue is full (maxQueued: 8; active probe excluded).',
    });

    const cleared = new AudioTranscoderError('WORKER_TERMINATED', 'cleared');
    const assertions = [active, ...queued, coalesced].map((promise) =>
      expect(promise).rejects.toBe(cleared),
    );
    coordinator.clear(cleared);
    releaseActive();
    await Promise.all(assertions);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('removes an aborted queued target and admits its replacement', async () => {
    const coordinator = createAudioStreamOutputProbeCoordinator();
    let releaseActive!: () => void;
    const operation = vi.fn(
      () =>
        new Promise<AudioStreamOutputSupportResult>((resolve) => {
          releaseActive = () => resolve(SUPPORTED);
        }),
    );
    const active = coordinator.run(WAV_TARGET, undefined, operation);
    const controller = new AbortController();
    const canceled = coordinator.run(
      { ...WAV_TARGET, sampleRate: 40_000 },
      controller.signal,
      operation,
    );
    const canceledAssertion = expect(canceled).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
    });
    controller.abort('queued caller stopped');
    await canceledAssertion;

    const replacementOperation = vi.fn(async () => SUPPORTED);
    const replacement = coordinator.run(
      { ...WAV_TARGET, sampleRate: 40_001 },
      undefined,
      replacementOperation,
    );
    releaseActive();

    await expect(active).resolves.toBe(SUPPORTED);
    await expect(replacement).resolves.toBe(SUPPORTED);
    expect(operation).toHaveBeenCalledOnce();
    expect(replacementOperation).toHaveBeenCalledOnce();
  });

  it('cancels one subscriber without interrupting another', async () => {
    let resolve!: (result: AudioStreamOutputSupportResult) => void;
    const operation = vi.fn(
      () =>
        new Promise<AudioStreamOutputSupportResult>((done) => {
          resolve = done;
        }),
    );
    const cache = createAudioStreamOutputProbeCoordinator();
    const controller = new AbortController();
    const canceled = probeAudioStreamOutputSupport(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      cache,
      WAV_TARGET,
      controller.signal,
      operation,
    );
    const retained = probeAudioStreamOutputSupport(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      cache,
      WAV_TARGET,
      undefined,
      operation,
    );
    const canceledAssertion = expect(canceled).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
    });
    await Promise.resolve();
    controller.abort('caller stopped');
    resolve(SUPPORTED);

    await canceledAssertion;
    await expect(retained).resolves.toBe(SUPPORTED);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('aborts and evicts an in-flight probe after all coalesced subscribers leave', async () => {
    const observedSignals: AbortSignal[] = [];
    const operation = vi
      .fn<(signal: AbortSignal) => Promise<AudioStreamOutputSupportResult>>()
      .mockImplementationOnce((signal) => {
        observedSignals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('shared aborted')), {
            once: true,
          });
        });
      })
      .mockImplementationOnce(async (signal) => {
        observedSignals.push(signal);
        return SUPPORTED;
      });
    const coordinator = createAudioStreamOutputProbeCoordinator();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = coordinator.run(WAV_TARGET, firstController.signal, operation);
    const second = coordinator.run(WAV_TARGET, secondController.signal, operation);
    const firstAssertion = expect(first).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
    });
    const secondAssertion = expect(second).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
    });

    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    firstController.abort('first subscriber left');
    await firstAssertion;
    expect(observedSignals[0]?.aborted).toBe(false);

    secondController.abort('last subscriber left');
    await secondAssertion;
    expect(observedSignals[0]?.aborted).toBe(true);

    await expect(coordinator.run(WAV_TARGET, undefined, operation)).resolves.toBe(
      SUPPORTED,
    );
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('clears pending and terminal entries', async () => {
    const cache = createAudioStreamOutputProbeCoordinator();
    let releasePending!: () => void;
    const pendingOperation = vi.fn(() =>
      new Promise<AudioStreamOutputSupportResult>((resolve) => {
        releasePending = () => resolve(SUPPORTED);
      }),
    );
    const pending = cache.run(WAV_TARGET, undefined, pendingOperation);
    await Promise.resolve();
    cache.clear();
    await expect(pending).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'The output probe coordinator was cleared.',
    });
    releasePending();
    await Promise.resolve();

    const terminalOperation = vi.fn(async () => SUPPORTED);
    await cache.run(WAV_TARGET, undefined, terminalOperation);
    cache.clear();
    await cache.run(WAV_TARGET, undefined, terminalOperation);
    expect(terminalOperation).toHaveBeenCalledTimes(2);
  });

  it('keeps the serial slot until a cleared active operation actually settles', async () => {
    let release!: (result: AudioStreamOutputSupportResult) => void;
    const coordinator = createAudioStreamOutputProbeCoordinator();
    const activeOperation = vi.fn(
      async () =>
        new Promise<AudioStreamOutputSupportResult>((resolve) => {
          release = resolve;
        }),
    );
    const pending = coordinator.run(WAV_TARGET, undefined, activeOperation);
    await Promise.resolve();
    coordinator.clear();
    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });

    const replacement = vi.fn(async () => SUPPORTED);
    const queued = coordinator.run(WAV_TARGET, undefined, replacement);
    await Promise.resolve();
    expect(replacement).not.toHaveBeenCalled();

    release(SUPPORTED);
    await expect(queued).resolves.toBe(SUPPORTED);
    await coordinator.run(WAV_TARGET, undefined, replacement);
    expect(replacement).toHaveBeenCalledOnce();
  });
});

describe('bounded output runtime exercise', () => {
  it.each([
    [WAV_TARGET, false],
    [MP3_TARGET, null],
  ])('runs a deterministic tiny encode without a source or artifact %#', async (
    target,
    rf64,
  ) => {
    const configurations: AudioStreamEncoderConfiguration[] = [];
    const written: Float32Array[] = [];
    const order: string[] = [];
    const adapter = createAdapter((configuration) => {
      configurations.push(configuration);
      let bytesWritten = 0;
      return createEncoder({
        cancel: async () => {
          order.push('cancel');
        },
        finalize: async () => {
          order.push('finalize');
          const writer = configuration.writable.getWriter();
          await writer.write({
            data: new Uint8Array([1, 2, 3, 4]),
            position: 0,
            type: 'write',
          });
          writer.releaseLock();
          bytesWritten = 4;
        },
        getBytesWritten: () => bytesWritten,
        start: async () => {
          order.push('start');
        },
        write: async (samples) => {
          order.push('write');
          written.push(samples);
        },
      });
    });

    const result = await exerciseAudioStreamOutputRuntime(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      adapter,
      target,
      new AbortController().signal,
    );

    expect(result).toEqual(SUPPORTED);
    expect(order).toEqual(['start', 'write', 'finalize']);
    expect(configurations[0]).toMatchObject({
      channels: target.channels,
      outputChunkBytes: 64 * 1024,
      rf64,
      sampleRate: target.sampleRate,
      signal: expect.any(AbortSignal),
      writable: expect.any(WritableStream),
    });
    expect(written[0]?.byteLength).toBeLessThanOrEqual(32 * 1024);
    expect([...written[0]!.slice(0, 4)]).toEqual([-0.125, -0.125, -0.109375, -0.109375]);
  });

  it.each([
    ['no-op encoder', [] as const, 0],
    [
      'sink-only encoder',
      [{ data: new Uint8Array([1]), position: 0, type: 'write' }] as const,
      0,
    ],
    ['metric-only encoder', [] as const, 1],
  ])('rejects false-positive output from a %s', async (_name, chunks, bytesWritten) => {
    const result = await exerciseAudioStreamOutputRuntime(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      createWritingAdapter(chunks, bytesWritten),
      WAV_TARGET,
      new AbortController().signal,
    );

    expect(result).toEqual({
      code: 'OUTPUT_RUNTIME_UNAVAILABLE',
      message: 'The encoder finalized without producing output bytes.',
      reason: 'encoder-no-output',
      status: 'runtime-unavailable',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('accepts matching nonzero sink and encoder byte evidence without requiring closure', async () => {
    await expect(
      exerciseAudioStreamOutputRuntime(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES,
        createWritingAdapter(
          [{ data: new Uint8Array([1, 2]), position: 0, type: 'write' }],
          2,
        ),
        WAV_TARGET,
        new AbortController().signal,
      ),
    ).resolves.toEqual(SUPPORTED);
  });

  it.each([
    ['encoder-create', 'create failed'],
    ['encoder-start', 'start failed'],
    ['encoder-write', 'write failed'],
    ['encoder-finalize', 'finalize failed'],
  ] as const)('classifies a %s failure and cancels initialized encoders', async (
    phase,
    message,
  ) => {
    const cancel = vi.fn(async () => undefined);
    const adapter = createAdapter(async () => {
      if (phase === 'encoder-create') {
        throw new Error(message);
      }
      return createEncoder({
        cancel,
        ...(phase === 'encoder-finalize'
          ? { finalize: async () => { throw new Error(message); } }
          : {}),
        ...(phase === 'encoder-start'
          ? { start: async () => { throw new Error(message); } }
          : {}),
        ...(phase === 'encoder-write'
          ? { write: async () => { throw new Error(message); } }
          : {}),
      });
    });

    const result = await exerciseAudioStreamOutputRuntime(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      adapter,
      WAV_TARGET,
      new AbortController().signal,
    );

    expect(result).toEqual({
      code: 'OUTPUT_RUNTIME_UNAVAILABLE',
      message,
      reason: phase,
      status: 'runtime-unavailable',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(phase === 'encoder-create' ? 0 : 1);
  });

  it.each([
    ['plain failure', 'plain failure'],
    [42, 'The encoder runtime failed.'],
  ])('normalizes non-Error runtime failures %#', async (failure, message) => {
    const result = await exerciseAudioStreamOutputRuntime(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      createAdapter(async () => Promise.reject(failure)),
      WAV_TARGET,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ message, status: 'runtime-unavailable' });
  });

  it.each([
    'INVALID_CONFIGURATION',
    'OPERATION_ABORTED',
    'QUEUE_CAPACITY_EXCEEDED',
    'RESOURCE_LIMIT_EXCEEDED',
    'WORKER_TERMINATED',
  ] as const)('does not swallow %s control-flow errors', async (code) => {
    const failure = new AudioTranscoderError(code, code);
    await expect(
      exerciseAudioStreamOutputRuntime(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES,
        createAdapter(async () => Promise.reject(failure)),
        WAV_TARGET,
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
  });

  it('turns codec WORKER_FAILURE into runtime unavailable', async () => {
    const result = await exerciseAudioStreamOutputRuntime(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      createAdapter(async () => {
        throw new AudioTranscoderError('WORKER_FAILURE', 'nested Worker blocked');
      }),
      WAV_TARGET,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      message: 'nested Worker blocked',
      reason: 'encoder-create',
      status: 'runtime-unavailable',
    });
  });

  it('rejects aborts during encoding and invokes cancel', async () => {
    const controller = new AbortController();
    const cancel = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    const adapter = createAdapter(async () =>
      createEncoder({
        cancel,
        start: async () => {
          controller.abort('stop');
        },
      }),
    );

    await expect(
      exerciseAudioStreamOutputRuntime(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES,
        adapter,
        WAV_TARGET,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    'encoder-start',
    'encoder-write',
    'encoder-finalize',
  ] as const)(
    'rejects promptly when abort interrupts a never-settling %s probe',
    async (phase) => {
      const operation = deferred<never>();
      const cancellation = deferred<void>();
      const reached = vi.fn(() => operation.promise);
      const cancel = vi.fn(() => cancellation.promise);
      const encoder = createEncoder({
        cancel,
        ...(phase === 'encoder-finalize' ? { finalize: reached } : {}),
        ...(phase === 'encoder-start' ? { start: reached } : {}),
        ...(phase === 'encoder-write' ? { write: reached } : {}),
      });
      const adapter = createAdapter(async () => encoder);
      const controller = new AbortController();

      const pending = exerciseAudioStreamOutputRuntime(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES,
        adapter,
        WAV_TARGET,
        controller.signal,
      );
      await vi.waitFor(() => expect(reached).toHaveBeenCalledOnce());
      controller.abort(`${phase} stopped`);

      await expect(pending).rejects.toMatchObject({
        code: 'OPERATION_ABORTED',
        message: `${phase} stopped`,
      });
      expect(cancel).toHaveBeenCalledOnce();

      operation.reject(new Error(`late ${phase} failure`));
      cancellation.reject(new Error(`late ${phase} cancel failure`));
    },
  );

  it('cancels an encoder that is created only after its probe aborts', async () => {
    const creation = deferred<AudioStreamEncoder>();
    const cancel = vi.fn<(reason?: unknown) => Promise<void>>(
      async () => undefined,
    );
    const create = vi.fn(() => creation.promise);
    const controller = new AbortController();

    const pending = exerciseAudioStreamOutputRuntime(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      createAdapter(create),
      WAV_TARGET,
      controller.signal,
    );
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    controller.abort('late probe encoder stopped');

    await expect(pending).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'late probe encoder stopped',
    });
    creation.resolve(createEncoder({ cancel }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(cancel.mock.calls[0]?.[0]).toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'late probe encoder stopped',
    });
  });

  it('handles an abort while encoder creation is still pending', async () => {
    const controller = new AbortController();
    const create = vi.fn(async () => {
      controller.abort('create stopped');
      throw new Error('create interrupted');
    });

    await expect(
      exerciseAudioStreamOutputRuntime(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES,
        { create, id: 'test' },
        WAV_TARGET,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  });

  it('keeps a create failure primary when a custom adapter retains the sink lock', async () => {
    let writer!: WritableStreamDefaultWriter<AudioStreamOutputChunk>;
    const result = await exerciseAudioStreamOutputRuntime(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      createAdapter(async (configuration) => {
        writer = configuration.writable.getWriter();
        throw new Error('create failed while locked');
      }),
      WAV_TARGET,
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      message: 'create failed while locked',
      status: 'runtime-unavailable',
    });
    writer.releaseLock();
  });

  it('rejects a pre-aborted runtime probe before creating an encoder', async () => {
    const controller = new AbortController();
    controller.abort();
    const create = vi.fn(async () => createEncoder());

    await expect(
      exerciseAudioStreamOutputRuntime(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES,
        { create, id: 'test' },
        WAV_TARGET,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(create).not.toHaveBeenCalled();
  });

  it('bounds seek positions and total discarded output bytes', async () => {
    const failures = [
      createWritingAdapter([
        { data: new Uint8Array(1), position: 512 * 1024, type: 'write' },
      ]),
      createWritingAdapter([
        { data: new Uint8Array(300 * 1024), position: 0, type: 'write' },
        { data: new Uint8Array(300 * 1024), position: 0, type: 'write' },
      ]),
    ];

    for (const adapter of failures) {
      await expect(
        exerciseAudioStreamOutputRuntime(
          AUDIO_TRANSCODER_STREAM_CAPABILITIES,
          adapter,
          WAV_TARGET,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: 'RESOURCE_LIMIT_EXCEEDED',
        message: 'The output encoder exceeded the runtime probe byte limit.',
      });
    }
  });

  it('reports a bounded-probe failure before allocating one oversized frame', async () => {
    const capabilities = withWavChannelMaximum(9_000);
    await expect(
      exerciseAudioStreamOutputRuntime(
        capabilities,
        createAdapter(async () => createEncoder()),
        { ...WAV_TARGET, channels: 9_000 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message: 'The output probe channel count exceeds its PCM safety bound.',
    });
  });

  it('rejects direct runtime execution for a statically unsupported target', async () => {
    await expect(
      exerciseAudioStreamOutputRuntime(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES,
        createAdapter(async () => createEncoder()),
        { ...WAV_TARGET, channels: 0 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
  });
});

function createAdapter(
  create: (
    configuration: AudioStreamEncoderConfiguration,
  ) => AudioStreamEncoder | Promise<AudioStreamEncoder>,
): AudioStreamEncoderAdapter {
  return { create: async (configuration) => create(configuration), id: 'test' };
}

function createEncoder(
  overrides: Partial<AudioStreamEncoder> = {},
): AudioStreamEncoder {
  return {
    cancel: async () => undefined,
    finalize: async () => undefined,
    getBytesWritten: () => 0,
    start: async () => undefined,
    write: async () => undefined,
    ...overrides,
  };
}

function createWritingAdapter(
  chunks: readonly AudioStreamOutputChunk[],
  bytesWritten = 0,
): AudioStreamEncoderAdapter {
  return createAdapter(async (configuration) => {
    let writer: WritableStreamDefaultWriter<AudioStreamOutputChunk> | undefined;
    return createEncoder({
      cancel: async (reason) => {
        if (writer !== undefined) {
          await writer.abort(reason).catch(() => undefined);
          writer.releaseLock();
        }
      },
      finalize: async () => {
        writer?.releaseLock();
      },
      getBytesWritten: () => bytesWritten,
      start: async () => {
        writer = configuration.writable.getWriter();
      },
      write: async () => {
        for (const chunk of chunks) {
          await writer!.write(chunk);
        }
      },
    });
  });
}

function withWavChannelMaximum(maximum: number) {
  return {
    ...AUDIO_TRANSCODER_STREAM_CAPABILITIES,
    outputFormats: AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputFormats.map(
      (format) =>
        format.id !== 'wav'
          ? format
          : {
              ...format,
              presets: format.presets.map((preset) => ({
                ...preset,
                target: {
                  ...preset.target,
                  channels: { ...preset.target.channels, maximum },
                },
              })),
            },
    ),
  } as unknown as typeof AUDIO_TRANSCODER_STREAM_CAPABILITIES;
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
