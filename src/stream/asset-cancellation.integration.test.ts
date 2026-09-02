import { describe, expect, it, vi } from 'vitest';

import { createOperationAbortedError } from '../engine/operation-errors.js';
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from './capabilities.js';
import type {
  AudioStreamInput,
  AudioStreamInspection,
  AudioStreamOutputChunk,
} from './contracts.js';
import { createAudioTranscoderStreamWorkerEngine } from './client.js';
import { createAudioTranscoderStreamEngine } from './engine.js';
import { createStreamWorkerMessageHandler } from './host.js';
import { createAudioTranscoderStreamWorkerPool } from './pool.js';
import type {
  AudioStreamWorkerRequest,
  AudioStreamWorkerResponse,
} from './protocol.js';
import { createDefaultAudioTranscoderStreamCodecRuntime } from './runtime/default.js';
import type {
  AudioStreamEncoder,
  AudioStreamInputAdapter,
  AudioTranscoderStreamCodecRuntime,
} from './runtime/contracts.js';

const INPUT: AudioStreamInput = {
  blob: new Blob([new Uint8Array([1])]),
  name: 'source.test',
};
const INSPECTION: AudioStreamInspection = Object.freeze({
  bitDepth: 32,
  channels: 1,
  codec: 'test-f32',
  container: 'test',
  decodeSupport: 'built-in',
  durationSeconds: 1 / 48_000,
  notes: Object.freeze([]),
  sampleRate: 48_000,
  size: 1,
});
const TARGET = { presetId: 'ogg-opus-128kbps' as const };

describe('runtime asset cancellation across public stream boundaries', () => {
  it('cancels a direct transcode with a never-settling Ogg loader', async () => {
    const harness = createNeverLoadingRuntime();
    const engine = createAudioTranscoderStreamEngine({
      codecRuntime: harness.runtime,
    });
    const controller = new AbortController();
    const destination = createDestination();

    const pending = engine.transcode(
      INPUT,
      TARGET,
      destination.stream,
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(harness.loaderSignals).toHaveLength(1));
    controller.abort('direct load stopped');

    await expect(pending).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'direct load stopped',
    });
    expect(harness.loaderSignals[0]?.aborted).toBe(true);
    expect(destination.abort).toHaveBeenCalledOnce();
    expect(destination.abort.mock.calls[0]?.[0]).toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'direct load stopped',
    });
    expect(destination.stream.locked).toBe(false);
  });

  it('hard-retires a Worker with a never-settling asset load and aborts its bridged output', async () => {
    const runtime = createNeverLoadingRuntime();
    const worker = new LoopbackWorker(runtime.runtime);
    const engine = createAudioTranscoderStreamWorkerEngine({
      capabilities: AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      runtime: 'custom',
      workerFactory: () => worker as unknown as Worker,
    });
    const controller = new AbortController();
    const destination = createDestination();

    const pending = engine.transcode(
      INPUT,
      TARGET,
      destination.stream,
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(runtime.loaderSignals).toHaveLength(1));
    controller.abort('Worker load stopped');

    await expect(pending).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'Worker load stopped',
    });
    expect(destination.abort).toHaveBeenCalledOnce();
    expect(destination.stream.locked).toBe(false);
    expect(worker.terminateCalls).toBe(1);
    await engine.dispose();
  });

  it('hard-retires a Worker with a never-settling generic encoder startup', async () => {
    const runtime = createNeverStartingRuntime();
    const worker = new LoopbackWorker(runtime.runtime);
    const engine = createAudioTranscoderStreamWorkerEngine({
      capabilities: AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      runtime: 'custom',
      workerFactory: () => worker as unknown as Worker,
    });
    const controller = new AbortController();
    const destination = createDestination();

    const pending = engine.transcode(
      INPUT,
      TARGET,
      destination.stream,
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce());
    controller.abort('Worker encoder startup stopped');

    await expect(pending).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'Worker encoder startup stopped',
    });
    expect(destination.abort).toHaveBeenCalledOnce();
    expect(destination.stream.locked).toBe(false);
    expect(worker.terminateCalls).toBe(1);
    expect(runtime.cancel).not.toHaveBeenCalled();

    // This loopback cannot actually destroy its in-process host. Let the late
    // startup settle so the abandoned host path can prove its own cleanup is
    // observed; a real Worker has already been destroyed above.
    runtime.startup.reject(new Error('late encoder startup failure'));
    await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledOnce());
    runtime.cancellation.reject(new Error('late encoder cancel failure'));
    await engine.dispose();
    expect(worker.terminateCalls).toBe(1);
  });

  it('retires the canceled pool Worker before admitting recovery work', async () => {
    const workers: LoopbackWorker[] = [];
    const runtimes: ReturnType<typeof createNeverLoadingRuntime>[] = [];
    const pool = createAudioTranscoderStreamWorkerPool({
      capabilities: AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      concurrency: 1,
      idleTimeoutMs: null,
      runtime: 'custom',
      workerFactory: () => {
        const runtime = createNeverLoadingRuntime();
        const worker = new LoopbackWorker(runtime.runtime);
        runtimes.push(runtime);
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const controller = new AbortController();
    const destination = createDestination();

    const pending = pool.transcode(
      INPUT,
      TARGET,
      destination.stream,
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(runtimes[0]?.loaderSignals).toHaveLength(1));
    controller.abort('pool load stopped');

    await expect(pending).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'pool load stopped',
    });
    expect(destination.abort).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(workers[0]?.terminateCalls).toBe(1));
    expect(pool.getQueueSnapshot()).toMatchObject({ active: 0, workers: 0 });

    await expect(pool.inspect(INPUT)).resolves.toMatchObject(INSPECTION);
    expect(workers).toHaveLength(2);
    await pool.dispose();
  });
});

