import type {
  AudioInput,
  AudioInspection,
  AudioOperationOptions,
  AudioTranscoderCapabilities,
  AudioTranscoderEngineInfo,
  AudioTranscoderWorkerEngine,
  CreateAudioTranscoderWorkerEngineOptions,
  DecodedAudio,
  EncodedAudio,
  PcmAudio,
} from '../engine/contracts.js';
import { createAudioTranscoderEngine } from '../engine/factory.js';
import {
  AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES,
  assertWholeBufferInputWithinLimit,
  assertWholeBufferPcmWithinLimit,
  assertWorkerPcmPayloadWithinLimit,
  createWorkerPcmPayloadPlan,
  getUniquePcmBufferByteLength,
} from '../engine/buffer-policy.js';
import type { WorkerPcmPayloadPlan } from '../engine/buffer-policy.js';
import {
  createOperationAbortedError,
  createWorkerTerminatedError,
} from '../engine/operation-errors.js';
import { AudioTranscoderError } from '../errors.js';
import type {
  AudioWorkerRequest,
  AudioWorkerResponse,
} from './protocol.js';
import { deserializeWorkerError } from './serialized-error.js';

const DEFAULT_MAX_QUEUED = 8;
const MAX_QUEUED = 64;

type WorkerResult = DecodedAudio | EncodedAudio;

interface PreparedOperation {
  readonly request: AudioWorkerRequest;
  readonly transfer: Transferable[];
}

interface QueuedOperation {
  abortListener: (() => void) | undefined;
  cancelReason: unknown;
  cancelRequested: boolean;
  readonly id: number;
  onProgress: AudioOperationOptions['onProgress'];
  posted: boolean;
  queuedBytes: number;
  prepare: ((id: number) => PreparedOperation) | undefined;
  reject: ((reason: unknown) => void) | undefined;
  resolve: ((value: WorkerResult) => void) | undefined;
  signal: AbortSignal | undefined;
  validate: (() => void) | undefined;
}

/**
 * Creates one serial module Worker engine. Use a Worker pool when measured
 * workloads justify more than one simultaneous whole-buffer operation.
 */
