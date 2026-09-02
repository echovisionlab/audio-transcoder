import { createOperationAbortedError } from '../engine/operation-errors.js';

/** Races awaited runtime work without trusting the dependency to honor abort. */
export function raceWithOperationAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(createOperationAbortedError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const abort = (): void => {
      cleanup();
      reject(createOperationAbortedError(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Releases a resource that is created only after its caller has aborted. */
export function cleanupOperationResultAfterAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  cleanup: (
    value: T,
    reason: ReturnType<typeof createOperationAbortedError>,
  ) => void | Promise<void>,
): void {
  if (signal === undefined) return;
  void operation.then(
    (value) => {
      if (!signal.aborted) return;
      try {
        void Promise.resolve(
          cleanup(value, createOperationAbortedError(signal)),
        ).catch(() => undefined);
      } catch {
        // Cleanup failures never replace the operation's canonical abort.
      }
    },
    () => undefined,
  );
}
