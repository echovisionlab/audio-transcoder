import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  AudioStreamInspection,
  AudioStreamOutputSupportResult,
  AudioStreamTranscodeResult,
} from './contracts.js';
import type {
  AudioStreamWorkerRequest,
  AudioStreamWorkerResponse,
} from './protocol.js';
import {
  createAudioTranscoderStreamWorkerPool,
  type CreateAudioTranscoderStreamWorkerPoolOptions,
} from './pool.js';
import { AudioTranscoderError } from '../errors.js';
import { AUDIO_TRANSCODER_VERSION } from '../package-metadata.js';
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from './capabilities.js';
import type { AudioTranscoderStreamCapabilities } from './capabilities.js';

const INPUT = { blob: new Blob(['audio']), name: 'source.wav' };
const INSPECTION: AudioStreamInspection = {
  bitDepth: 24,
  channels: 1,
  codec: 'pcm-s24',
  container: 'WAVE',
  decodeSupport: 'built-in',
  durationSeconds: 1,
  notes: [],
  sampleRate: 48_000,
  size: 100,
  sourceEncoding: { kind: 'unknown' },
};
const RESULT: AudioStreamTranscodeResult = {
  bytesWritten: 100,
  channels: 1,
  details: { format: 'wav', rf64: false },
  durationSeconds: 1,
  format: 'wav',
  preset: {
    bitDepth: 16,
    container: 'wav',
    extension: 'wav',
    id: 'wav-pcm16',
    mimeType: 'audio/wav',
    sampleFormat: 'integer',
  },
  rf64: false,
  sampleRate: 48_000,
};
const SUPPORTED_OUTPUT: AudioStreamOutputSupportResult = {
  code: 'SUPPORTED',
  message: 'The output runtime probe succeeded.',
  reason: 'runtime-verified',
  status: 'supported',
};
const TEST_CODEC_ASSETS = Object.freeze({
  source: Object.freeze({
    baseUrl: '/codec-assets',
    kind: 'self-hosted' as const,
  }),
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('audio transcoder stream Worker pool', () => {
  it('exposes and forwards the manifest for custom Worker runtimes', async () => {
    const capabilities = Object.freeze({
      ...AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      codecRuntime: Object.freeze({
        encoderAdapter: 'custom-wasm',
        inputAdapters: Object.freeze(['custom-wasm']),
        resamplerAdapter: 'custom-wasm',
      }),
    });
    const harness = createPoolHarness({ capabilities, runtime: 'custom' });
    const inspected = harness.pool.inspect(INPUT);

    expect(harness.pool.getCapabilities()).toBe(capabilities);
    expect(harness.created).toHaveLength(1);
    harness.created[0]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await expect(inspected).resolves.toEqual(INSPECTION);
    harness.pool.terminate();
  });

  it('makes custom capability/runtime pairing explicit in the pool type', () => {
    type Factory = (workerIndex: number) => Worker;

    expectTypeOf<{}>().not.toMatchTypeOf<
      CreateAudioTranscoderStreamWorkerPoolOptions
    >();
    expectTypeOf<{ workerFactory: Factory }>().not.toMatchTypeOf<
      CreateAudioTranscoderStreamWorkerPoolOptions
    >();
    expectTypeOf<{
      codecAssets: typeof TEST_CODEC_ASSETS;
      workerFactory: Factory;
    }>().toMatchTypeOf<CreateAudioTranscoderStreamWorkerPoolOptions>();
    expectTypeOf<{
      runtime: 'custom';
      capabilities: AudioTranscoderStreamCapabilities;
      workerFactory: Factory;
    }>().toMatchTypeOf<CreateAudioTranscoderStreamWorkerPoolOptions>();
    expectTypeOf<{
      capabilities: AudioTranscoderStreamCapabilities;
    }>().not.toMatchTypeOf<CreateAudioTranscoderStreamWorkerPoolOptions>();
    expectTypeOf<{
      capabilities: AudioTranscoderStreamCapabilities;
      workerFactory: Factory;
    }>().not.toMatchTypeOf<CreateAudioTranscoderStreamWorkerPoolOptions>();
    expectTypeOf<{
      runtime: 'custom';
      capabilities: AudioTranscoderStreamCapabilities;
    }>().not.toMatchTypeOf<CreateAudioTranscoderStreamWorkerPoolOptions>();
  });

  it('rejects mismatched custom pool options from JavaScript', () => {
    const workerFactory = vi.fn(() => new WorkerStub() as unknown as Worker);
    const capabilities = { ...AUDIO_TRANSCODER_STREAM_CAPABILITIES };
    const invalidOptions: unknown[] = [
      { capabilities, workerFactory },
      { capabilities, runtime: 'custom' },
    ];

    for (const options of invalidOptions) {
      expect(() =>
        createAudioTranscoderStreamWorkerPool(
          options as CreateAudioTranscoderStreamWorkerPoolOptions,
        ),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    }
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it('creates a Worker lazily and exposes immutable queue metadata', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const { pool } = harness;

    expect(harness.created).toHaveLength(0);
    expect(pool.getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
    expect(pool.getInfo().version).toBe(AUDIO_TRANSCODER_VERSION);
    expect(pool.getCapabilities().requiresSeekableOutput).toBe(true);
    expect(pool.getQueueSnapshot()).toEqual({
      active: 0,
      concurrency: 1,
      maxQueued: 8,
      queued: 0,
      terminated: false,
      workers: 0,
    });
    expect(Object.isFrozen(pool.getQueueSnapshot())).toBe(true);

    const inspected = pool.inspect(INPUT, { inputReadBytes: 65_536 });
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]?.worker.posts[0]?.message).toMatchObject({
      options: { inputReadBytes: 65_536 },
      type: 'inspect',
    });
    expect(pool.getQueueSnapshot()).toMatchObject({ active: 1, workers: 1 });
    harness.created[0]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });

    await expect(inspected).resolves.toEqual(INSPECTION);
    await flushMicrotasks();
    expect(pool.getQueueSnapshot()).toMatchObject({ active: 0, queued: 0 });
    pool.terminate();
  });

  it('forwards codec asset loading state from each default-runtime slot', async () => {
    const worker = new WorkerStub();
    const onStateChange = vi.fn();
    const pool = createAudioTranscoderStreamWorkerPool({
      codecAssets: {
        ...TEST_CODEC_ASSETS,
        onStateChange,
      },
      idleTimeoutMs: null,
      workerFactory: () => worker as unknown as Worker,
    });
    const inspection = pool.inspect(INPUT);

    worker.emit({
      state: {
        assetName: 'resampler-balanced',
        error: null,
        loadedBytes: 100,
        phase: 'downloading',
        totalBytes: 200,
      },
      type: 'asset-state',
    });
    worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });

    await inspection;
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({
        assetName: 'resampler-balanced',
        phase: 'downloading',
      }),
    );
    await pool.dispose();
  });

  it('forwards asset state when the pool creates its built-in Worker', async () => {
    const worker = new WorkerStub();
    const onStateChange = vi.fn();
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          return worker as never;
        }
      },
    );
    const pool = createAudioTranscoderStreamWorkerPool({
      codecAssets: {
        ...TEST_CODEC_ASSETS,
        onStateChange,
      },
      idleTimeoutMs: null,
    });
    const inspection = pool.inspect(INPUT);

    worker.emit({
      state: {
        assetName: 'aac',
        error: null,
        loadedBytes: 1,
        phase: 'ready',
        totalBytes: 1,
      },
      type: 'asset-state',
    });
    worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });

    await inspection;
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ assetName: 'aac', phase: 'ready' }),
    );
    await pool.dispose();
  });

  it('forwards concrete input probes through a pool slot', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const probe = harness.pool.probeInputSupport(INPUT);

    expect(harness.created[0]?.worker.posts[0]?.message.type).toBe(
      'probeInputSupport',
    );
    harness.created[0]!.worker.emit({
      id: 1,
      operation: 'probeInputSupport',
      type: 'result',
      value: { inspection: INSPECTION, status: 'supported' },
    });
    await expect(probe).resolves.toMatchObject({ status: 'supported' });
    await harness.pool.dispose();
  });

  it('coalesces exact output probes, caches them, and clears support on shutdown', async () => {
    const harness = createPoolHarness({ concurrency: 2, idleTimeoutMs: null });
    const target = {
      channels: 2,
      presetId: 'wav-pcm16' as const,
      sampleRate: 48_000,
    };
    const first = harness.pool.probeOutputSupport(target);
    const second = harness.pool.probeOutputSupport(target);
    await flushMicrotasks();

    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]?.worker.posts).toEqual([
      {
        message: { id: 1, target, type: 'probeOutputSupport' },
        transfer: [],
      },
    ]);
    harness.created[0]!.worker.emit({
      id: 1,
      operation: 'probeOutputSupport',
      type: 'result',
      value: SUPPORTED_OUTPUT,
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(secondResult);
    await expect(harness.pool.probeOutputSupport(target)).resolves.toBe(
      firstResult,
    );
    expect(harness.created[0]?.worker.posts).toHaveLength(1);
    await harness.pool.dispose();
    await expect(harness.pool.probeOutputSupport(target)).rejects.toMatchObject({
      code: 'WORKER_TERMINATED',
    });
  });

  it('returns static output mismatches without creating a Worker', async () => {
    const harness = createPoolHarness();

    await expect(harness.pool.probeOutputSupport({
      channels: 2,
      presetId: 'mp3-320kbps',
      sampleRate: 24_000,
    })).resolves.toMatchObject({
      reason: 'sample-rate',
      status: 'unsupported-configuration',
    });
    expect(harness.created).toHaveLength(0);
    await harness.pool.dispose();
  });

  it('reprobes after all idle Workers and their runtime cache are released', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: 0 });
    const target = {
      channels: 2,
      presetId: 'wav-pcm16' as const,
      sampleRate: 48_000,
    };
    const first = harness.pool.probeOutputSupport(target);
    await flushMicrotasks();
    harness.created[0]!.worker.emit({
      id: 1,
      operation: 'probeOutputSupport',
      type: 'result',
      value: SUPPORTED_OUTPUT,
    });
    await first;
    await flushMicrotasks();
    expect(harness.pool.getQueueSnapshot().workers).toBe(0);

    const second = harness.pool.probeOutputSupport(target);
    await flushMicrotasks();
    expect(harness.created).toHaveLength(2);
    harness.created[1]!.worker.emit({
      id: 1,
      operation: 'probeOutputSupport',
      type: 'result',
      value: SUPPORTED_OUTPUT,
    });
    await second;
    await harness.pool.dispose();
  });

  it('rejects queued, aborted, and terminated output probes as control flow', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null, maxQueued: 0 });
    const active = harness.pool.inspect(INPUT);
    const target = {
      channels: 2,
      presetId: 'wav-pcm16' as const,
      sampleRate: 48_000,
    };

    await expect(harness.pool.probeOutputSupport(target)).rejects.toMatchObject({
      code: 'QUEUE_CAPACITY_EXCEEDED',
    });
    harness.created[0]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await active;

    const controller = new AbortController();
    controller.abort('pre-aborted');
    await expect(
      harness.pool.probeOutputSupport(target, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    harness.pool.terminate();
    await expect(harness.pool.probeOutputSupport(target)).rejects.toMatchObject({
      code: 'WORKER_TERMINATED',
    });
  });

  it('runs N jobs and preserves FIFO order for overflow', async () => {
    const harness = createPoolHarness({ concurrency: 2, idleTimeoutMs: null });
    const first = harness.pool.inspect(INPUT);
    const output = new WritableStream();
    const second = harness.pool.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      output,
    );
    const scheduled = vi.fn((engine) => engine.inspect(INPUT));
    const third = harness.pool.schedule(scheduled);

    expect(harness.created.map(({ index }) => index)).toEqual([0, 1]);
    expect(harness.created[0]?.worker.posts[0]?.message.type).toBe('inspect');
    expect(harness.created[1]?.worker.posts[0]?.message.type).toBe('transcode');
    expect(harness.created[1]?.worker.posts[0]?.transfer).toHaveLength(1);
    expect(harness.created[1]?.worker.posts[0]?.transfer[0]).not.toBe(output);
    expect(scheduled).not.toHaveBeenCalled();
    expect(harness.pool.getQueueSnapshot()).toEqual({
      active: 2,
      concurrency: 2,
      maxQueued: 8,
      queued: 1,
      terminated: false,
      workers: 2,
    });

    harness.created[0]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await first;
    await flushMicrotasks();
    expect(scheduled).toHaveBeenCalledOnce();
    expect(harness.created[0]?.worker.posts[1]?.message.type).toBe('inspect');

    await harness.created[1]!.worker.closePostedOutput(1);
    harness.created[1]!.worker.emit({
      id: 1,
      operation: 'transcode',
      type: 'result',
      value: RESULT,
    });
    harness.created[0]!.worker.emit({
      id: 2,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await expect(Promise.all([second, third])).resolves.toEqual([
      RESULT,
      INSPECTION,
    ]);
    harness.pool.terminate();
  });

  it('removes queued work without opening its destination', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const active = harness.pool.inspect(INPUT);
    const controller = new AbortController();
    const openDestination = vi.fn(async () => 1);
    const queued = harness.pool.schedule(openDestination, {
      signal: controller.signal,
    });

    controller.abort('remove queued');
    await expect(queued).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'remove queued',
    });
    expect(openDestination).not.toHaveBeenCalled();
    expect(harness.pool.getQueueSnapshot().queued).toBe(0);
    harness.created[0]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await active;
    harness.pool.terminate();
  });

  it('aborts a signal-canceled queued transcode before rejecting it', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const active = harness.pool.inspect(INPUT);
    const controller = new AbortController();
    const abortSettlement = deferred<void>();
    const abort = vi.fn((_reason: unknown) => abortSettlement.promise);
    const output = new WritableStream({ abort });
    const queued = harness.pool.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      output,
      { signal: controller.signal },
    );
    let settled = false;
    void queued.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    controller.abort('remove queued output');
    await flushMicrotasks();
    expect(harness.pool.getQueueSnapshot().queued).toBe(0);
    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0]?.[0]).toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'remove queued output',
    });
    expect(settled).toBe(false);

    abortSettlement.resolve();
    await expect(queued).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'remove queued output',
    });
    expect(abort).toHaveBeenCalledOnce();

    harness.created[0]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await active;
    await harness.pool.dispose();
  });

  it('awaits every queued transcode output abort during disposal', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const active = harness.pool.inspect(INPUT);
    const firstAbortSettlement = deferred<void>();
    const secondAbortSettlement = deferred<void>();
    const firstAbort = vi.fn(() => firstAbortSettlement.promise);
    const secondAbort = vi.fn(() => secondAbortSettlement.promise);
    const firstOutput = new WritableStream({ abort: firstAbort });
    const secondOutput = new WritableStream({ abort: secondAbort });
    const first = harness.pool.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      firstOutput,
    );
    const second = harness.pool.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      secondOutput,
    );

    const disposal = harness.pool.dispose();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await expect(active).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await flushMicrotasks();
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      active: 0,
      queued: 0,
      terminated: true,
    });
    expect(firstAbort).toHaveBeenCalledOnce();
    expect(secondAbort).toHaveBeenCalledOnce();
    expect(disposed).toBe(false);

    firstAbortSettlement.resolve();
    await expect(first).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await flushMicrotasks();
    expect(disposed).toBe(false);

    secondAbortSettlement.resolve();
    await expect(second).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await disposal;
    expect(firstAbort).toHaveBeenCalledOnce();
    expect(secondAbort).toHaveBeenCalledOnce();
  });

  it('keeps the queued cancellation error primary when output abort rejects', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const active = harness.pool.inspect(INPUT);
    const controller = new AbortController();
    const abortFailure = new Error('destination abort failed');
    const abort = vi.fn(async () => Promise.reject(abortFailure));
    const queued = harness.pool.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      new WritableStream({ abort }),
      { signal: controller.signal },
    );

    controller.abort('primary cancellation');
    await expect(queued).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'primary cancellation',
    });
    expect(abort).toHaveBeenCalledOnce();

    harness.created[0]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await active;
    await harness.pool.dispose();
  });

  it('aborts an unowned transcode output when Worker creation fails', async () => {
    const abortSettlement = deferred<void>();
    const abort = vi.fn(() => abortSettlement.promise);
    const pool = createAudioTranscoderStreamWorkerPool({
      codecAssets: TEST_CODEC_ASSETS,
      workerFactory() {
        throw new Error('factory failure');
      },
    });
    const transcode = pool.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      new WritableStream({ abort }),
    );
    let settled = false;
    void transcode.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await flushMicrotasks();
    expect(abort).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(pool.getQueueSnapshot().terminated).toBe(true);

    abortSettlement.resolve();
    await expect(transcode).rejects.toMatchObject({
      code: 'WORKER_FAILURE',
      message: 'factory failure',
    });
    await pool.dispose();
  });

  it('retains queued output ownership when the signal aborts during Worker creation', async () => {
    const controller = new AbortController();
    const abort = vi.fn(async () => undefined);
    const worker = new WorkerStub();
    const pool = createAudioTranscoderStreamWorkerPool({
      codecAssets: TEST_CODEC_ASSETS,
      idleTimeoutMs: null,
      workerFactory() {
        controller.abort('aborted during initialization');
        return worker as unknown as Worker;
      },
    });

    await expect(
      pool.transcode(
        INPUT,
        { presetId: 'wav-pcm16' },
        new WritableStream({ abort }),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'aborted during initialization',
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(worker.posts).toHaveLength(0);
    await pool.dispose();
  });

  it('aborts queued transcode output after a fatal active Worker failure', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const active = harness.pool.inspect(INPUT);
    const abortSettlement = deferred<void>();
    const abort = vi.fn(() => abortSettlement.promise);
    const queued = harness.pool.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      new WritableStream({ abort }),
    );

    harness.created[0]!.worker.emitError('fatal worker failure');
    await expect(active).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
    await flushMicrotasks();
    expect(abort).toHaveBeenCalledOnce();

    abortSettlement.resolve();
    await expect(queued).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
    await harness.pool.dispose();
  });

  it('ignores a detached queued-abort callback after cancellation', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const active = harness.pool.inspect(INPUT);
    const abort = createRetainedAbortSignal();
    const queued = harness.pool.schedule(async () => 1, {
      signal: abort.signal,
    });

    abort.abort('remove queued');
    await expect(queued).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    abort.invokeDetachedListener();
    harness.created[0]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await active;
    await harness.pool.dispose();
  });

  it('bounds the queue, reports capacity, and reuses canceled capacity', async () => {
    const harness = createPoolHarness({
      idleTimeoutMs: null,
      maxQueued: 1,
    });
    const active = harness.pool.inspect(INPUT);
    const controller = new AbortController();
    const queuedWork = vi.fn(async () => 1);
    const queued = harness.pool.schedule(queuedWork, {
      signal: controller.signal,
    });
    const outputAbortSettlement = deferred<void>();
    const abort = vi.fn((_reason: unknown) => outputAbortSettlement.promise);
    const rejectedOutput = new WritableStream({ abort });
    const rejected = harness.pool.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      rejectedOutput,
    );
    let rejectedSettled = false;
    void rejected.then(
      () => {
        rejectedSettled = true;
      },
      () => {
        rejectedSettled = true;
      },
    );

    await flushMicrotasks();
    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0]?.[0]).toMatchObject({
      code: 'QUEUE_CAPACITY_EXCEEDED',
      message:
        'Audio stream Worker pool queue is full (maxQueued: 1; active operations excluded).',
    });
    expect(rejectedSettled).toBe(false);
    expect(queuedWork).not.toHaveBeenCalled();
    expect(rejectedOutput.locked).toBe(false);
    expect(harness.pool.getQueueSnapshot()).toEqual({
      active: 1,
      concurrency: 1,
      maxQueued: 1,
      queued: 1,
      terminated: false,
      workers: 1,
    });

    outputAbortSettlement.resolve();
    await expect(rejected).rejects.toMatchObject({
      code: 'QUEUE_CAPACITY_EXCEEDED',
    });

    controller.abort('remove queued');
    const replacement = harness.pool.inspect(INPUT);
    await expect(queued).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'remove queued',
    });
    expect(harness.pool.getQueueSnapshot().queued).toBe(1);
    harness.created[0]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await active;
    await flushMicrotasks();
    expect(harness.created[0]?.worker.posts[1]?.message).toMatchObject({
      id: 2,
      type: 'inspect',
    });
    harness.created[0]!.worker.emit({
      id: 2,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await replacement;
    await harness.pool.dispose();
  });

  it('retires an unresponsive canceled Worker before opening the next destination', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const controller = new AbortController();
    const active = harness.pool.inspect(INPUT, { signal: controller.signal });
    const activeRejection = expect(active).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'stop active',
    });
    const openDestination = vi.fn((engine) => engine.inspect(INPUT));
    const next = harness.pool.schedule(openDestination);

    controller.abort('stop active');
    expect(harness.created[0]?.worker.posts[1]?.message).toEqual({
      id: 1,
      type: 'cancel',
    });
    await activeRejection;
    await flushMicrotasks();
    expect(harness.created[0]?.worker.terminateCalls).toBe(1);
    expect(openDestination).toHaveBeenCalledOnce();
    expect(harness.created).toHaveLength(2);
    expect(harness.created[1]?.worker.postTypes).toEqual([
      'configure',
      'inspect',
    ]);
    expect(harness.created[1]?.worker.posts[0]?.message.type).toBe('inspect');

    harness.created[1]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await next;
    await harness.pool.dispose();
  });

  it('replaces a canceled Worker without waiting for destination abort cleanup', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const controller = new AbortController();
    const abortSettlement = deferred<void>();
    const abort = vi.fn(() => abortSettlement.promise);
    const output = new WritableStream({ abort });
    const active = harness.pool.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      output,
      { signal: controller.signal },
    );
    const activeRejection = expect(active).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'stop stuck transcode',
    });
    const next = harness.pool.inspect(INPUT);

    controller.abort('stop stuck transcode');

    await activeRejection;
    await flushMicrotasks();
    expect(abort).toHaveBeenCalledOnce();
    expect(output.locked).toBe(false);
    expect(harness.created[0]?.worker.terminateCalls).toBe(1);
    expect(harness.created).toHaveLength(2);
    expect(harness.created[1]?.worker.posts[0]?.message).toMatchObject({
      id: 1,
      type: 'inspect',
    });
    harness.created[1]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await next;

    const disposal = harness.pool.dispose();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await flushMicrotasks();
    expect(disposed).toBe(false);
    abortSettlement.resolve();
    await disposal;
  });

  it('keeps repeated running cancellations at one retired Worker per attempt', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const canceled = harness.pool.inspect(INPUT, {
        signal: controller.signal,
      });
      const created = harness.created[attempt]!;

      controller.abort(`stop attempt ${attempt}`);
      created.worker.emit({
        error: { message: 'worker canceled', name: 'Error' },
        id: 1,
        type: 'error',
      });

      await expect(canceled).rejects.toMatchObject({
        code: 'OPERATION_ABORTED',
        message: `stop attempt ${attempt}`,
      });
      await flushMicrotasks();
      expect(created.worker.terminateCalls).toBe(1);
      expect(harness.pool.getQueueSnapshot()).toMatchObject({
        active: 0,
        queued: 0,
        workers: 0,
      });
    }

    const recovered = harness.pool.inspect(INPUT);
    expect(harness.created).toHaveLength(4);
    harness.created[3]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await expect(recovered).resolves.toEqual(INSPECTION);
    await harness.pool.dispose();
  });

  it('does not drain a retiring slot after pool termination', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const replacementWork = vi.fn(async () => 1);
    const canceled = harness.pool
      .schedule(async () => {
        throw new AudioTranscoderError(
          'OPERATION_ABORTED',
          'scheduled cancellation',
        );
      })
      .catch((error: unknown) => {
        harness.pool.terminate();
        throw error;
      });
    const queued = harness.pool.schedule(replacementWork);

    await expect(canceled).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
    });
    await expect(queued).rejects.toMatchObject({
      code: 'WORKER_TERMINATED',
    });
    await harness.pool.dispose();
    expect(replacementWork).not.toHaveBeenCalled();
    expect(harness.created).toHaveLength(1);
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      active: 0,
      queued: 0,
      terminated: true,
      workers: 0,
    });
  });

  it('rejects pre-aborted work before allocating a Worker', async () => {
    const harness = createPoolHarness();
    const controller = new AbortController();
    controller.abort('already stopped');

    await expect(
      harness.pool.schedule(async () => 1, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'already stopped',
    });
    expect(harness.created).toHaveLength(0);
    harness.pool.terminate();
  });

  it('aborts a pre-aborted transcode output before rejecting it', async () => {
    const harness = createPoolHarness();
    const controller = new AbortController();
    const abortSettlement = deferred<void>();
    const abort = vi.fn((_reason: unknown) => abortSettlement.promise);
    controller.abort('already stopped output');
    const transcode = harness.pool.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      new WritableStream({ abort }),
      { signal: controller.signal },
    );
    let settled = false;
    void transcode.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await flushMicrotasks();
    expect(abort).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(harness.created).toHaveLength(0);

    abortSettlement.reject(new Error('abort cleanup failed'));
    await expect(transcode).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'already stopped output',
    });
    await harness.pool.dispose();
  });

  it('aborts transcode output submitted after pool disposal', async () => {
    const harness = createPoolHarness();
    await harness.pool.dispose();
    const abortSettlement = deferred<void>();
    const abort = vi.fn((_reason: unknown) => abortSettlement.promise);
    const transcode = harness.pool.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      new WritableStream({ abort }),
    );
    let settled = false;
    void transcode.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await flushMicrotasks();
    expect(abort).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    abortSettlement.resolve();
    await expect(transcode).rejects.toMatchObject({
      code: 'WORKER_TERMINATED',
    });
  });

  it('continues after synchronous and non-fatal operation failures', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const synchronous = harness.pool.schedule(
      (() => {
        throw new Error('synchronous failure');
      }) as never,
    );
    await expect(synchronous).rejects.toThrow('synchronous failure');

    const failed = harness.pool.inspect(INPUT);
    const next = harness.pool.inspect(INPUT);
    harness.created[0]!.worker.emit({
      error: {
        code: 'UNSUPPORTED_INPUT',
        message: 'bad file',
        name: 'AudioTranscoderError',
      },
      id: 1,
      type: 'error',
    });
    await expect(failed).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' });
    await flushMicrotasks();
    expect(harness.created[0]?.worker.posts[1]?.message.type).toBe('inspect');
    harness.created[0]!.worker.emit({
      id: 2,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await next;
    harness.pool.terminate();
  });

  it('shuts down after a synchronous fatal scheduled failure', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const failed = harness.pool.schedule(
      (() => {
        throw new AudioTranscoderError(
          'WORKER_TERMINATED',
          'synchronous fatal failure',
        );
      }) as never,
    );

    await expect(failed).rejects.toMatchObject({
      code: 'WORKER_TERMINATED',
      message: 'synchronous fatal failure',
    });
    expect(harness.pool.getQueueSnapshot().terminated).toBe(true);
    await harness.pool.dispose();
  });

  it.each(['WORKER_FAILURE', 'WORKER_TERMINATED'] as const)(
    'shuts down the pool after fatal %s errors',
    async (code) => {
      const harness = createPoolHarness({ idleTimeoutMs: null });
      const active =
        code === 'WORKER_FAILURE'
          ? harness.pool.inspect(INPUT)
          : harness.pool.schedule(async () => {
              throw new AudioTranscoderError(code, 'fatal operation');
            });
      const controller = new AbortController();
      const queued = harness.pool.schedule(async () => 2, {
        signal: controller.signal,
      });

      if (code === 'WORKER_FAILURE') {
        harness.created[0]!.worker.emitError('worker crashed');
      }
      await expect(active).rejects.toMatchObject({ code });
      await expect(queued).rejects.toMatchObject({ code });
      await flushMicrotasks();
      expect(harness.pool.getQueueSnapshot()).toMatchObject({
        active: 0,
        queued: 0,
        terminated: true,
        workers: 0,
      });
      await expect(harness.pool.inspect(INPUT)).rejects.toMatchObject({
        code: 'WORKER_TERMINATED',
      });
      harness.pool.terminate();
    },
  );

  it('terminates active and queued scheduled work idempotently', async () => {
    const harness = createPoolHarness({ concurrency: 2, idleTimeoutMs: null });
    let finish!: () => void;
    const active = harness.pool.schedule(
      async () =>
        new Promise<number>((resolve) => {
          finish = () => resolve(1);
        }),
    );
    const workerActive = harness.pool.inspect(INPUT);
    const queued = harness.pool.schedule(async () => 3);

    harness.pool.terminate();
    harness.pool.terminate();
    await expect(active).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await expect(workerActive).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await expect(queued).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    finish();
    await flushMicrotasks();
    expect(harness.created[0]?.worker.terminateCalls).toBe(1);
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      active: 0,
      terminated: true,
      workers: 0,
    });
  });

  it('awaits every active output abort before pool disposal resolves', async () => {
    const harness = createPoolHarness({
      concurrency: 2,
      idleTimeoutMs: null,
      maxQueued: 1,
    });
    const firstAbort = deferred<void>();
    const secondAbort = deferred<void>();
    const firstOutput = new WritableStream({ abort: () => firstAbort.promise });
    const secondOutput = new WritableStream({ abort: () => secondAbort.promise });
    const first = harness.pool.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      firstOutput,
    );
    const second = harness.pool.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      secondOutput,
    );
    const queuedWork = vi.fn(async () => 3);
    const queued = harness.pool.schedule(queuedWork);

    const disposal = harness.pool.dispose();
    expect(harness.pool.dispose()).toBe(disposal);
    harness.pool.terminate();
    await expect(first).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await expect(second).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await expect(queued).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    expect(queuedWork).not.toHaveBeenCalled();
    expect(harness.pool.getQueueSnapshot()).toEqual({
      active: 0,
      concurrency: 2,
      maxQueued: 1,
      queued: 0,
      terminated: true,
      workers: 0,
    });
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await flushMicrotasks();
    expect(disposed).toBe(false);
    expect(firstOutput.locked).toBe(false);
    expect(secondOutput.locked).toBe(false);

    firstAbort.resolve();
    await flushMicrotasks();
    expect(firstOutput.locked).toBe(false);
    expect(secondOutput.locked).toBe(false);
    expect(disposed).toBe(false);

    secondAbort.resolve();
    await disposal;
    expect(firstOutput.locked).toBe(false);
    expect(secondOutput.locked).toBe(false);
    expect(harness.created.map(({ worker }) => worker.terminateCalls)).toEqual([
      1,
      1,
    ]);
  });

  it('releases idle Workers and recreates them on demand', async () => {
    vi.useFakeTimers();
    const harness = createPoolHarness({ concurrency: 2, idleTimeoutMs: 10 });
    const first = harness.pool.inspect(INPUT);
    harness.created[0]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await first;
    await flushMicrotasks();
    expect(harness.pool.getQueueSnapshot().workers).toBe(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(harness.created[0]?.worker.terminateCalls).toBe(1);
    expect(harness.pool.getQueueSnapshot().workers).toBe(0);

    const second = harness.pool.inspect(INPUT);
    expect(harness.created).toHaveLength(2);
    expect(harness.created[1]?.index).toBe(0);
    harness.created[1]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await second;
    harness.pool.terminate();
  });

  it('snapshots codec asset sources before lazy Worker allocation', async () => {
    const source: { baseUrl: string; kind: 'self-hosted' } = {
      baseUrl: '/codec-primary/',
      kind: 'self-hosted',
    };
    const fallback: { baseUrl: string; kind: 'self-hosted' } = {
      baseUrl: '/codec-fallback/',
      kind: 'self-hosted',
    };
    const fallbackSources = [fallback];
    const created: WorkerStub[] = [];
    const pool = createAudioTranscoderStreamWorkerPool({
      codecAssets: { fallbackSources, source },
      workerFactory() {
        const worker = new WorkerStub();
        created.push(worker);
        return worker as unknown as Worker;
      },
    });

    source.baseUrl = '/mutated-primary';
    fallback.baseUrl = '/mutated-fallback';
    fallbackSources.push({
      baseUrl: '/new-fallback',
      kind: 'self-hosted',
    });

    const inspection = pool.inspect(INPUT);

    expect(created).toHaveLength(1);
    expect(created[0]?.configurations).toEqual([
      {
        codecAssets: {
          fallbackSources: [
            { baseUrl: '/codec-fallback', kind: 'self-hosted' },
          ],
          source: { baseUrl: '/codec-primary', kind: 'self-hosted' },
        },
        type: 'configure',
      },
    ]);
    created[0]!.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await inspection;
    await pool.dispose();
  });

  it('supports immediate idle release and retaining idle Workers', async () => {
    const immediate = createPoolHarness({ idleTimeoutMs: 0 });
    const immediateResult = immediate.pool.inspect(INPUT);
    immediate.created[0]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await immediateResult;
    await flushMicrotasks();
    expect(immediate.pool.getQueueSnapshot().workers).toBe(0);
    immediate.pool.terminate();

    vi.useFakeTimers();
    const retained = createPoolHarness({ idleTimeoutMs: null });
    const retainedResult = retained.pool.inspect(INPUT);
    retained.created[0]!.worker.emit({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    });
    await retainedResult;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retained.pool.getQueueSnapshot().workers).toBe(1);
    retained.pool.terminate();
  });

  it.each([0, -1, 1.5, 5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid concurrency %s',
    (concurrency) => {
      expect(() =>
        createAudioTranscoderStreamWorkerPool({
          codecAssets: TEST_CODEC_ASSETS,
          concurrency,
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    },
  );

  it.each([-1, 1.5, 65, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maxQueued %s',
    (maxQueued) => {
      expect(() =>
        createAudioTranscoderStreamWorkerPool({
          codecAssets: TEST_CODEC_ASSETS,
          maxQueued,
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    },
  );

  it('accepts concurrency and queue-capacity boundaries lazily', async () => {
    const minimum = createPoolHarness({ concurrency: 4, maxQueued: 0 });
    const maximum = createPoolHarness({ maxQueued: 64 });

    expect(minimum.created).toHaveLength(0);
    expect(minimum.pool.getQueueSnapshot()).toEqual({
      active: 0,
      concurrency: 4,
      maxQueued: 0,
      queued: 0,
      terminated: false,
      workers: 0,
    });
    expect(maximum.created).toHaveLength(0);
    expect(maximum.pool.getQueueSnapshot().maxQueued).toBe(64);
    await Promise.all([minimum.pool.dispose(), maximum.pool.dispose()]);
  });

  it('uses safe defaults for a legacy capability manifest', async () => {
    const capabilities = {
      ...AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      limits: {
        ...AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits,
        maximumConcurrency: undefined,
        queue: undefined,
      },
    } as unknown as typeof AUDIO_TRANSCODER_STREAM_CAPABILITIES;
    const harness = createPoolHarness({
      capabilities,
      concurrency: 4,
      runtime: 'custom',
    });

    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      concurrency: 4,
      maxQueued: 8,
    });
    await harness.pool.dispose();
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid idle timeout %s',
    (idleTimeoutMs) => {
      expect(() =>
        createAudioTranscoderStreamWorkerPool({
          codecAssets: TEST_CODEC_ASSETS,
          idleTimeoutMs,
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    },
  );

  it.each([
    [new Error('factory error'), 'factory error', 'WORKER_FAILURE'],
    ['unknown failure', 'Audio stream Worker creation failed.', 'WORKER_FAILURE'],
    [
      new AudioTranscoderError('WORKER_UNAVAILABLE', 'custom unavailable'),
      'custom unavailable',
      'WORKER_UNAVAILABLE',
    ],
  ] as const)(
    'normalizes lazy Worker factory failures %#',
    async (failure, message, code) => {
      const pool = createAudioTranscoderStreamWorkerPool({
        codecAssets: TEST_CODEC_ASSETS,
        workerFactory() {
          throw failure;
        },
      });
      await expect(pool.inspect(INPUT)).rejects.toMatchObject({ code, message });
      expect(pool.getQueueSnapshot().terminated).toBe(true);
    },
  );

  it('preserves the native Worker unavailable error', async () => {
    vi.stubGlobal('Worker', undefined);
    const pool = createAudioTranscoderStreamWorkerPool({
      codecAssets: TEST_CODEC_ASSETS,
    });
    await expect(pool.inspect(INPUT)).rejects.toMatchObject({
      code: 'WORKER_UNAVAILABLE',
    });
    expect(pool.getQueueSnapshot().terminated).toBe(true);
  });
});

interface CreatedWorker {
  readonly index: number;
  readonly worker: WorkerStub;
}

function createPoolHarness(
  options: PoolHarnessOptions = {},
) {
  const created: CreatedWorker[] = [];
  const workerFactory = (index: number): Worker => {
      const worker = new WorkerStub();
      created.push({ index, worker });
      return worker as unknown as Worker;
  };
  const pool =
    options.runtime === 'custom'
      ? createAudioTranscoderStreamWorkerPool({ ...options, workerFactory })
      : createAudioTranscoderStreamWorkerPool({
          ...options,
          codecAssets: TEST_CODEC_ASSETS,
          workerFactory,
        });
  return { created, pool };
}

type PoolHarnessOptions = {
  readonly concurrency?: number;
  readonly idleTimeoutMs?: number | null;
  readonly maxQueued?: number;
} & (
  | {
      readonly capabilities: AudioTranscoderStreamCapabilities;
      readonly runtime: 'custom';
    }
  | {
      readonly capabilities?: never;
      readonly runtime?: 'default';
    }
);

interface WorkerPost {
  readonly message: AudioStreamWorkerRequest;
  readonly transfer: readonly Transferable[];
}

class WorkerStub {
  readonly listeners = {
    error: [] as ((event: ErrorEvent) => void)[],
    message: [] as ((event: MessageEvent<AudioStreamWorkerResponse>) => void)[],
    messageerror: [] as (() => void)[],
  };
  readonly posts: WorkerPost[] = [];
  readonly postTypes: AudioStreamWorkerRequest['type'][] = [];
  readonly configurations: AudioStreamWorkerRequest[] = [];
  terminateCalls = 0;

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') {
      this.listeners.message.push(
        listener as unknown as (
          event: MessageEvent<AudioStreamWorkerResponse>,
        ) => void,
      );
    } else if (type === 'error') {
      this.listeners.error.push(listener as unknown as (event: ErrorEvent) => void);
    } else {
      this.listeners.messageerror.push(listener as unknown as () => void);
    }
  }

  emit(message: AudioStreamWorkerResponse): void {
    for (const listener of this.listeners.message) {
      listener({ data: message } as MessageEvent<AudioStreamWorkerResponse>);
    }
  }

  emitError(message: string): void {
    for (const listener of this.listeners.error) {
      listener({ message } as ErrorEvent);
    }
  }

  postMessage(
    message: AudioStreamWorkerRequest,
    transfer: Transferable[] = [],
  ): void {
    this.postTypes.push(message.type);
    if (message.type === 'configure') {
      this.configurations.push(message);
      return;
    }
    this.posts.push({ message, transfer });
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  async closePostedOutput(id: number): Promise<void> {
    const post = this.posts.find(
      ({ message }) => message.type === 'transcode' && message.id === id,
    );
    if (post?.message.type !== 'transcode') {
      throw new Error(`No transcode output was posted for operation ${id}.`);
    }
    const writer = post.message.output.getWriter();
    try {
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createRetainedAbortSignal() {
  let aborted = false;
  let activeListener: (() => void) | undefined;
  let detachedListener: (() => void) | undefined;
  let reason: unknown;
  const signal = {
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      activeListener =
        typeof listener === 'function'
          ? () => listener.call(signal, new Event('abort'))
          : () => listener.handleEvent(new Event('abort'));
    },
    get aborted() {
      return aborted;
    },
    get reason() {
      return reason;
    },
    removeEventListener() {
      detachedListener = activeListener;
      activeListener = undefined;
    },
  } as unknown as AbortSignal;
  return {
    abort(abortReason: unknown): void {
      aborted = true;
      reason = abortReason;
      activeListener?.();
    },
    invokeDetachedListener(): void {
      detachedListener?.();
    },
    signal,
  };
}
