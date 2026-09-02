export type AbortableWasmByteLoader = (
  signal?: AbortSignal,
) => Promise<Uint8Array<ArrayBuffer>>;

export interface WasmModuleCache<Loader extends AbortableWasmByteLoader> {
  load(loader: Loader, signal?: AbortSignal): Promise<WebAssembly.Module>;
}

interface ModuleEntry {
  readonly controller: AbortController;
  readonly promise: Promise<WebAssembly.Module>;
  settled: boolean;
  subscribers: number;
}

/** Coalesces compilation while keeping each caller's cancellation independent. */
export function createWasmModuleCache<
  Loader extends AbortableWasmByteLoader,
>(): WasmModuleCache<Loader> {
  const entries = new WeakMap<Loader, ModuleEntry>();

  return Object.freeze({
    async load(
      loader: Loader,
      signal?: AbortSignal,
    ): Promise<WebAssembly.Module> {
      if (signal?.aborted) throw abortReason(signal);
      let entry = entries.get(loader);
      if (entry === undefined) {
        const controller = new AbortController();
        const promise = Promise.resolve()
          .then(() => loader(controller.signal))
          .then((bytes) => WebAssembly.compile(bytes));
        entry = {
          controller,
          promise,
          settled: false,
          subscribers: 0,
        };
        entries.set(loader, entry);
        const createdEntry = entry;
        void promise.then(
          () => {
            createdEntry.settled = true;
          },
          () => {
            createdEntry.settled = true;
            if (entries.get(loader) === createdEntry) entries.delete(loader);
          },
        );
      }
      return subscribe(entries, loader, entry, signal);
    },
  });
}

function subscribe<Loader extends AbortableWasmByteLoader>(
  entries: WeakMap<Loader, ModuleEntry>,
  loader: Loader,
  entry: ModuleEntry,
  signal: AbortSignal | undefined,
): Promise<WebAssembly.Module> {
  entry.subscribers += 1;
  return new Promise<WebAssembly.Module>((resolve, reject) => {
    let active = true;
    const release = (): boolean => {
      if (!active) return false;
      active = false;
      signal?.removeEventListener('abort', abort);
      entry.subscribers -= 1;
      return true;
    };
    const abort = (): void => {
      release();
      if (entry.subscribers === 0 && !entry.settled) {
        entries.delete(loader);
        entry.controller.abort(signal?.reason);
      }
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', abort, { once: true });
    void entry.promise.then(
      (module) => {
        if (!release()) return;
        resolve(module);
      },
      (error: unknown) => {
        if (!release()) return;
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The WASM module load was aborted.', 'AbortError');
}
