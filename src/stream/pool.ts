import type {
  AudioStreamInput,
  AudioStreamInputSupportResult,
  AudioStreamInspection,
  AudioStreamOperationOptions,
  AudioStreamOutput,
  AudioStreamOutputProbeOptions,
  AudioStreamOutputProbeTarget,
  AudioStreamOutputSupportResult,
  AudioStreamTarget,
  AudioStreamTranscodeResult,
  AudioTranscoderStreamWorkerEngine,
  AudioTranscoderStreamWorkerRuntimeOptions,
} from './contracts.js';
import {
  createAudioTranscoderStreamWorkerEngine,
  resolveAudioTranscoderStreamWorkerRuntime,
} from './client.js';
import {
  createOperationAbortedError,
  createWorkerTerminatedError,
} from '../engine/operation-errors.js';
import type { AudioTranscoderEngineInfo } from '../engine/contracts.js';
import { AudioTranscoderError } from '../errors.js';
import { packageEngineInfo } from '../package-metadata.js';
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from './capabilities.js';
import type { AudioTranscoderStreamCapabilities } from './capabilities.js';
import {
  createAudioStreamOutputProbeCoordinator,
  probeAudioStreamOutputSupport,
} from './output-support-probe.js';

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export interface AudioTranscoderStreamQueueSnapshot {
  readonly active: number;
  readonly concurrency: number;
  readonly maxQueued: number;
  readonly queued: number;
  readonly terminated: boolean;
  readonly workers: number;
}

export interface AudioTranscoderStreamPoolScheduleOptions {
  /** Cancels queued work. Running work must also receive and propagate it. */
  readonly signal?: AbortSignal;
}

export interface AudioTranscoderStreamWorkerPool
  extends AudioTranscoderStreamWorkerEngine {
  getQueueSnapshot(): AudioTranscoderStreamQueueSnapshot;

  /**
   * Runs only after a Worker slot is available. Open the destination file in
   * this callback so queued jobs do not retain writable file streams. A running
   * `OPERATION_ABORTED` rejection retires that Worker before the slot is reused;
   * clean up locally, then propagate that error from the callback.
   */
  schedule<T>(
    operation: (engine: AudioTranscoderStreamWorkerEngine) => Promise<T>,
    options?: AudioTranscoderStreamPoolScheduleOptions,
  ): Promise<T>;
}

interface AudioTranscoderStreamWorkerPoolCommonOptions {
  /** Maximum active files. Defaults to 1 for a predictable memory ceiling. */
  readonly concurrency?: number;
  /** Defaults to 30 seconds. Set to `null` to retain idle Workers. */
  readonly idleTimeoutMs?: number | null;
  /** Waiting jobs retained after active slots. Defaults to 8; maximum 64. */
  readonly maxQueued?: number;
}

/**
 * Pool slots are homogeneous. For `runtime: 'custom'`, every indexed Worker
 * factory result must implement the one declared capability manifest.
 */
export type CreateAudioTranscoderStreamWorkerPoolOptions =
  AudioTranscoderStreamWorkerPoolCommonOptions &
    AudioTranscoderStreamWorkerRuntimeOptions<
      (workerIndex: number) => Worker
    >;

interface QueuedOperation {
  detachQueuedAbort: (() => void) | undefined;
  execute:
    | ((engine: AudioTranscoderStreamWorkerEngine) => Promise<unknown>)
    | undefined;
  queuedOutputCleanup: ((reason: unknown) => Promise<void>) | undefined;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: unknown) => void;
  signal: AbortSignal | undefined;
}

interface WorkerSlot {
  active: boolean;
  engine: AudioTranscoderStreamWorkerEngine | undefined;
  readonly index: number;
  operation: QueuedOperation | undefined;
}

