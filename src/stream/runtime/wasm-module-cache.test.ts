import { describe, expect, it, vi } from 'vitest';
import { createWasmModuleCache } from './wasm-module-cache.js';

const EMPTY_WASM = Uint8Array.of(
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
) as Uint8Array<ArrayBuffer>;

describe('WASM module cache', () => {
  it('coalesces a shared load and compilation', async () => {
    const module = {} as WebAssembly.Module;
    const compile = vi.spyOn(WebAssembly, 'compile').mockResolvedValue(module);
    const loader = vi.fn(async () => EMPTY_WASM);
    const cache = createWasmModuleCache<typeof loader>();

    await expect(
      Promise.all([cache.load(loader), cache.load(loader)]),
    ).resolves.toEqual([module, module]);
    await expect(cache.load(loader)).resolves.toBe(module);
    expect(loader).toHaveBeenCalledOnce();
    expect(compile).toHaveBeenCalledOnce();
  });

  it('does not cancel a shared load while another subscriber is active', async () => {
    let resolveBytes!: (bytes: Uint8Array<ArrayBuffer>) => void;
    let loaderSignal: AbortSignal | undefined;
    const loader = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
          loaderSignal = signal;
          resolveBytes = resolve;
        }),
    );
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue(
      {} as WebAssembly.Module,
    );
    const cache = createWasmModuleCache<typeof loader>();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = cache.load(loader, firstController.signal);
    const second = cache.load(loader, secondController.signal);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());

    firstController.abort('first stopped');
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(loaderSignal?.aborted).toBe(false);
    resolveBytes(EMPTY_WASM);
    await expect(second).resolves.toBeDefined();
    expect(loaderSignal?.aborted).toBe(false);
  });

  it('aborts an orphaned load and permits a clean retry', async () => {
    let firstSignal: AbortSignal | undefined;
    const loader = vi
      .fn<(signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>>()
      .mockImplementationOnce(
        (signal) =>
          new Promise((_resolve, reject) => {
            firstSignal = signal;
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('stopped', 'AbortError')),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(EMPTY_WASM);
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue(
      {} as WebAssembly.Module,
    );
    const cache = createWasmModuleCache<typeof loader>();
    const controller = new AbortController();
    const abandoned = cache.load(loader, controller.signal);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());

    controller.abort(new Error('caller stopped'));
    await expect(abandoned).rejects.toThrow('caller stopped');
    expect(firstSignal?.aborted).toBe(true);
    await expect(cache.load(loader)).resolves.toBeDefined();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('rejects a pre-aborted subscriber without starting a load', async () => {
    const loader = vi.fn(async () => EMPTY_WASM);
    const cache = createWasmModuleCache<typeof loader>();
    const controller = new AbortController();
    controller.abort(new Error('already stopped'));

    await expect(cache.load(loader, controller.signal)).rejects.toThrow(
      'already stopped',
    );
    expect(loader).not.toHaveBeenCalled();
  });
});