export function createAudioTranscoderWorkerEngine(
  options: CreateAudioTranscoderWorkerEngineOptions = {},
): AudioTranscoderWorkerEngine {
  const maxQueued = validateMaxQueued(options.maxQueued);
  const maxQueuedBytes = validateMaxQueuedBytes(options.maxQueuedBytes);
  const localEngine = createAudioTranscoderEngine();
  let worker: Worker | undefined = createWorker(options.workerFactory);
  const queue: QueuedOperation[] = [];
  let active: QueuedOperation | undefined;
  let nextOperationId = 1;
  let queuedBytes = 0;
  let terminated = false;

  const detachAbort = (operation: QueuedOperation): void => {
    if (operation.abortListener !== undefined) {
      operation.signal?.removeEventListener('abort', operation.abortListener);
      operation.abortListener = undefined;
    }
  };

  const releaseOperation = (operation: QueuedOperation): void => {
    releaseQueuedBytes(operation);
    detachAbort(operation);
    operation.cancelReason = undefined;
    operation.onProgress = undefined;
    operation.prepare = undefined;
    operation.reject = undefined;
    operation.resolve = undefined;
    operation.signal = undefined;
    operation.validate = undefined;
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
    value: WorkerResult,
  ): void => {
    const resolve = operation.resolve!;
    releaseOperation(operation);
    resolve(value);
  };

  const rejectAll = (error: AudioTranscoderError): void => {
    const operations =
      active === undefined ? queue.splice(0) : [active, ...queue.splice(0)];
    active = undefined;
    for (const operation of operations) {
      rejectOperation(
        operation,
        operation.cancelRequested ? operation.cancelReason : error,
      );
    }
  };

  const cancelActive = (operation: QueuedOperation, reason: unknown): void => {
    if (operation.cancelRequested) {
      return;
    }
    operation.cancelRequested = true;
    operation.cancelReason = reason;
    operation.onProgress = undefined;
    detachAbort(operation);
    try {
      worker!.postMessage({
        id: operation.id,
        type: 'cancel',
      } satisfies AudioWorkerRequest);
    } catch {
      // Terminal Worker cleanup still controls when the next job may start.
    }
  };

  const drain = (): void => {
    if (terminated || active !== undefined) {
      return;
    }
    const operation = queue.shift();
    if (operation === undefined) {
      return;
    }
    releaseQueuedBytes(operation);
    active = operation;
    operation.posted = true;
    try {
      operation.validate!();
      const prepared = operation.prepare!(operation.id);
      operation.validate = undefined;
      operation.prepare = undefined;
      worker!.postMessage(prepared.request, prepared.transfer);
    } catch (error) {
      active = undefined;
      rejectOperation(operation, error);
      drain();
    }
  };

  const handleMessage = (event: MessageEvent<AudioWorkerResponse>): void => {
    const response = event.data;
    const operation = active;
    if (operation === undefined || operation.id !== response.id) {
      return;
    }

    if (response.type === 'progress') {
      if (!operation.cancelRequested) {
        try {
          operation.onProgress?.(Object.freeze({ ...response.progress }));
        } catch (error) {
          cancelActive(operation, error);
        }
      }
      return;
    }

    active = undefined;
    if (operation.cancelRequested) {
      rejectOperation(operation, operation.cancelReason);
    } else if (response.type === 'error') {
      rejectOperation(operation, deserializeWorkerError(response.error));
    } else if (response.operation === 'decode') {
      resolveOperation(operation, freezeDecodedAudio(response.value));
    } else {
      resolveOperation(operation, freezeEncodedAudio(response.value));
    }
    drain();
  };

  const handleError = (event: ErrorEvent): void => {
    failWorker(event.message || 'Audio transcoder worker failed.');
  };

  const handleMessageError = (): void => {
    failWorker('Audio transcoder worker returned an unreadable message.');
  };

  const releaseWorker = (): void => {
    const currentWorker = worker!;
    currentWorker.removeEventListener('message', handleMessage);
    currentWorker.removeEventListener('error', handleError);
    currentWorker.removeEventListener('messageerror', handleMessageError);
    currentWorker.terminate();
    worker = undefined;
  };

  const failWorker = (message: string): void => {
    if (terminated) {
      return;
    }
    terminated = true;
    releaseWorker();
    rejectAll(
      new AudioTranscoderError('WORKER_FAILURE', message),
    );
  };

  worker.addEventListener('message', handleMessage);
  worker.addEventListener('error', handleError);
  worker.addEventListener('messageerror', handleMessageError);

  const getAdmissionError = (
    signal: AbortSignal | undefined,
    retainedBytes = 0,
  ): AudioTranscoderError | undefined => {
    if (terminated) {
      return createWorkerTerminatedError();
    }
    if (signal?.aborted) {
      return createOperationAbortedError(signal);
    }
    if (active !== undefined && queue.length >= maxQueued) {
      return createQueueCapacityExceededError(maxQueued);
    }
    if (
      active !== undefined &&
      exceedsQueuedByteLimit(queuedBytes, retainedBytes, maxQueuedBytes)
    ) {
      return createQueueBytesExceededError(
        maxQueuedBytes,
        queuedBytes,
        retainedBytes,
      );
    }
    return undefined;
  };

  const run = <T extends WorkerResult>(
    validate: () => void,
    prepare: (id: number) => PreparedOperation,
    operationOptions: AudioOperationOptions,
    retainedBytes: number,
  ): Promise<T> => {
    try {
      validate();
    } catch (error) {
      return Promise.reject(error);
    }

    const admissionError = getAdmissionError(
      operationOptions.signal,
      retainedBytes,
    );
    if (admissionError !== undefined) {
      return Promise.reject(admissionError);
    }

    const queuedReservation = active === undefined ? 0 : retainedBytes;
    queuedBytes += queuedReservation;

    const id = nextOperationId;
    nextOperationId += 1;

    return new Promise<T>((resolve, reject) => {
      const signal = operationOptions.signal;
      const operation: QueuedOperation = {
        abortListener: undefined,
        cancelReason: undefined,
        cancelRequested: false,
        id,
        onProgress: operationOptions.onProgress,
        posted: false,
        queuedBytes: queuedReservation,
        prepare,
        reject,
        resolve: resolve as QueuedOperation['resolve'],
        signal,
        validate,
      };
      try {
        if (signal !== undefined) {
          operation.abortListener = (): void => {
            const error = createOperationAbortedError(signal);
            if (operation.posted) {
              cancelActive(operation, error);
            } else {
              const queueIndex = queue.indexOf(operation);
              if (queueIndex === -1) {
                return;
              }
              queue.splice(queueIndex, 1);
              rejectOperation(operation, error);
            }
          };
          signal.addEventListener('abort', operation.abortListener, {
            once: true,
          });
        }
      } catch (error) {
        rejectOperation(operation, error);
        return;
      }
      queue.push(operation);
      drain();
    });
  };

  return {
    decode(input, operationOptions = {}): Promise<DecodedAudio> {
      const admissionError = getAdmissionError(operationOptions.signal);
      if (admissionError !== undefined) {
        return Promise.reject(admissionError);
      }
      const inputSnapshot = snapshotAudioInput(input);
      const optionsSnapshot = snapshotOperationOptions(operationOptions);
      return run<DecodedAudio>(
        () => assertWholeBufferInputWithinLimit(inputSnapshot, optionsSnapshot),
        (id) => {
          const prepared = prepareInput(
            inputSnapshot,
            optionsSnapshot.transferInput,
          );
          return {
            request: {
              id,
              input: prepared.value,
              type: 'decode',
              ...serializeUnsafeBufferOption(optionsSnapshot),
            },
            transfer: prepared.transfer,
          };
        },
        optionsSnapshot,
        getAudioInputRetainedBytes(inputSnapshot),
      );
    },
    encode(
      audio,
      presetId,
      operationOptions = {},
    ): Promise<EncodedAudio> {
      const admissionError = getAdmissionError(operationOptions.signal);
      if (admissionError !== undefined) {
        return Promise.reject(admissionError);
      }
      const audioSnapshot = snapshotPcmAudio(audio);
      const optionsSnapshot = snapshotOperationOptions(operationOptions);
      let payloadPlan: WorkerPcmPayloadPlan;
      const validate = (): void => {
        assertWholeBufferPcmWithinLimit(audioSnapshot, optionsSnapshot);
        payloadPlan = createWorkerPcmPayloadPlan(
          audioSnapshot.channelData,
          optionsSnapshot.transferInput,
        );
        assertWorkerPcmPayloadWithinLimit(payloadPlan, optionsSnapshot);
      };

      return run<EncodedAudio>(
        validate,
        (id) => {
          const prepared = preparePcmAudio(
            audioSnapshot,
            payloadPlan,
          );
          return {
            request: {
              audio: prepared.value,
              id,
              presetId,
              type: 'encode',
              ...serializeUnsafeBufferOption(optionsSnapshot),
            },
            transfer: prepared.transfer,
          };
        },
        optionsSnapshot,
        getUniquePcmBufferByteLength(audioSnapshot.channelData),
      );
    },
    getCapabilities(): AudioTranscoderCapabilities {
      return localEngine.getCapabilities();
    },
    getInfo(): AudioTranscoderEngineInfo {
      return localEngine.getInfo();
    },
    getVersion(): string {
      return localEngine.getVersion();
    },
    inspect(input): AudioInspection {
      return localEngine.inspect(input);
    },
    terminate(): void {
      if (!terminated) {
        terminated = true;
        releaseWorker();
        rejectAll(createWorkerTerminatedError());
      }
    },
    transcode(
      input,
      presetId,
      operationOptions = {},
    ): Promise<EncodedAudio> {
      const admissionError = getAdmissionError(operationOptions.signal);
      if (admissionError !== undefined) {
        return Promise.reject(admissionError);
      }
      const inputSnapshot = snapshotAudioInput(input);
      const optionsSnapshot = snapshotOperationOptions(operationOptions);
      return run<EncodedAudio>(
        () => assertWholeBufferInputWithinLimit(inputSnapshot, optionsSnapshot),
        (id) => {
          const prepared = prepareInput(
            inputSnapshot,
            optionsSnapshot.transferInput,
          );
          return {
            request: {
              id,
              input: prepared.value,
              presetId,
              type: 'transcode',
              ...serializeUnsafeBufferOption(optionsSnapshot),
            },
            transfer: prepared.transfer,
          };
        },
        optionsSnapshot,
        getAudioInputRetainedBytes(inputSnapshot),
      );
    },
  };
}

