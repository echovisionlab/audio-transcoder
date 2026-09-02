import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AudioProgress,
  DecodedAudio,
  EncodedAudio,
} from '../engine/contracts.js';
import { AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES } from '../engine/buffer-policy.js';
import { AUDIO_TRANSCODER_VERSION } from '../package-metadata.js';
import type { AudioWorkerRequest, AudioWorkerResponse } from './protocol.js';
import { createAudioTranscoderWorkerPool } from './pool.js';

const PRESET = {
  bitDepth: 16,
  container: 'wav',
  extension: 'wav',
  id: 'wav-pcm16',
  mimeType: 'audio/wav',
  sampleFormat: 'integer' as const,
};
const DECODED: DecodedAudio = {
  channelData: [new Float32Array([0])],
  durationSeconds: 1,
  sampleRate: 1,
  source: 'pool worker',
};
const ENCODED: EncodedAudio = { data: new ArrayBuffer(1), preset: PRESET };
const PROGRESS: AudioProgress = {
  completedFrames: 1,
  operation: 'decode',
  phase: 'decode',
  progress: 0.5,
  totalFrames: 2,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('audio transcoder Worker pool', () => {
  it('creates Workers lazily while keeping metadata and inspection local', async () => {
    const harness = createPoolHarness();
    const { pool } = harness;

    expect(harness.created).toHaveLength(0);
    expect(pool.getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
    expect(pool.getInfo().version).toBe(AUDIO_TRANSCODER_VERSION);
    expect(pool.getCapabilities().decode).toContain('wav');
    expect(pool.inspect({ data: new ArrayBuffer(0) }).container).toBe('Unknown');
    expect(pool.getQueueSnapshot()).toEqual({
      active: 0,
      concurrency: 1,
      maxQueued: 8,
      maxQueuedBytes: AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES,
      queued: 0,
      queuedBytes: 0,
      terminated: false,
      workers: 0,
    });
    expect(Object.isFrozen(pool.getQueueSnapshot())).toBe(true);

    const result = pool.decode({ data: new ArrayBuffer(1) });

    expect(harness.created).toHaveLength(1);
    expect(pool.getQueueSnapshot()).toMatchObject({ active: 1, workers: 1 });
    harness.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });

    await expect(result).resolves.toEqual(DECODED);
    await flushMicrotasks();
    expect(pool.getQueueSnapshot()).toMatchObject({ active: 0, queued: 0 });
    pool.terminate();
  });

  it('runs up to N operations and preserves FIFO order for overflow', async () => {
    const harness = createPoolHarness({ concurrency: 2, idleTimeoutMs: null });
    const progress = vi.fn();
    const decoded = harness.pool.decode(
      { data: new ArrayBuffer(1) },
      { onProgress: progress },
    );
    const encoded = harness.pool.encode(
      { channelData: [new Float32Array(1)], sampleRate: 1 },
      PRESET.id,
    );
    const transcoded = harness.pool.transcode(
      { data: new ArrayBuffer(1) },
      PRESET.id,
    );

    expect(harness.created.map(({ index }) => index)).toEqual([0, 1]);
    expect(harness.created[0]?.worker.posts[0]?.message.type).toBe('decode');
    expect(harness.created[1]?.worker.posts[0]?.message.type).toBe('encode');
    expect(harness.pool.getQueueSnapshot()).toEqual({
      active: 2,
      concurrency: 2,
      maxQueued: 8,
      maxQueuedBytes: AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES,
      queued: 1,
      queuedBytes: 1,
      terminated: false,
      workers: 2,
    });

    harness.created[0]!.worker.emitMessage({
      id: 1,
      progress: PROGRESS,
      type: 'progress',
    });
    harness.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await decoded;
    await flushMicrotasks();

    expect(progress).toHaveBeenCalledWith(PROGRESS);
    expect(harness.created[0]?.worker.posts[1]?.message.type).toBe('transcode');
    harness.created[1]!.worker.emitMessage({
      id: 1,
      operation: 'encode',
      type: 'result',
      value: ENCODED,
    });
    harness.created[0]!.worker.emitMessage({
      id: 2,
      operation: 'transcode',
      type: 'result',
      value: ENCODED,
    });

    await expect(Promise.all([encoded, transcoded])).resolves.toEqual([
      ENCODED,
      ENCODED,
    ]);
    await flushMicrotasks();
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      active: 0,
      queued: 0,
      workers: 2,
    });
    harness.pool.terminate();
  });

  it('defers scheduled input loading until a slot is available', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const firstLoad = vi.fn();
    const secondLoad = vi.fn();
    const first = harness.pool.schedule(async (engine) => {
      firstLoad();
      return engine.decode({ data: new ArrayBuffer(1) });
    });
    const second = harness.pool.schedule(async (engine) => {
      secondLoad();
      return engine.decode({ data: new ArrayBuffer(1) });
    });

    expect(firstLoad).toHaveBeenCalledOnce();
    expect(secondLoad).not.toHaveBeenCalled();
    expect(harness.pool.getQueueSnapshot().queued).toBe(1);

    harness.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await first;
    await flushMicrotasks();

    expect(secondLoad).toHaveBeenCalledOnce();
    harness.created[0]!.worker.emitMessage({
      id: 2,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await second;
    harness.pool.terminate();
  });

  it('releases cancelled queue capacity synchronously and re-enqueues', async () => {
    const harness = createPoolHarness({
      idleTimeoutMs: null,
      maxQueued: 1,
      maxQueuedBytes: 1,
    });
    const active = harness.pool.decode({ data: new ArrayBuffer(1) });
    const controller = createManualAbortSignal();
    const queued = harness.pool.decode(
      { data: new ArrayBuffer(1) },
      { signal: controller.signal },
    );

    expect(harness.pool.getQueueSnapshot().queued).toBe(1);
    controller.abort('remove queued item');
    const replacement = harness.pool.decode({ data: new ArrayBuffer(1) });
    controller.invokeDetachedListener();

    await expect(queued).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'remove queued item',
    });
    expect(harness.created[0]?.worker.posts).toHaveLength(1);
    expect(controller.signal.removeEventListener).toHaveBeenCalledOnce();
    expect(harness.pool.getQueueSnapshot()).toEqual({
      active: 1,
      concurrency: 1,
      maxQueued: 1,
      maxQueuedBytes: 1,
      queued: 1,
      queuedBytes: 1,
      terminated: false,
      workers: 1,
    });

    harness.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await active;
    await flushMicrotasks();
    expect(harness.created[0]?.worker.posts[1]?.message.type).toBe('decode');
    harness.created[0]!.worker.emitMessage({
      id: 2,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await replacement;
    harness.pool.terminate();
  });

  it('rejects a full queue before invoking work or allocating another Worker', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null, maxQueued: 1 });
    const active = harness.pool.decode({ data: new ArrayBuffer(1) });
    const queuedWork = vi.fn(async () => 1);
    const rejectedWork = vi.fn(async () => 2);
    const queued = harness.pool.schedule(queuedWork);

    await expect(harness.pool.schedule(rejectedWork)).rejects.toMatchObject({
      code: 'QUEUE_CAPACITY_EXCEEDED',
      message:
        'Audio transcoder Worker pool queue is full (maxQueued: 1; active operations excluded).',
    });
    expect(queuedWork).not.toHaveBeenCalled();
    expect(rejectedWork).not.toHaveBeenCalled();
    expect(harness.created).toHaveLength(1);
    expect(harness.pool.getQueueSnapshot()).toEqual({
      active: 1,
      concurrency: 1,
      maxQueued: 1,
      maxQueuedBytes: AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES,
      queued: 1,
      queuedBytes: 0,
      terminated: false,
      workers: 1,
    });

    harness.pool.terminate();
    await Promise.allSettled([active, queued]);
  });

  it('enforces aggregate waiting bytes without charging the active operation', async () => {
    const harness = createPoolHarness({
      idleTimeoutMs: null,
      maxQueuedBytes: 3,
    });
    const active = harness.pool.decode({ data: new ArrayBuffer(16) });
    const queued = harness.pool.decode({ data: new ArrayBuffer(2) });

    await expect(
      harness.pool.transcode(
        { data: new ArrayBuffer(2) },
        PRESET.id,
        { unsafeAllowLargeBuffers: true },
      ),
    ).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message:
        'Audio transcoder Worker pool waiting queue exceeds maxQueuedBytes (3 bytes; queued: 2 bytes; requested: 2 bytes; active operations excluded).',
    });
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      active: 1,
      maxQueuedBytes: 3,
      queued: 1,
      queuedBytes: 2,
    });

    harness.pool.terminate();
    await Promise.allSettled([active, queued]);
  });

  it('reuses released bytes across multiple Worker slots', async () => {
    const harness = createPoolHarness({
      concurrency: 2,
      idleTimeoutMs: null,
      maxQueuedBytes: 4,
    });
    const first = harness.pool.decode({ data: new ArrayBuffer(32) });
    const second = harness.pool.decode({ data: new ArrayBuffer(32) });
    const queued = harness.pool.decode({ data: new ArrayBuffer(4) });

    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      active: 2,
      queued: 1,
      queuedBytes: 4,
    });
    await expect(
      harness.pool.decode({ data: new ArrayBuffer(1) }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });

    harness.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await first;
    await flushMicrotasks();
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      active: 2,
      queued: 0,
      queuedBytes: 0,
    });

    const replacement = harness.pool.decode({ data: new ArrayBuffer(4) });
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      active: 2,
      queued: 1,
      queuedBytes: 4,
    });

    harness.pool.terminate();
    await Promise.allSettled([second, queued, replacement]);
  });

  it('charges shared PCM once using the full backing buffer size', async () => {
    const harness = createPoolHarness({
      idleTimeoutMs: null,
      maxQueuedBytes: 16,
    });
    const active = harness.pool.decode({ data: new ArrayBuffer(1) });
    const backing = new ArrayBuffer(16);
    const queued = harness.pool.encode(
      {
        channelData: [
          new Float32Array(backing, 0, 1),
          new Float32Array(backing, 4, 1),
        ],
        sampleRate: 1,
      },
      PRESET.id,
    );

    expect(harness.pool.getQueueSnapshot().queuedBytes).toBe(16);
    await expect(
      harness.pool.decode({ data: new ArrayBuffer(1) }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });

    harness.pool.terminate();
    await Promise.allSettled([active, queued]);
  });

  it('uses overflow-safe pool byte accounting at the safe-integer boundary', async () => {
    const harness = createPoolHarness({
      idleTimeoutMs: null,
      maxQueuedBytes: Number.MAX_SAFE_INTEGER,
    });
    const active = harness.pool.decode({ data: new ArrayBuffer(1) });
    const queued = harness.pool.decode(
      { data: fakeTransferableBuffer(Number.MAX_SAFE_INTEGER) },
      { transferInput: true, unsafeAllowLargeBuffers: true },
    );

    await expect(
      harness.pool.decode(
        { data: fakeTransferableBuffer(Number.MAX_SAFE_INTEGER + 1) },
        { transferInput: true, unsafeAllowLargeBuffers: true },
      ),
    ).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message: expect.stringContaining('requested: an unsafe size'),
    });

    harness.pool.terminate();
    await Promise.allSettled([active, queued]);
  });

  it('releases a reservation after synchronous queued snapshot failure', async () => {
    const harness = createPoolHarness({
      idleTimeoutMs: null,
      maxQueuedBytes: 1,
    });
    const active = harness.pool.decode({ data: new ArrayBuffer(1) });
    const failure = new Error('snapshot failed');
    let reads = 0;
    const input = {
      get data(): ArrayBuffer {
        reads += 1;
        if (reads === 1) {
          return new ArrayBuffer(1);
        }
        throw failure;
      },
    };

    await expect(harness.pool.decode(input)).rejects.toBe(failure);
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      queued: 0,
      queuedBytes: 0,
    });
    const replacement = harness.pool.decode({ data: new ArrayBuffer(1) });
    expect(harness.pool.getQueueSnapshot().queuedBytes).toBe(1);

    harness.pool.terminate();
    await Promise.allSettled([active, replacement]);
  });

  it('rejects retained-byte getter failures without allocating a Worker', async () => {
    const harness = createPoolHarness();
    const failure = new Error('byte length failed');
    const input = {
      get data(): ArrayBuffer {
        throw failure;
      },
    };

    await expect(harness.pool.decode(input)).rejects.toBe(failure);
    expect(harness.created).toHaveLength(0);
    expect(harness.pool.getQueueSnapshot().queuedBytes).toBe(0);
    harness.pool.terminate();
  });

  it('releases pool bytes when abort listener registration throws', async () => {
    const harness = createPoolHarness({
      idleTimeoutMs: null,
      maxQueuedBytes: 1,
    });
    const active = harness.pool.decode({ data: new ArrayBuffer(1) });
    const failure = new Error('listener registration failed');
    const signal = {
      aborted: false,
      addEventListener(): never {
        throw failure;
      },
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(
      harness.pool.decode({ data: new ArrayBuffer(1) }, { signal }),
    ).rejects.toBe(failure);
    const replacement = harness.pool.decode({ data: new ArrayBuffer(1) });
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      queued: 1,
      queuedBytes: 1,
    });

    harness.pool.terminate();
    await Promise.allSettled([active, replacement]);
  });

  it('lets maxQueued zero reject before inspecting retained PCM buffers', async () => {
    const harness = createPoolHarness({
      idleTimeoutMs: null,
      maxQueued: 0,
      maxQueuedBytes: 0,
    });
    const active = harness.pool.decode({ data: new ArrayBuffer(1) });
    const channelData = [new Float32Array(1)];
    const iterateChannels = vi.spyOn(channelData, Symbol.iterator);

    await expect(
      harness.pool.encode({ channelData, sampleRate: 1 }, PRESET.id),
    ).rejects.toMatchObject({ code: 'QUEUE_CAPACITY_EXCEEDED' });
    expect(iterateChannels).not.toHaveBeenCalled();
    expect(harness.pool.getQueueSnapshot().queuedBytes).toBe(0);

    harness.pool.terminate();
    await Promise.allSettled([active]);
  });

  it('does not charge pre-aborted work against queue capacity', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null, maxQueued: 1 });
    const active = harness.pool.decode({ data: new ArrayBuffer(1) });
    const controller = new AbortController();
    controller.abort('already stopped');

    await expect(
      harness.pool.decode(
        { data: new ArrayBuffer(1) },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'already stopped',
    });
    const queued = harness.pool.decode({ data: new ArrayBuffer(1) });
    expect(harness.pool.getQueueSnapshot().queued).toBe(1);

    harness.pool.terminate();
    await Promise.allSettled([active, queued]);
  });

  it('delegates running cancellation and starts the next queued item', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const controller = new AbortController();
    const active = harness.pool.decode(
      { data: new ArrayBuffer(1) },
      { signal: controller.signal },
    );
    const next = harness.pool.decode({ data: new ArrayBuffer(1) });

    controller.abort('stop active item');
    await flushMicrotasks();
    expect(harness.created[0]?.worker.posts[1]?.message).toEqual({
      id: 1,
      type: 'cancel',
    });
    expect(harness.created[0]?.worker.posts).toHaveLength(2);

    harness.created[0]!.worker.emitMessage({
      error: { message: 'worker canceled', name: 'Error' },
      id: 1,
      type: 'error',
    });
    await expect(active).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'stop active item',
    });
    await flushMicrotasks();
    expect(harness.created[0]?.worker.posts[2]?.message.type).toBe('decode');

    harness.created[0]!.worker.emitMessage({
      id: 2,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await next;
    harness.pool.terminate();
  });

  it('rejects pre-aborted work before allocating a Worker', async () => {
    const harness = createPoolHarness();
    const signal = {
      aborted: true,
      reason: 'already cancelled',
    } as AbortSignal;

    await expect(
      harness.pool.schedule(async () => 1, { signal }),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'already cancelled',
    });
    expect(harness.created).toHaveLength(0);
    harness.pool.terminate();
  });

  it('continues after synchronous and non-fatal operation failures', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const synchronous = harness.pool.schedule(() => {
      throw new Error('synchronous failure');
    });

    await expect(synchronous).rejects.toThrow('synchronous failure');

    const failed = harness.pool.decode({ data: new ArrayBuffer(1) });
    const next = harness.pool.decode({ data: new ArrayBuffer(1) });
    harness.created[0]!.worker.emitMessage({
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
    expect(harness.created[0]?.worker.posts[1]?.message.type).toBe('decode');
    harness.created[0]!.worker.emitMessage({
      id: 2,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await next;
    harness.pool.terminate();
  });

  it('terminates the pool after a fatal Worker failure', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const active = harness.pool.decode({ data: new ArrayBuffer(1) });
    const queued = harness.pool.decode({ data: new ArrayBuffer(1) });

    harness.created[0]!.worker.emitError('worker crashed');

    await expect(active).rejects.toMatchObject({
      code: 'WORKER_FAILURE',
      message: 'worker crashed',
    });
    await expect(queued).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
    await flushMicrotasks();
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      active: 0,
      queued: 0,
      terminated: true,
      workers: 0,
    });
    await expect(
      harness.pool.decode({ data: new ArrayBuffer(1) }),
    ).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    harness.pool.terminate();
  });

  it('terminates active and queued work idempotently', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const active = harness.pool.decode({ data: new ArrayBuffer(1) });
    const queuedSignal = createManualAbortSignal();
    const queued = harness.pool.decode(
      { data: new ArrayBuffer(1) },
      { signal: queuedSignal.signal },
    );

    harness.pool.terminate();
    harness.pool.terminate();

    await expect(active).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await expect(queued).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await flushMicrotasks();
    expect(harness.created[0]?.worker.terminateCalls).toBe(1);
    expect(queuedSignal.signal.removeEventListener).toHaveBeenCalledOnce();
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      active: 0,
      queuedBytes: 0,
      terminated: true,
      workers: 0,
    });
  });

  it('settles scheduled work even when its callback ignores Worker termination', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    let finish!: () => void;
    const active = harness.pool.schedule(
      async () =>
        new Promise<number>((resolve) => {
          finish = () => resolve(1);
        }),
    );

    harness.pool.terminate();

    await expect(active).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    finish();
    await flushMicrotasks();
    expect(harness.pool.getQueueSnapshot().active).toBe(0);
  });

  it('releases idle Workers and recreates them on demand', async () => {
    vi.useFakeTimers();
    const harness = createPoolHarness({ idleTimeoutMs: 10 });
    const first = harness.pool.decode({ data: new ArrayBuffer(1) });
    harness.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await first;
    await flushMicrotasks();

    expect(harness.pool.getQueueSnapshot().workers).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.created[0]?.worker.terminateCalls).toBe(1);
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      terminated: false,
      workers: 0,
    });

    const second = harness.pool.decode({ data: new ArrayBuffer(1) });
    expect(harness.created).toHaveLength(2);
    expect(harness.created[1]?.index).toBe(0);
    harness.created[1]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await second;
    harness.pool.terminate();
  });

  it('supports immediate idle release and disabling idle release', async () => {
    const immediate = createPoolHarness({ idleTimeoutMs: 0 });
    const immediateResult = immediate.pool.decode({ data: new ArrayBuffer(1) });
    immediate.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await immediateResult;
    await flushMicrotasks();
    expect(immediate.pool.getQueueSnapshot().workers).toBe(0);
    immediate.pool.terminate();

    vi.useFakeTimers();
    const retained = createPoolHarness({ idleTimeoutMs: null });
    const retainedResult = retained.pool.decode({ data: new ArrayBuffer(1) });
    retained.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await retainedResult;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retained.pool.getQueueSnapshot().workers).toBe(1);
    retained.pool.terminate();
  });

  it.each([
    0,
    -1,
    1.5,
    5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'rejects invalid concurrency %s',
    (concurrency) => {
      expect(() =>
        createAudioTranscoderWorkerPool({ concurrency }),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    },
  );

  it.each([
    -1,
    1.5,
    65,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'rejects invalid maxQueued %s',
    (maxQueued) => {
      expect(() =>
        createAudioTranscoderWorkerPool({ maxQueued }),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVALID_CONFIGURATION',
          message: 'Worker pool maxQueued must be an integer from 0 to 64.',
        }),
      );
    },
  );

  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid maxQueuedBytes %s', (maxQueuedBytes) => {
    expect(() =>
      createAudioTranscoderWorkerPool({ maxQueuedBytes }),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_CONFIGURATION',
        message:
          'Worker pool maxQueuedBytes must be a non-negative safe integer.',
      }),
    );
  });

  it('accepts concurrency and queue boundaries lazily', () => {
    const minimum = createPoolHarness({
      concurrency: 4,
      maxQueued: 0,
      maxQueuedBytes: 0,
    });
    const maximum = createPoolHarness({
      maxQueued: 64,
      maxQueuedBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(minimum.created).toHaveLength(0);
    expect(minimum.pool.getQueueSnapshot()).toEqual({
      active: 0,
      concurrency: 4,
      maxQueued: 0,
      maxQueuedBytes: 0,
      queued: 0,
      queuedBytes: 0,
      terminated: false,
      workers: 0,
    });
    expect(maximum.created).toHaveLength(0);
    expect(maximum.pool.getQueueSnapshot().maxQueued).toBe(64);
    expect(maximum.pool.getQueueSnapshot().maxQueuedBytes).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    minimum.pool.terminate();
    maximum.pool.terminate();
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid idle timeout %s',
    (idleTimeoutMs) => {
      expect(() =>
        createAudioTranscoderWorkerPool({ idleTimeoutMs }),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    },
  );

  it.each([
    [new Error('factory error'), 'factory error'],
    ['unknown factory error', 'Audio Worker creation failed.'],
  ])('normalizes lazy Worker factory failures %#', async (failure, message) => {
    const pool = createAudioTranscoderWorkerPool({
      workerFactory() {
        throw failure;
      },
    });

    await expect(pool.decode({ data: new ArrayBuffer(1) })).rejects.toMatchObject({
      code: 'WORKER_FAILURE',
      message,
    });
    expect(pool.getQueueSnapshot().terminated).toBe(true);
  });

  it('preserves engine errors when the native Worker is unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    const pool = createAudioTranscoderWorkerPool();

    await expect(pool.decode({ data: new ArrayBuffer(1) })).rejects.toMatchObject({
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
  options: {
    readonly concurrency?: number;
    readonly idleTimeoutMs?: number | null;
    readonly maxQueued?: number;
    readonly maxQueuedBytes?: number;
  } = {},
) {
  const created: CreatedWorker[] = [];
  const pool = createAudioTranscoderWorkerPool({
    ...options,
    workerFactory(index) {
      const worker = new WorkerStub();
      created.push({ index, worker });
      return worker as unknown as Worker;
    },
  });
  return { created, pool };
}

interface WorkerPost {
  readonly message: AudioWorkerRequest;
  readonly transfer: readonly Transferable[];
}

class WorkerStub {
  readonly posts: WorkerPost[] = [];
  readonly listeners = {
    error: [] as ((event: ErrorEvent) => void)[],
    message: [] as ((event: MessageEvent<AudioWorkerResponse>) => void)[],
    messageerror: [] as (() => void)[],
  };
  terminateCalls = 0;

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') {
      this.listeners.message.push(
        listener as unknown as (event: MessageEvent<AudioWorkerResponse>) => void,
      );
    } else if (type === 'error') {
      this.listeners.error.push(listener as unknown as (event: ErrorEvent) => void);
    } else {
      this.listeners.messageerror.push(listener as unknown as () => void);
    }
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type === 'message') {
      this.listeners.message.splice(
        this.listeners.message.indexOf(
          listener as unknown as (event: MessageEvent<AudioWorkerResponse>) => void,
        ),
        1,
      );
    } else if (type === 'error') {
      this.listeners.error.splice(
        this.listeners.error.indexOf(
          listener as unknown as (event: ErrorEvent) => void,
        ),
        1,
      );
    } else {
      this.listeners.messageerror.splice(
        this.listeners.messageerror.indexOf(listener as unknown as () => void),
        1,
      );
    }
  }

  emitError(message: string): void {
    for (const listener of this.listeners.error) {
      listener({ message } as ErrorEvent);
    }
  }

  emitMessage(message: AudioWorkerResponse): void {
    for (const listener of this.listeners.message) {
      listener({ data: message } as MessageEvent<AudioWorkerResponse>);
    }
  }

  postMessage(message: AudioWorkerRequest, transfer: Transferable[] = []): void {
    this.posts.push({ message, transfer });
  }

  terminate(): void {
    this.terminateCalls += 1;
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function createManualAbortSignal(): {
  abort(reason: unknown): void;
  invokeDetachedListener(): void;
  readonly signal: AbortSignal;
} {
  let aborted = false;
  let listener: (() => void) | undefined;
  let reason: unknown;
  const signal = {
    addEventListener(
      _type: string,
      value: EventListenerOrEventListenerObject,
    ): void {
      listener =
        typeof value === 'function'
          ? () => value({} as Event)
          : () => value.handleEvent({} as Event);
    },
    get aborted() {
      return aborted;
    },
    removeEventListener: vi.fn(),
    get reason() {
      return reason;
    },
  } as unknown as AbortSignal;

  return {
    abort(nextReason): void {
      aborted = true;
      reason = nextReason;
      listener?.();
    },
    invokeDetachedListener(): void {
      listener?.();
    },
    signal,
  };
}

function fakeTransferableBuffer(byteLength: number): ArrayBuffer {
  const buffer = Object.create(ArrayBuffer.prototype) as ArrayBuffer;
  Object.defineProperty(buffer, 'byteLength', { value: byteLength });
  return buffer;
}
