import { describe, expect, it, vi } from 'vitest';

import {
  cleanupOperationResultAfterAbort,
  raceWithOperationAbort,
} from './abortable-operation.js';

describe('operation abort race', () => {
  it('returns an unscoped operation unchanged', () => {
    const operation = Promise.resolve(3);
    expect(raceWithOperationAbort(operation, undefined)).toBe(operation);
  });

  it('rejects an already-aborted caller and observes a late failure', async () => {
    const operation = deferred<number>();
    const controller = new AbortController();
    controller.abort('already stopped');

    await expect(
      raceWithOperationAbort(operation.promise, controller.signal),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'already stopped',
    });
    operation.reject(new Error('late failure'));
  });

  it('settles normally and removes its abort listener', async () => {
    const controller = new AbortController();
    await expect(
      raceWithOperationAbort(Promise.resolve(5), controller.signal),
    ).resolves.toBe(5);
    await expect(
      raceWithOperationAbort(
        Promise.reject(new Error('failed')),
        controller.signal,
      ),
    ).rejects.toThrow('failed');
  });

  it('rejects promptly when a non-cooperative operation stays pending', async () => {
    const operation = deferred<number>();
    const controller = new AbortController();
    const pending = raceWithOperationAbort(
      operation.promise,
      controller.signal,
    );

    controller.abort(new Error('runtime stopped'));
    await expect(pending).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'runtime stopped',
    });
    operation.resolve(9);
  });

  it('cleans a late successful result after abort and observes cleanup failures', async () => {
    const operation = deferred<number>();
    const controller = new AbortController();
    const cleanup = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    cleanupOperationResultAfterAbort(
      operation.promise,
      controller.signal,
      cleanup,
    );

    controller.abort('late resource stopped');
    operation.resolve(9);

    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(cleanup).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        code: 'OPERATION_ABORTED',
        message: 'late resource stopped',
      }),
    );
  });

  it('does not clean normal, unscoped, failed, or synchronously failing cleanup paths', async () => {
    const active = new AbortController();
    const cleanup = vi.fn();
    cleanupOperationResultAfterAbort(Promise.resolve(1), undefined, cleanup);
    cleanupOperationResultAfterAbort(Promise.resolve(2), active.signal, cleanup);
    cleanupOperationResultAfterAbort(
      Promise.reject(new Error('creation failed')),
      active.signal,
      cleanup,
    );
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();

    active.abort();
    cleanupOperationResultAfterAbort(
      Promise.resolve(3),
      active.signal,
      () => {
        throw new Error('synchronous cleanup failed');
      },
    );
    await Promise.resolve();
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
