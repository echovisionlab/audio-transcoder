import { describe, expect, it, vi } from 'vitest';
import { createStreamProgressReporter } from './progress.js';

describe('stream progress', () => {
  it('emits immutable, quantized, monotonic progress through completion', () => {
    const onProgress = vi.fn();
    const reporter = createStreamProgressReporter({ onProgress });

    reporter.report('prepare');
    reporter.report('decode');
    reporter.report('decode', -1, 10);
    reporter.report('decode', 1 / 3, 1);
    reporter.report('encode', 2, 1);
    reporter.complete();

    const events = onProgress.mock.calls.map(([event]) => event);
    expect(events.map(({ progress }) => progress)).toEqual([
      0, 0, 0.327, 0.99, 1,
    ]);
    expect(events[2]).toMatchObject({
      durationSeconds: 1,
      processedSeconds: 1 / 3,
    });
    expect(Object.isFrozen(events[0])).toBe(true);
  });

  it('bounds duplicate reports while preserving phase transitions', () => {
    const onProgress = vi.fn();
    const reporter = createStreamProgressReporter({ onProgress });

    reporter.report('prepare');
    for (let index = 0; index < 100_000; index += 1) {
      reporter.report('decode', index);
    }
    reporter.report('encode');
    reporter.complete();

    expect(onProgress).toHaveBeenCalledTimes(4);
    expect(onProgress.mock.calls.map(([event]) => event)).toMatchObject([
      { phase: 'prepare', progress: 0 },
      { phase: 'decode', progress: 0 },
      { phase: 'encode', progress: 0 },
      { phase: 'finalize', progress: 1 },
    ]);
  });

  it('ignores unusable durations and propagates listener failures', () => {
    const listenerError = new Error('render failed');
    const reporter = createStreamProgressReporter({
      onProgress() {
        throw listenerError;
      },
    });

    expect(() => reporter.report('decode', 1, Number.NaN)).toThrow(
      listenerError,
    );

    const progress = vi.fn();
    const withoutDuration = createStreamProgressReporter({
      onProgress: progress,
    });
    withoutDuration.report('decode', 1, 0);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ progress: 0 }),
    );
  });

  it('throws the normalized abort reason before reporting or completing', () => {
    const controller = new AbortController();
    const onProgress = vi.fn();
    const reporter = createStreamProgressReporter({
      onProgress,
      signal: controller.signal,
    });
    controller.abort('stop stream');

    expect(() => reporter.throwIfAborted()).toThrow(
      expect.objectContaining({
        code: 'OPERATION_ABORTED',
        message: 'stop stream',
      }),
    );
    expect(() => reporter.report('prepare')).toThrow(
      expect.objectContaining({ code: 'OPERATION_ABORTED' }),
    );
    expect(() => reporter.complete()).toThrow(
      expect.objectContaining({ code: 'OPERATION_ABORTED' }),
    );
    expect(onProgress).not.toHaveBeenCalled();
  });
});
