interface PendingInitialization<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  settled: boolean;
  subscribers: number;
}

export interface AbortableSharedInitialization<T> {
  get(signal?: AbortSignal): Promise<T>;
}

/**
 * Deduplicates a lazy initialization while it has subscribers, caches only a
 * successful value, and aborts the shared work when every caller cancels.
 * The explicit race keeps cancellation prompt even when an injected loader
 * ignores its AbortSignal.
 */
export function createAbortableSharedInitialization<T>(
  initialize: (signal: AbortSignal) => Promise<T>,
): AbortableSharedInitialization<T> {
  let cached: { readonly value: T } | undefined;
  let pending: PendingInitialization<T> | null = null;

  const start = (): PendingInitialization<T> => {
    const controller = new AbortController();
    const entry = {
      controller,
      promise: undefined as unknown as Promise<T>,
      settled: false,
      subscribers: 0,
    };
    const operation = Promise.resolve().then(() =>
      initialize(controller.signal),
    );
    entry.promise = raceWithAbort(operation, controller.signal)
      .then((value) => {
        cached = { value };
        return value;
      })
      .finally(() => {
        entry.settled = true;
        if (pending === entry) {
          pending = null;
        }
      });
    // The final subscriber may cancel before a non-cooperative loader settles.
    // Keep the shared rejection observed independently of subscriber promises.
    void entry.promise.catch(() => undefined);
    pending = entry;
    return entry;
  };

  return Object.freeze({
    get(signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) {
        return Promise.reject(abortReason(signal));
      }
      if (cached !== undefined) {
        return Promise.resolve(cached.value);
      }
      return subscribe(pending ?? start(), signal, () => {
        const active = pending;
        if (active === null || active.settled || active.subscribers !== 0) {
          return;
        }
        pending = null;
        active.controller.abort(signal?.reason);
      });
    },
  });
}

function subscribe<T>(
  entry: PendingInitialization<T>,
  signal: AbortSignal | undefined,
  onEmpty: () => void,
): Promise<T> {
  entry.subscribers += 1;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      entry.subscribers -= 1;
      settle(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      entry.subscribers -= 1;
      reject(error);
    };
    const abort = (): void => {
      fail(abortReason(signal!));
      onEmpty();
    };
    signal?.addEventListener('abort', abort, { once: true });
    entry.promise.then(
      (value) => finish(resolve, value),
      (error: unknown) => fail(error),
    );
  });
}

function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const abort = (): void => {
      cleanup();
      reject(abortReason(signal));
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

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException('The operation was aborted.', 'AbortError')
  );
}