export function createAudioTranscoderStreamWorkerPool(
  options: CreateAudioTranscoderStreamWorkerPoolOptions,
): AudioTranscoderStreamWorkerPool {
  const runtime = resolveAudioTranscoderStreamWorkerRuntime(options);
  const capabilities = runtime.capabilities;
  const concurrency = validateConcurrency(options.concurrency ?? 1, capabilities);
  const idleTimeoutMs = validateIdleTimeout(options.idleTimeoutMs);
  const maxQueued = validateMaxQueued(options.maxQueued, capabilities);
  const slots: WorkerSlot[] = Array.from(
    { length: concurrency },
    (_value, index): WorkerSlot => ({
      active: false,
      engine: undefined,
      index,
      operation: undefined,
    }),
  );
  const queue: QueuedOperation[] = [];
  const outputProbeCoordinator = createAudioStreamOutputProbeCoordinator();
  const pendingQueuedSettlements = new Set<Promise<void>>();
  const pendingWorkerDisposals = new Set<Promise<void>>();
  let disposal: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let outputProbeCallers = 0;
  let terminated = false;

  const clearIdleRelease = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const disposeWorkerEngine = (
    engine: AudioTranscoderStreamWorkerEngine,
  ): Promise<void> => {
    let pending!: Promise<void>;
    pending = (async () => {
      try {
        await engine.dispose();
      } finally {
        pendingWorkerDisposals.delete(pending);
      }
    })();
    pendingWorkerDisposals.add(pending);
    return pending;
  };

  const releaseIdleWorkers = (): void => {
    idleTimer = undefined;
    for (const slot of slots) {
      if (slot.engine !== undefined) {
        void disposeWorkerEngine(slot.engine);
      }
      slot.engine = undefined;
    }
    outputProbeCoordinator.clear();
  };

  const scheduleIdleRelease = (): void => {
    if (
      terminated ||
      idleTimeoutMs === null ||
      outputProbeCallers > 0 ||
      queue.length > 0 ||
      slots.some(({ active }) => active)
    ) {
      return;
    }
    if (idleTimeoutMs === 0) {
      releaseIdleWorkers();
      return;
    }
    clearIdleRelease();
    idleTimer = setTimeout(releaseIdleWorkers, idleTimeoutMs);
    (
      idleTimer as ReturnType<typeof setTimeout> & { unref?: () => void }
    ).unref?.();
  };

  const rejectQueuedOperation = (
    operation: QueuedOperation,
    error: unknown,
  ): Promise<void> => {
    operation.detachQueuedAbort?.();
    operation.detachQueuedAbort = undefined;
    operation.execute = undefined;
    operation.signal = undefined;
    const cleanup = operation.queuedOutputCleanup;
    operation.queuedOutputCleanup = undefined;
    if (cleanup === undefined) {
      operation.reject(error);
      return Promise.resolve();
    }

    const pending = Promise.resolve()
      .then(() => cleanup(error))
      .catch(() => {
        // The queue failure remains primary when destination cleanup also fails.
      })
      .then(() => operation.reject(error));
    pendingQueuedSettlements.add(pending);
    void pending.then(() => pendingQueuedSettlements.delete(pending));
    return pending;
  };

  const rejectBeforeAdmission = <T>(
    error: unknown,
    cleanup: ((reason: unknown) => Promise<void>) | undefined,
  ): Promise<T> => {
    if (cleanup === undefined) {
      return Promise.reject(error);
    }
    return Promise.resolve()
      .then(() => cleanup(error))
      .catch(() => {
        // The admission error remains primary when destination cleanup fails.
      })
      .then(() => Promise.reject<T>(error));
  };

  const shutdown = (error: AudioTranscoderError): Promise<void> => {
    if (disposal !== undefined) {
      return disposal;
    }
    terminated = true;
    clearIdleRelease();
    outputProbeCoordinator.clear(error);
    for (const operation of queue.splice(0)) {
      void rejectQueuedOperation(operation, error);
    }
    const workerDisposals: Promise<void>[] = [];
    for (const slot of slots) {
      slot.operation?.reject(error);
      slot.operation = undefined;
      slot.active = false;
      if (slot.engine !== undefined) {
        workerDisposals.push(disposeWorkerEngine(slot.engine));
      }
      slot.engine = undefined;
    }
    disposal = Promise.all([
      ...workerDisposals,
      ...pendingWorkerDisposals,
      ...pendingQueuedSettlements,
    ]).then(() => undefined);
    return disposal;
  };

  const createSlotEngine = (
    slot: WorkerSlot,
  ): AudioTranscoderStreamWorkerEngine => {
    const workerFactory = runtime.workerFactory;
    let engine: AudioTranscoderStreamWorkerEngine;
    if (runtime.runtime === 'custom') {
      engine = createAudioTranscoderStreamWorkerEngine({
        capabilities,
        maxQueued: 0,
        runtime: 'custom',
        workerFactory: () => runtime.workerFactory(slot.index),
      });
    } else if (workerFactory === undefined) {
      engine = createAudioTranscoderStreamWorkerEngine({
        codecAssets: {
          ...runtime.codecAssets,
          ...(runtime.onAssetStateChange === undefined
            ? {}
            : { onStateChange: runtime.onAssetStateChange }),
        },
        maxQueued: 0,
      });
    } else {
      engine = createAudioTranscoderStreamWorkerEngine({
        codecAssets: {
          ...runtime.codecAssets,
          ...(runtime.onAssetStateChange === undefined
            ? {}
            : { onStateChange: runtime.onAssetStateChange }),
        },
        maxQueued: 0,
        workerFactory: () => workerFactory(slot.index),
      });
    }
    slot.engine = engine;
    return engine;
  };

  const settleRejected = (
    slot: WorkerSlot,
    operation: QueuedOperation,
    error: unknown,
  ): void => {
    slot.operation = undefined;
    operation.reject(error);
    if (isFatalWorkerError(error)) {
      slot.active = false;
      void shutdown(error);
    } else if (isOperationAbortedError(error) && slot.engine !== undefined) {
      const retiredEngine = slot.engine;
      slot.engine = undefined;
      // The child client has already terminated its stuck Worker. Track any
      // non-cooperative output cleanup for pool disposal without withholding
      // this slot from queued replacement work.
      void disposeWorkerEngine(retiredEngine);
      slot.active = false;
      void Promise.resolve().then(() => {
        if (!terminated) {
          drain();
        }
      });
    } else {
      slot.active = false;
      drain();
    }
  };

  const drain = (): void => {
    if (terminated) {
      return;
    }
    for (const slot of slots) {
      if (slot.active) {
        continue;
      }
      const operation = queue.shift();
      if (operation === undefined) {
        scheduleIdleRelease();
        return;
      }
      operation.detachQueuedAbort?.();
      operation.detachQueuedAbort = undefined;
      const execute = operation.execute!;
      operation.execute = undefined;
      clearIdleRelease();

      let engine: AudioTranscoderStreamWorkerEngine;
      try {
        engine = slot.engine ?? createSlotEngine(slot);
      } catch (error) {
        const workerError = normalizeWorkerFailure(error);
        void rejectQueuedOperation(operation, workerError);
        void shutdown(workerError);
        return;
      }

      const signal = operation.signal;
      if (signal?.aborted) {
        void rejectQueuedOperation(
          operation,
          createOperationAbortedError(signal),
        ).then(() => drain());
        continue;
      }
      operation.signal = undefined;

      slot.active = true;
      slot.operation = operation;
      let result: Promise<unknown>;
      try {
        result = execute(engine);
      } catch (error) {
        slot.active = false;
        slot.operation = undefined;
        const settlement = rejectQueuedOperation(operation, error);
        if (isFatalWorkerError(error)) {
          void shutdown(error);
        } else {
          void settlement.then(() => drain());
        }
        continue;
      }
      operation.queuedOutputCleanup = undefined;
      void result.then(
        (value) => {
          slot.active = false;
          slot.operation = undefined;
          operation.resolve(value);
          drain();
        },
        (error: unknown) => settleRejected(slot, operation, error),
      );
    }
  };

  const enqueue = <T>(
    execute: (engine: AudioTranscoderStreamWorkerEngine) => Promise<T>,
    signal?: AbortSignal,
    queuedOutputCleanup?: (reason: unknown) => Promise<void>,
  ): Promise<T> => {
    if (terminated) {
      return rejectBeforeAdmission(
        createWorkerTerminatedError(),
        queuedOutputCleanup,
      );
    }
    if (signal?.aborted) {
      return rejectBeforeAdmission(
        createOperationAbortedError(signal),
        queuedOutputCleanup,
      );
    }
    if (
      !slots.some(({ active: slotActive }) => !slotActive) &&
      queue.length >= maxQueued
    ) {
      return rejectBeforeAdmission(
        new AudioTranscoderError(
          'QUEUE_CAPACITY_EXCEEDED',
          `Audio stream Worker pool queue is full (maxQueued: ${maxQueued}; active operations excluded).`,
        ),
        queuedOutputCleanup,
      );
    }
    return new Promise<T>((resolve, reject) => {
      const operation: QueuedOperation = {
        detachQueuedAbort: undefined,
        execute,
        queuedOutputCleanup,
        reject,
        resolve: (value) => resolve(value as T),
        signal,
      };
      if (signal !== undefined) {
        const abort = (): void => {
          const queueIndex = queue.indexOf(operation);
          if (queueIndex < 0) {
            return;
          }
          queue.splice(queueIndex, 1);
          void rejectQueuedOperation(
            operation,
            createOperationAbortedError(signal),
          );
          scheduleIdleRelease();
        };
        signal.addEventListener('abort', abort, { once: true });
        operation.detachQueuedAbort = () =>
          signal.removeEventListener('abort', abort);
      }
      clearIdleRelease();
      queue.push(operation);
      drain();
    });
  };

  return {
    dispose(): Promise<void> {
      return shutdown(createWorkerTerminatedError());
    },
    getCapabilities: () => capabilities,
    getInfo(): AudioTranscoderEngineInfo {
      return packageEngineInfo;
    },
    getQueueSnapshot(): AudioTranscoderStreamQueueSnapshot {
      return Object.freeze({
        active: slots.filter(({ active }) => active).length,
        concurrency,
        maxQueued,
        queued: queue.length,
        terminated,
        workers: slots.filter(({ engine }) => engine !== undefined).length,
      });
    },
    getVersion: () => packageEngineInfo.version,
    inspect(
      input: AudioStreamInput,
      operationOptions: AudioStreamOperationOptions = {},
    ): Promise<AudioStreamInspection> {
      return enqueue(
        (engine) => engine.inspect(input, operationOptions),
        operationOptions.signal,
      );
    },
    probeInputSupport(
      input: AudioStreamInput,
      operationOptions: AudioStreamOperationOptions = {},
    ): Promise<AudioStreamInputSupportResult> {
      return enqueue(
        (engine) => engine.probeInputSupport(input, operationOptions),
        operationOptions.signal,
      );
    },
    async probeOutputSupport(
      target: AudioStreamOutputProbeTarget,
      operationOptions: AudioStreamOutputProbeOptions = {},
    ): Promise<AudioStreamOutputSupportResult> {
      if (terminated) {
        throw createWorkerTerminatedError();
      }
      outputProbeCallers += 1;
      try {
        return await probeAudioStreamOutputSupport(
          capabilities,
          outputProbeCoordinator,
          target,
          operationOptions.signal,
          (resolvedTarget, signal) =>
            enqueue(
              (engine) =>
                engine.probeOutputSupport(resolvedTarget, { signal }),
              signal,
            ),
        );
      } finally {
        outputProbeCallers -= 1;
        scheduleIdleRelease();
      }
    },
    schedule<T>(
      operation: (engine: AudioTranscoderStreamWorkerEngine) => Promise<T>,
      scheduleOptions: AudioTranscoderStreamPoolScheduleOptions = {},
    ): Promise<T> {
      return enqueue(operation, scheduleOptions.signal);
    },
    terminate(): void {
      void shutdown(createWorkerTerminatedError());
    },
    transcode(
      input: AudioStreamInput,
      target: AudioStreamTarget,
      output: AudioStreamOutput,
      operationOptions: AudioStreamOperationOptions = {},
    ): Promise<AudioStreamTranscodeResult> {
      return enqueue(
        (engine) => engine.transcode(input, target, output, operationOptions),
        operationOptions.signal,
        (reason) => output.abort(reason),
      );
    },
  };
}

