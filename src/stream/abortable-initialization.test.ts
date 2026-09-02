import { describe, expect, it, vi } from 'vitest';

import { createAbortableSharedInitialization } from './abortable-initialization.js';

describe('abortable shared initialization', () => {
  it('deduplicates pending callers and caches a successful value', async () => {
    const value = { id: 1 };
    const release = deferred<typeof value>();
    const initialize = vi.fn(async () => release.promise);
    const shared = createAbortableSharedInitialization(initialize);

    const first = shared.get();
    const second = shared.get();
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    release.resolve(value);

    await expect(Promise.all([first, second])).resolves.toEqual([value, value]);
    await expect(shared.get()).resolves.toBe(value);
    expect(initialize).toHaveBeenCalledOnce();
  });

  it('cancels one subscriber without interrupting the remaining caller', async () => {
    const release = deferred<number>();
    let internalSignal: AbortSignal | undefined;
    const shared = createAbortableSharedInitialization(async (signal) => {
      internalSignal = signal;
      return release.promise;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = shared.get(firstController.signal);
    const second = shared.get(secondController.signal);
    await vi.waitFor(() => expect(internalSignal).toBeDefined());
    firstController.abort('first stopped');

    await expect(first).rejects.toBe('first stopped');
    expect(internalSignal?.aborted).toBe(false);
    release.resolve(7);
    await expect(second).resolves.toBe(7);
    expect(internalSignal?.aborted).toBe(false);
  });

  it('aborts non-cooperative shared work and retries after all callers leave', async () => {
    const first = deferred<number>();
    const signals: AbortSignal[] = [];
    const initialize = vi
      .fn<(signal: AbortSignal) => Promise<number>>()
      .mockImplementationOnce((signal) => {
        signals.push(signal);
        return first.promise;
      })
      .mockImplementationOnce(async (signal) => {
        signals.push(signal);
        return 11;
      });
    const shared = createAbortableSharedInitialization(initialize);
    const controller = new AbortController();

    const abandoned = shared.get(controller.signal);
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    controller.abort(new Error('initialize stopped'));

    await expect(abandoned).rejects.toThrow('initialize stopped');
    expect(signals[0]?.aborted).toBe(true);
    await expect(shared.get()).resolves.toBe(11);
    expect(initialize).toHaveBeenCalledTimes(2);
    first.reject(new Error('late loader failure'));
  });

  it('does not cache a failed initialization', async () => {
    const initialize = vi
      .fn<(signal: AbortSignal) => Promise<number>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(3);
    const shared = createAbortableSharedInitialization(initialize);

    await expect(shared.get()).rejects.toThrow('temporary failure');
    await expect(shared.get()).resolves.toBe(3);
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('rejects pre-aborted callers without starting initialization', async () => {
    const initialize = vi.fn(async () => 1);
    const shared = createAbortableSharedInitialization(initialize);
    const signal = { aborted: true, reason: undefined } as AbortSignal;

    await expect(shared.get(signal)).rejects.toMatchObject({
      message: 'The operation was aborted.',
      name: 'AbortError',
    });
    expect(initialize).not.toHaveBeenCalled();
  });
});

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
