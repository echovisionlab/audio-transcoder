import type {
  AudioInput,
  AudioInspection,
  AudioOperationOptions,
  AudioTranscoderCapabilities,
  AudioTranscoderEngineInfo,
  AudioTranscoderWorkerEngine,
  DecodedAudio,
  EncodedAudio,
  PcmAudio,
} from '../engine/contracts.js';
import { createAudioTranscoderEngine } from '../engine/factory.js';
import {
  AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES,
  getUniquePcmBufferByteLength,
} from '../engine/buffer-policy.js';
import {
  createOperationAbortedError,
  createWorkerTerminatedError,
} from '../engine/operation-errors.js';
import { AudioTranscoderError } from '../errors.js';
import { createAudioTranscoderWorkerEngine } from './client.js';

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_QUEUED = 8;
const MAX_CONCURRENCY = 4;
const MAX_QUEUED = 64;

/** Current bounded-queue and Worker allocation counts. */
export interface AudioTranscoderQueueSnapshot {
  readonly active: number;
  readonly concurrency: number;
  /** Configured waiting limit from 0 to 64; active operations are excluded. */
  readonly maxQueued: number;
  /** Configured aggregate byte limit for waiting operations. */
  readonly maxQueuedBytes: number;
  readonly queued: number;
  /** Bytes retained by waiting operations; active operations are excluded. */
  readonly queuedBytes: number;
  readonly terminated: boolean;
  readonly workers: number;
}

export interface AudioTranscoderPoolScheduleOptions {
  /** Cancels queued work. Running work must also receive this signal. */
  readonly signal?: AbortSignal;
}

/** A FIFO, concurrency-limited facade over lazily created Worker engines. */
export interface AudioTranscoderWorkerPool extends AudioTranscoderWorkerEngine {
  getQueueSnapshot(): AudioTranscoderQueueSnapshot;

  /**
   * Defers arbitrary work until a Worker slot is available. Use this to delay
   * `File.arrayBuffer()` and avoid retaining every input buffer in the queue.
   * The callback must pass `options.signal` to its running engine operation.
   * Captures owned by arbitrary callbacks cannot be included in `queuedBytes`.
   */
  schedule<T>(
    operation: (engine: AudioTranscoderWorkerEngine) => Promise<T>,
    options?: AudioTranscoderPoolScheduleOptions,
  ): Promise<T>;
}

export interface CreateAudioTranscoderWorkerPoolOptions {
  /**
   * Maximum simultaneous whole-buffer operations and Workers, from 1 to 4.
   * Defaults to 1; raise it only after measuring peak memory on target devices.
   */
  readonly concurrency?: number;

  /**
   * Releases idle Workers after this delay and recreates them on demand.
   * Defaults to 30 seconds. Use `null` to keep idle Workers alive.
   */
  readonly idleTimeoutMs?: number | null;

  /**
   * Maximum operations waiting for a Worker slot. Defaults to 8. Active
   * operations are excluded. Must be an integer from 0 to 64; use 0 to reject
   * whenever every slot is busy.
   */
  readonly maxQueued?: number;

  /**
   * Maximum bytes retained by operations waiting for a Worker slot. Defaults
   * to the 64 MiB whole-buffer safety limit. Active operations are excluded.
   * `unsafeAllowLargeBuffers` does not bypass this aggregate limit.
   */
  readonly maxQueuedBytes?: number;

  /**
   * Creates each Worker for custom entry URLs or CSP handling. The index is
   * stable from 0 to concurrency - 1.
   */
  readonly workerFactory?: (workerIndex: number) => Worker;
}

interface QueuedOperation {
  detachQueuedAbort: (() => void) | undefined;
  execute:
    | ((engine: AudioTranscoderWorkerEngine) => Promise<unknown>)
    | undefined;
  reject: ((reason: unknown) => void) | undefined;
  resolve: ((value: unknown) => void) | undefined;
  queuedBytes: number;
}

interface WorkerSlot {
  active: boolean;
  engine: AudioTranscoderWorkerEngine | undefined;
  readonly index: number;
  operation: QueuedOperation | undefined;
}

/**
 * Creates a bounded FIFO queue backed by up to `concurrency` module Workers.
 * Workers are lazy and are released after the configured idle timeout.
 */