function validateConcurrency(
  concurrency: number,
  capabilities: AudioTranscoderStreamCapabilities,
): number {
  const defaultMaximum =
    AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.maximumConcurrency;
  const maximum = Math.min(
    capabilities.limits.maximumConcurrency ?? defaultMaximum,
    defaultMaximum,
  );
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > maximum
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      `Stream pool concurrency must be an integer from 1 to ${maximum}.`,
    );
  }
  return concurrency;
}

function validateMaxQueued(
  value: number | undefined,
  capabilities: AudioTranscoderStreamCapabilities,
): number {
  const defaultLimits = AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.queue;
  const runtimeLimits = capabilities.limits.queue ?? defaultLimits;
  const maximum = Math.min(
    runtimeLimits.maximumQueued,
    defaultLimits.maximumQueued,
  );
  const resolved = value ?? runtimeLimits.defaultMaximumQueued;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 0 ||
    resolved > maximum
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      `Stream pool maxQueued must be an integer from 0 to ${maximum}.`,
    );
  }
  return resolved;
}

function validateIdleTimeout(value: number | null | undefined): number | null {
  const resolved = value === undefined ? DEFAULT_IDLE_TIMEOUT_MS : value;
  if (
    resolved !== null &&
    (!Number.isSafeInteger(resolved) || resolved < 0)
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Stream pool idleTimeoutMs must be null or a non-negative safe integer.',
    );
  }
  return resolved;
}

function isFatalWorkerError(error: unknown): error is AudioTranscoderError {
  return (
    error instanceof AudioTranscoderError &&
    (error.code === 'WORKER_FAILURE' || error.code === 'WORKER_TERMINATED')
  );
}

function isOperationAbortedError(error: unknown): error is AudioTranscoderError {
  return (
    error instanceof AudioTranscoderError && error.code === 'OPERATION_ABORTED'
  );
}

function normalizeWorkerFailure(error: unknown): AudioTranscoderError {
  if (error instanceof AudioTranscoderError) {
    return error;
  }
  return new AudioTranscoderError(
    'WORKER_FAILURE',
    error instanceof Error ? error.message : 'Audio stream Worker creation failed.',
  );
}
