import type { AudioCodecOperationContext } from '../codecs/contracts.js';
import { AudioTranscoderError } from '../errors.js';
import type {
  AudioOperationKind,
  AudioOperationOptions,
  AudioProgress,
  AudioProgressPhase,
} from './contracts.js';
import { createOperationAbortedError } from './operation-errors.js';

interface CreateProgressPhaseOptions {
  readonly operation: AudioOperationKind;
  readonly operationOptions: AudioOperationOptions;
  readonly phase: AudioProgressPhase;
  readonly phaseCount: number;
  readonly phaseIndex: number;
}

const PROGRESS_DECIMAL_PLACES = 3;
const PROGRESS_SCALE = 10 ** PROGRESS_DECIMAL_PLACES;

export interface ProgressPhase {
  readonly context: AudioCodecOperationContext;
  complete(): void;
  start(): void;
}

export function createProgressPhase(
  options: CreateProgressPhaseOptions,
): ProgressPhase {
  let lastPhaseRatio = 0;
  let lastCompletedFrames: number | null = null;
  let lastTotalFrames: number | null = null;

  const throwIfAborted = (): void => {
    throwIfOperationAborted(options.operationOptions.signal);
  };

  const emit = (
    phaseRatio: number,
    completedFrames: number | null,
    totalFrames: number | null,
  ): void => {
    if (phaseRatio < lastPhaseRatio) {
      throw new AudioTranscoderError(
        'INVALID_PROGRESS',
        'Codec progress must be monotonic.',
      );
    }

    lastPhaseRatio = phaseRatio;
    lastCompletedFrames = completedFrames;
    lastTotalFrames = totalFrames;

    const progressValue = Math.min(
      1,
      (options.phaseIndex + phaseRatio) / options.phaseCount,
    );
    const progress: AudioProgress = Object.freeze({
      completedFrames,
      operation: options.operation,
      phase: options.phase,
      progress: quantizeProgress(progressValue),
      totalFrames,
    });
    options.operationOptions.onProgress?.(progress);
  };

  const reportProgress = (
    completedFrames: number,
    totalFrames: number,
  ): void => {
    assertValidFrameProgress(completedFrames, totalFrames);
    emit(completedFrames / totalFrames, completedFrames, totalFrames);
  };

  return {
    context: {
      signal: options.operationOptions.signal,
      async checkpoint(
        completedFrames: number,
        totalFrames: number,
      ): Promise<void> {
        reportProgress(completedFrames, totalFrames);
        throwIfAborted();
        await yieldToEventLoop();
        throwIfAborted();
      },
      reportProgress,
      throwIfAborted,
    },
    complete(): void {
      throwIfAborted();
      if (lastPhaseRatio < 1) {
        emit(1, lastTotalFrames, lastTotalFrames);
      }
    },
    start(): void {
      throwIfAborted();
      emit(0, lastCompletedFrames, lastTotalFrames);
    },
  };
}

export function emitFinalProgress(
  operation: AudioOperationKind,
  options: AudioOperationOptions,
): void {
  throwIfOperationAborted(options.signal);
  options.onProgress?.(
    Object.freeze({
      completedFrames: null,
      operation,
      phase: 'finalize',
      progress: 1,
      totalFrames: null,
    }),
  );
}

function quantizeProgress(progress: number): number {
  return Math.round(progress * PROGRESS_SCALE) / PROGRESS_SCALE;
}

export function throwIfOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createOperationAbortedError(signal);
  }
}

function assertValidFrameProgress(
  completedFrames: number,
  totalFrames: number,
): void {
  if (
    !Number.isSafeInteger(completedFrames) ||
    !Number.isSafeInteger(totalFrames) ||
    totalFrames <= 0 ||
    completedFrames < 0 ||
    completedFrames > totalFrames
  ) {
    throw new AudioTranscoderError(
      'INVALID_PROGRESS',
      'Codec progress requires integer frame counts where 0 <= completed <= total.',
    );
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