function createNeverLoadingRuntime(): {
  readonly loaderSignals: AbortSignal[];
  readonly runtime: AudioTranscoderStreamCodecRuntime;
} {
  const loaderSignals: AbortSignal[] = [];
  const packageRuntime = createDefaultAudioTranscoderStreamCodecRuntime({
    load(assetName, signal) {
      if (assetName !== 'ogg-opus') {
        return Promise.reject(new Error(`Unexpected asset: ${assetName}`));
      }
      if (signal !== undefined) loaderSignals.push(signal);
      return new Promise<Uint8Array<ArrayBuffer>>(() => undefined);
    },
  });
  const input = Object.freeze<AudioStreamInputAdapter>({
    id: 'test-input',
    async inspect() {
      return INSPECTION;
    },
    async open() {
      return {
        channels: 1,
        async *chunks(signal?: AbortSignal) {
          if (signal?.aborted) throw createOperationAbortedError(signal);
          yield new Float32Array([0]);
        },
        close(): void {},
        durationSeconds: INSPECTION.durationSeconds,
        inspection: INSPECTION,
        sampleRate: 48_000,
        totalFrames: 1,
      };
    },
  });
  return {
    loaderSignals,
    runtime: Object.freeze({
      ...packageRuntime,
      inputs: Object.freeze([input]),
    }),
  };
}

function createNeverStartingRuntime(): {
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly cancellation: ReturnType<typeof deferred<void>>;
  readonly runtime: AudioTranscoderStreamCodecRuntime;
  readonly start: ReturnType<typeof vi.fn>;
  readonly startup: ReturnType<typeof deferred<void>>;
} {
  const startup = deferred<void>();
  const cancellation = deferred<void>();
  const start = vi.fn(() => startup.promise);
  const cancel = vi.fn(() => cancellation.promise);
  const encoder = Object.freeze({
    id: 'never-starting-encoder',
    async create(): Promise<AudioStreamEncoder> {
      return {
        cancel,
        async finalize() {},
        getBytesWritten: () => 0,
        start,
        async write() {},
      };
    },
  });
  const packageRuntime = createDefaultAudioTranscoderStreamCodecRuntime({
    load(assetName) {
      return Promise.reject(new Error(`Unexpected asset: ${assetName}`));
    },
  });

  return {
    cancel,
    cancellation,
    runtime: Object.freeze({
      ...packageRuntime,
      encoder,
      inputs: Object.freeze([createTestInputAdapter()]),
    }),
    start,
    startup,
  };
}

function createTestInputAdapter(): AudioStreamInputAdapter {
  return Object.freeze({
    id: 'test-input',
    async inspect() {
      return INSPECTION;
    },
    async open() {
      return {
        channels: 1,
        async *chunks(signal?: AbortSignal) {
          if (signal?.aborted) throw createOperationAbortedError(signal);
          yield new Float32Array([0]);
        },
        close(): void {},
        durationSeconds: INSPECTION.durationSeconds,
        inspection: INSPECTION,
        sampleRate: 48_000,
        totalFrames: 1,
      };
    },
  });
}

function createDestination(): {
  readonly abort: ReturnType<typeof vi.fn>;
  readonly stream: WritableStream<AudioStreamOutputChunk>;
} {
  const abort = vi.fn();
  return {
    abort,
    stream: new WritableStream<AudioStreamOutputChunk>({ abort }),
  };
}

class LoopbackWorker {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly handle: (
    event: MessageEvent<AudioStreamWorkerRequest>,
  ) => void;
  terminateCalls = 0;

  constructor(runtime: AudioTranscoderStreamCodecRuntime) {
    const engine = createAudioTranscoderStreamEngine({ codecRuntime: runtime });
    this.handle = createStreamWorkerMessageHandler({
      engine,
      postMessage: (message) => this.emitMessage(message),
    });
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message: AudioStreamWorkerRequest): void {
    queueMicrotask(() => {
      if (this.terminateCalls === 0) {
        this.handle({ data: message } as MessageEvent<AudioStreamWorkerRequest>);
      }
    });
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  private emitMessage(message: AudioStreamWorkerResponse): void {
    queueMicrotask(() => {
      if (this.terminateCalls !== 0) return;
      const event = new MessageEvent('message', { data: message });
      for (const listener of this.listeners.get('message') ?? []) {
        listener.call(this, event);
      }
    });
  }
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