function serializeUnsafeBufferOption(
  options: AudioOperationOptions,
): Pick<AudioOperationOptions, 'unsafeAllowLargeBuffers'> {
  return options.unsafeAllowLargeBuffers === undefined
    ? {}
    : { unsafeAllowLargeBuffers: options.unsafeAllowLargeBuffers };
}

function createWorker(workerFactory: (() => Worker) | undefined): Worker {
  if (workerFactory !== undefined) {
    return workerFactory();
  }
  if (typeof Worker === 'undefined') {
    throw new AudioTranscoderError(
      'WORKER_UNAVAILABLE',
      'Web Workers are unavailable in this environment.',
    );
  }
  return new Worker(new URL('./entry.js', import.meta.url), {
    name: 'audio-transcoder',
    type: 'module',
  });
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
      `Worker engine maxQueued must be an integer from 0 to ${MAX_QUEUED}.`,
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
      'Worker engine maxQueuedBytes must be a non-negative safe integer.',
    );
  }
  return resolved;
}

function createQueueCapacityExceededError(
  maxQueued: number,
): AudioTranscoderError {
  return new AudioTranscoderError(
    'QUEUE_CAPACITY_EXCEEDED',
    `Audio transcoder Worker queue is full (maxQueued: ${maxQueued}; active operation excluded).`,
  );
}