export function createAudioTranscoderWorkerPool(
  options: CreateAudioTranscoderWorkerPoolOptions = {},
): AudioTranscoderWorkerPool {
  const concurrency = validateConcurrency(options.concurrency);
  const idleTimeoutMs = validateIdleTimeout(options.idleTimeoutMs);
  const maxQueued = validateMaxQueued(options.maxQueued);
  const maxQueuedBytes = validateMaxQueuedBytes(options.maxQueuedBytes);
  const slots = createWorkerSlots(concurrency);
  const queue: QueuedOperation[] = [];
  const localEngine = createAudioTranscoderEngine();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let queuedBytes = 0;
  let terminated = false;

  const clearIdleRelease = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const releaseIdleWorkers = (): void => {
    idleTimer = undefined;
    for (const slot of slots) {
      slot.engine?.terminate();
      slot.engine = undefined;
    }
  };

  const scheduleIdleRelease = (): void => {
    if (
      terminated ||
      idleTimeoutMs === null ||
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
      idleTimer as ReturnType<typeof setTimeout> & {
        unref?: () => void;
      }
    ).unref?.();
  };

  const getQueueSnapshot = (): AudioTranscoderQueueSnapshot =>
    Object.freeze({
      active: slots.filter(({ active }) => active).length,
      concurrency,
      maxQueued,
      maxQueuedBytes,
      queued: queue.length,
      queuedBytes,
      terminated,
      workers: slots.filter(({ engine }) => engine !== undefined).length,
    });

  const detachQueuedAbort = (operation: QueuedOperation): void => {
    operation.detachQueuedAbort?.();
    operation.detachQueuedAbort = undefined;
  };

  const releaseOperation = (operation: QueuedOperation): void => {
    releaseQueuedBytes(operation);
    detachQueuedAbort(operation);
    operation.execute = undefined;
    operation.reject = undefined;
    operation.resolve = undefined;
  };

  const releaseQueuedBytes = (operation: QueuedOperation): void => {
    if (operation.queuedBytes === 0) {
      return;
    }
    queuedBytes -= operation.queuedBytes;
    operation.queuedBytes = 0;
  };

  const rejectOperation = (
    operation: QueuedOperation,
    reason: unknown,
  ): void => {
    const reject = operation.reject!;
    releaseOperation(operation);
    reject(reason);
  };

  const resolveOperation = (
    operation: QueuedOperation,
    value: unknown,
  ): void => {
    const resolve = operation.resolve!;
    releaseOperation(operation);
    resolve(value);
  };

  const shutdown = (error: AudioTranscoderError): void => {
    if (terminated) {
      return;
    }
    terminated = true;
    clearIdleRelease();

    for (const operation of queue.splice(0)) {
      rejectOperation(operation, error);
    }
    for (const slot of slots) {
      const operation = slot.operation;
      slot.operation = undefined;
      slot.active = false;
      if (operation !== undefined) {
        rejectOperation(operation, error);
      }
      slot.engine?.terminate();
      slot.engine = undefined;
    }
  };

  const createSlotEngine = (slot: WorkerSlot): AudioTranscoderWorkerEngine => {
    const workerFactory = options.workerFactory;
    const engine = createAudioTranscoderWorkerEngine(
      workerFactory === undefined
        ? { maxQueued: 0, maxQueuedBytes: 0 }
        : {
            maxQueued: 0,
            maxQueuedBytes: 0,
            workerFactory: () => workerFactory(slot.index),
          },
    );
    slot.engine = engine;
    return engine;
  };

  const drain = (): void => {
    for (const slot of slots) {
      if (slot.active) {
        continue;
      }
      const operation = queue.shift();
      if (operation === undefined) {
        scheduleIdleRelease();
        return;
      }

      releaseQueuedBytes(operation);
      detachQueuedAbort(operation);
      const execute = operation.execute!;
      operation.execute = undefined;
      clearIdleRelease();

      let engine: AudioTranscoderWorkerEngine;
      try {
        engine = slot.engine ?? createSlotEngine(slot);
      } catch (error) {
        const workerError = normalizeWorkerFailure(error);
        rejectOperation(operation, workerError);
        shutdown(workerError);
        return;
      }

      slot.active = true;
      slot.operation = operation;
      let result: Promise<unknown>;
      try {
        result = execute(engine);
      } catch (error) {
        settleRejected(slot, operation, error);
        continue;
      }

      void result.then(
        (value) => {
          if (slot.operation !== operation) {
            return;
          }
          slot.active = false;
          slot.operation = undefined;
          resolveOperation(operation, value);
          drain();
        },
        (error: unknown) => {
          settleRejected(slot, operation, error);
        },
      );
    }
  };

  const enqueue = <T>(
    createExecute: () => (
      engine: AudioTranscoderWorkerEngine,
    ) => Promise<T>,
    signal: AbortSignal | undefined,
    getRetainedBytes: () => number,
  ): Promise<T> => {
    if (terminated) {
      return Promise.reject(createWorkerTerminatedError());
    }
    if (signal?.aborted) {
      return Promise.reject(createOperationAbortedError(signal));
    }
    const waitsForSlot = !slots.some(({ active }) => !active);
    if (waitsForSlot && queue.length >= maxQueued) {
      return Promise.reject(createQueueCapacityExceededError(maxQueued));
    }

    let retainedBytes: number;
    try {
      retainedBytes = getRetainedBytes();
    } catch (error) {
      return Promise.reject(error);
    }
    if (
      waitsForSlot &&
      exceedsQueuedByteLimit(queuedBytes, retainedBytes, maxQueuedBytes)
    ) {
      return Promise.reject(
        createQueueBytesExceededError(
          maxQueuedBytes,
          queuedBytes,
          retainedBytes,
        ),
      );
    }

    const queuedReservation = waitsForSlot ? retainedBytes : 0;
    queuedBytes += queuedReservation;

    let execute: (engine: AudioTranscoderWorkerEngine) => Promise<T>;
    try {
      execute = createExecute();
    } catch (error) {
      queuedBytes -= queuedReservation;
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      const operation: QueuedOperation = {
        detachQueuedAbort: undefined,
        execute,
        queuedBytes: queuedReservation,
        reject,
        resolve: (value) => resolve(value as T),
      };

      try {
        if (signal !== undefined) {
          const abort = (): void => {
            const queueIndex = queue.indexOf(operation);
            if (queueIndex === -1) {
              return;
            }
            queue.splice(queueIndex, 1);
            rejectOperation(operation, createOperationAbortedError(signal));
            scheduleIdleRelease();
          };
          signal.addEventListener('abort', abort, { once: true });
          operation.detachQueuedAbort = () =>
            signal.removeEventListener('abort', abort);
        }
      } catch (error) {
        rejectOperation(operation, error);
        return;
      }

      clearIdleRelease();
      queue.push(operation);
      drain();
    });
  };

  const schedule = <T>(
    operation: (engine: AudioTranscoderWorkerEngine) => Promise<T>,
    scheduleOptions: AudioTranscoderPoolScheduleOptions = {},
  ): Promise<T> => enqueue(() => operation, scheduleOptions.signal, () => 0);

  return {
    decode(
      input: AudioInput,
      operationOptions: AudioOperationOptions = {},
    ): Promise<DecodedAudio> {
      return enqueue(
        () => {
          const inputSnapshot = snapshotAudioInput(input);
          const optionsSnapshot = snapshotOperationOptions(operationOptions);
          return (engine) => engine.decode(inputSnapshot, optionsSnapshot);
        },
        operationOptions.signal,
        () => getAudioInputRetainedBytes(input),
      );
    },
    encode(
      audio: PcmAudio,
      presetId: string,
      operationOptions: AudioOperationOptions = {},
    ): Promise<EncodedAudio> {
      return enqueue(
        () => {
          const audioSnapshot = snapshotPcmAudio(audio);
          const optionsSnapshot = snapshotOperationOptions(operationOptions);
          return (engine) =>
            engine.encode(audioSnapshot, presetId, optionsSnapshot);
        },
        operationOptions.signal,
        () => getUniquePcmBufferByteLength(audio.channelData),
      );
    },
    getCapabilities(): AudioTranscoderCapabilities {
      return localEngine.getCapabilities();
    },
    getInfo(): AudioTranscoderEngineInfo {
      return localEngine.getInfo();
    },
    getQueueSnapshot,
    getVersion(): string {
      return localEngine.getVersion();
    },
    inspect(input: AudioInput): AudioInspection {
      return localEngine.inspect(input);
    },
    schedule,
    terminate(): void {
      shutdown(createWorkerTerminatedError());
    },
    transcode(
      input: AudioInput,
      presetId: string,
      operationOptions: AudioOperationOptions = {},
    ): Promise<EncodedAudio> {
      return enqueue(
        () => {
          const inputSnapshot = snapshotAudioInput(input);
          const optionsSnapshot = snapshotOperationOptions(operationOptions);
          return (engine) =>
            engine.transcode(inputSnapshot, presetId, optionsSnapshot);
        },
        operationOptions.signal,
        () => getAudioInputRetainedBytes(input),
      );
    },
  };

  function settleRejected(
    slot: WorkerSlot,
    operation: QueuedOperation,
    error: unknown,
  ): void {
    if (slot.operation !== operation) {
      return;
    }
    slot.active = false;
    slot.operation = undefined;
    rejectOperation(operation, error);
    if (isFatalWorkerError(error)) {
      shutdown(error);
    } else {
      drain();
    }
  }
}

