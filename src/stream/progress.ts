import type {
  AudioStreamOperationOptions,
  AudioStreamProgress,
  AudioStreamProgressPhase,
} from './contracts.js';
import { createOperationAbortedError } from '../engine/operation-errors.js';

const PROGRESS_SCALE = 1_000;

export interface StreamProgressReporter {
  complete(): void;
  report(
    phase: AudioStreamProgressPhase,
    processedSeconds?: number,
    durationSeconds?: number | null,
  ): void;
  throwIfAborted(): void;
}

export function createStreamProgressReporter(
  options: AudioStreamOperationOptions,
): StreamProgressReporter {
  let lastProgress = 0;
  let lastEmittedPhase: AudioStreamProgressPhase | undefined;
  let lastEmittedProgress: number | undefined;

  const throwIfAborted = (): void => {
    if (options.signal?.aborted) {
      throw createOperationAbortedError(options.signal);
    }
  };

  const emit = (
    phase: AudioStreamProgressPhase,
    progress: number,
    processedSeconds: number | null,
    durationSeconds: number | null,
  ): void => {
    const monotonic = Math.max(lastProgress, Math.min(1, progress));
    lastProgress = monotonic;
    const quantizedProgress =
      Math.round(monotonic * PROGRESS_SCALE) / PROGRESS_SCALE;
    if (
      phase === lastEmittedPhase &&
      quantizedProgress === lastEmittedProgress
    ) {
      return;
    }
    lastEmittedPhase = phase;
    lastEmittedProgress = quantizedProgress;
    const event: AudioStreamProgress = Object.freeze({
      durationSeconds,
      phase,
      processedSeconds,
      progress: quantizedProgress,
    });
    options.onProgress?.(event);
  };

  return {
    complete(): void {
      throwIfAborted();
      emit('finalize', 1, null, null);
    },
    report(phase, processedSeconds, durationSeconds = null): void {
      throwIfAborted();
      const hasDuration =
        processedSeconds !== undefined &&
        durationSeconds !== null &&
        Number.isFinite(durationSeconds) &&
        durationSeconds > 0;
      const ratio = hasDuration
        ? Math.max(0, processedSeconds / durationSeconds)
        : phase === 'prepare'
          ? 0
          : lastProgress;
      emit(
        phase,
        Math.min(0.99, ratio * 0.98),
        processedSeconds ?? null,
        durationSeconds,
      );
    },
    throwIfAborted,
  };
}