function createQueueBytesExceededError(
  maxQueuedBytes: number,
  queuedBytes: number,
  retainedBytes: number,
): AudioTranscoderError {
  return new AudioTranscoderError(
    'RESOURCE_LIMIT_EXCEEDED',
    `Audio transcoder Worker waiting queue exceeds maxQueuedBytes (${maxQueuedBytes} bytes; queued: ${queuedBytes} bytes; requested: ${formatRetainedBytes(retainedBytes)}; active operation excluded).`,
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

interface PreparedValue<T> {
  readonly transfer: Transferable[];
  readonly value: T;
}

function prepareInput(
  input: AudioInput,
  transferInput: boolean | undefined,
): PreparedValue<AudioInput> {
  const data = transferInput === true ? input.data : input.data.slice(0);
  return { transfer: [data], value: { ...input, data } };
}

function preparePcmAudio(
  audio: PcmAudio,
  plan: WorkerPcmPayloadPlan,
): PreparedValue<PcmAudio> {
  const channelData = plan.channels.map((preparation) =>
    preparation.mode === 'transfer'
      ? preparation.channel
      : preparation.channel.slice(0, preparation.copyLength),
  );
  const transfer = [
    ...new Set(
      channelData
        .map(({ buffer }) => buffer)
        .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer),
    ),
  ];
  return { transfer, value: { channelData, sampleRate: audio.sampleRate } };
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

function freezeDecodedAudio(audio: DecodedAudio): DecodedAudio {
  return Object.freeze({
    ...audio,
    channelData: Object.freeze([...audio.channelData]),
  });
}

function freezeEncodedAudio(audio: EncodedAudio): EncodedAudio {
  return Object.freeze({
    ...audio,
    preset: Object.freeze({ ...audio.preset }),
  });
}