function validateConcurrency(concurrency: number | undefined): number {
  const resolved = concurrency === undefined ? 1 : concurrency;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_CONCURRENCY
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      `Worker pool concurrency must be an integer from 1 to ${MAX_CONCURRENCY}.`,
    );
  }
  return resolved;
}

function validateMaxQueued(maxQueued: number | undefined): number {
  const resolved =
    maxQueued === undefined ? DEFAULT_MAX_QUEUED : maxQueued;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 0 ||
    resolved > MAX_QUEUED
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      `Worker pool maxQueued must be an integer from 0 to ${MAX_QUEUED}.`,
    );
  }
  return resolved;
}

function validateMaxQueuedBytes(maxQueuedBytes: number | undefined): number {
  const resolved =
    maxQueuedBytes === undefined
      ? AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES
      : maxQueuedBytes;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Worker pool maxQueuedBytes must be a non-negative safe integer.',
    );
  }
  return resolved;
}

function createQueueCapacityExceededError(
  maxQueued: number,
): AudioTranscoderError {
  return new AudioTranscoderError(
    'QUEUE_CAPACITY_EXCEEDED',
    `Audio transcoder Worker pool queue is full (maxQueued: ${maxQueued}; active operations excluded).`,
  );
}

function createQueueBytesExceededError(
  maxQueuedBytes: number,
  queuedBytes: number,
  retainedBytes: number,
): AudioTranscoderError {
  return new AudioTranscoderError(
    'RESOURCE_LIMIT_EXCEEDED',
    `Audio transcoder Worker pool waiting queue exceeds maxQueuedBytes (${maxQueuedBytes} bytes; queued: ${queuedBytes} bytes; requested: ${formatRetainedBytes(retainedBytes)}; active operations excluded).`,
  );
}

function exceedsQueuedByteLimit(
  queuedBytes: number,
  retainedBytes: number,
  maxQueuedBytes: number,
): boolean {
  return (
    !Number.isSafeInteger(retainedBytes) ||
    retainedBytes < 0 ||
    retainedBytes > maxQueuedBytes - queuedBytes
  );
}

function formatRetainedBytes(retainedBytes: number): string {
  return Number.isSafeInteger(retainedBytes) && retainedBytes >= 0
    ? `${retainedBytes} bytes`
    : 'an unsafe size';
}

function getAudioInputRetainedBytes(input: AudioInput): number {
  return input.data.byteLength;
}

function snapshotAudioInput(input: AudioInput): AudioInput {
  return Object.freeze({ ...input });
}

function snapshotOperationOptions(
  options: AudioOperationOptions,
): AudioOperationOptions {
  return Object.freeze({ ...options });
}

function snapshotPcmAudio(audio: PcmAudio): PcmAudio {
  return Object.freeze({
    channelData: Object.freeze([...audio.channelData]),
    sampleRate: audio.sampleRate,
  });
}

function validateIdleTimeout(
  idleTimeoutMs: number | null | undefined,
): number | null {
  const resolved =
    idleTimeoutMs === undefined ? DEFAULT_IDLE_TIMEOUT_MS : idleTimeoutMs;
  if (
    resolved !== null &&
    (!Number.isSafeInteger(resolved) || resolved < 0)
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Worker pool idleTimeoutMs must be null or a non-negative safe integer.',
    );
  }
  return resolved;
}

function createWorkerSlots(concurrency: number): WorkerSlot[] {
  return Array.from({ length: concurrency }, (_value, index) => ({
    active: false,
    engine: undefined,
    index,
    operation: undefined,
  }));
}

function isFatalWorkerError(error: unknown): error is AudioTranscoderError {
  return (
    error instanceof AudioTranscoderError &&
    (error.code === 'WORKER_FAILURE' || error.code === 'WORKER_TERMINATED')
  );
}

function normalizeWorkerFailure(error: unknown): AudioTranscoderError {
  if (error instanceof AudioTranscoderError) {
    return error;
  }
  const message =
    error instanceof Error ? error.message : 'Audio Worker creation failed.';
  return new AudioTranscoderError('WORKER_FAILURE', message);
}
