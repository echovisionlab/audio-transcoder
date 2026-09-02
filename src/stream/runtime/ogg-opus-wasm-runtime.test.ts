import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OggOpusWasmExports } from './ogg-opus-wasm-runtime.js';
import { createTestCodecAssetProvider } from '../codec-assets.test-support.js';

const CODEC_ASSETS = createTestCodecAssetProvider();

describe('Ogg Opus WASM runtime', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('compiles once and gives every encoder session its own bounded memory', async () => {
    const compile = vi.spyOn(WebAssembly, 'compile');
    const { createOggOpusWasmInstantiator } =
      await import('./ogg-opus-wasm-runtime.js');
    const instantiateOggOpusWasm = createOggOpusWasmInstantiator(() =>
      CODEC_ASSETS.load('ogg-opus'),
    );

    const [first, second] = await Promise.all([
      instantiateOggOpusWasm(),
      instantiateOggOpusWasm(),
    ]);

    expect(compile).toHaveBeenCalledTimes(1);
    expect(first.memory).not.toBe(second.memory);
    expect(first.memory.buffer.byteLength).toBe(8 * 1024 * 1024);
    expect(second.memory.buffer.byteLength).toBe(8 * 1024 * 1024);

    const handle = first.wasm_ogg_opus_create(2, 192_000);
    expect(handle).not.toBe(0);
    expect(first.memory.buffer.byteLength).toBe(8 * 1024 * 1024);
    first.wasm_ogg_opus_destroy(handle);
    expect(first.memory.buffer.byteLength).toBe(8 * 1024 * 1024);
  });

  it('allows a later compile retry after a lazy initialization rejection', async () => {
    const actualCompile = WebAssembly.compile.bind(WebAssembly);
    const compile = vi
      .spyOn(WebAssembly, 'compile')
      .mockRejectedValueOnce(new Error('compile unavailable'))
      .mockImplementation((bytes) => actualCompile(bytes));
    const { createOggOpusWasmInstantiator } =
      await import('./ogg-opus-wasm-runtime.js');
    const instantiateOggOpusWasm = createOggOpusWasmInstantiator(() =>
      CODEC_ASSETS.load('ogg-opus'),
    );

    await expect(instantiateOggOpusWasm()).rejects.toThrow(
      'compile unavailable',
    );
    await expect(instantiateOggOpusWasm()).resolves.toMatchObject({
      memory: expect.any(WebAssembly.Memory),
    });
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('deduplicates an injected load and retries it after failure', async () => {
    const actualCompile = WebAssembly.compile.bind(WebAssembly);
    const bytes = await CODEC_ASSETS.load('ogg-opus');
    let release: ((bytes: Uint8Array<ArrayBuffer>) => void) | undefined;
    const loadWasm = vi
      .fn<() => Promise<Uint8Array<ArrayBuffer>>>()
      .mockRejectedValueOnce(new Error('asset unavailable'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    const compile = vi
      .spyOn(WebAssembly, 'compile')
      .mockImplementation((source) => actualCompile(source));
    const { createOggOpusWasmInstantiator } =
      await import('./ogg-opus-wasm-runtime.js');
    const instantiate = createOggOpusWasmInstantiator(loadWasm);

    await expect(instantiate()).rejects.toThrow('asset unavailable');
    const first = instantiate();
    const second = instantiate();
    await vi.waitFor(() => expect(loadWasm).toHaveBeenCalledTimes(2));
    release?.(bytes);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(loadWasm).toHaveBeenCalledTimes(2);
    expect(compile).toHaveBeenCalledOnce();
  });

  it('provides memory-growth notification and fail-closed WASI imports', async () => {
    const instantiate = WebAssembly.instantiate.bind(WebAssembly);
    vi.spyOn(WebAssembly, 'instantiate').mockImplementation(
      async (module, imports) => {
        const env = imports?.env as Record<string, () => unknown>;
        const wasi = imports?.wasi_snapshot_preview1 as Record<
          string,
          () => unknown
        >;
        expect(env.emscripten_notify_memory_growth!()).toBeUndefined();
        expect(() => wasi.fd_write!()).toThrow(
          'The Ogg Opus WASM module attempted unsupported WASI I/O.',
        );
        return instantiate(module, imports);
      },
    );
    const { createOggOpusWasmInstantiator } =
      await import('./ogg-opus-wasm-runtime.js');
    const instantiateOggOpusWasm = createOggOpusWasmInstantiator(() =>
      CODEC_ASSETS.load('ogg-opus'),
    );

    await expect(instantiateOggOpusWasm()).resolves.toMatchObject({
      memory: expect.any(WebAssembly.Memory),
    });
  });

  it('rejects a module that does not export WebAssembly memory', async () => {
    vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({
      exports: { memory: {} },
    } as unknown as WebAssembly.Instance);
    const { createOggOpusWasmInstantiator } =
      await import('./ogg-opus-wasm-runtime.js');
    const instantiateOggOpusWasm = createOggOpusWasmInstantiator(() =>
      CODEC_ASSETS.load('ogg-opus'),
    );

    await expect(instantiateOggOpusWasm()).rejects.toThrow(
      'The Ogg Opus WASM module does not export memory.',
    );
  });

  it('rejects a module with an incomplete bridge export surface', async () => {
    const exports = createCompleteExports();
    Reflect.deleteProperty(exports, 'wasm_ogg_opus_write');
    vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({
      exports,
    } as unknown as WebAssembly.Instance);
    const { createOggOpusWasmInstantiator } =
      await import('./ogg-opus-wasm-runtime.js');
    const instantiateOggOpusWasm = createOggOpusWasmInstantiator(() =>
      CODEC_ASSETS.load('ogg-opus'),
    );

    await expect(instantiateOggOpusWasm()).rejects.toThrow(
      'The Ogg Opus WASM module does not export wasm_ogg_opus_write.',
    );
  });
});

function createCompleteExports(): OggOpusWasmExports {
  const noResult = (): void => undefined;
  const zero = (): number => 0;
  return {
    memory: new WebAssembly.Memory({ initial: 1 }),
    wasm_ogg_opus_create: zero,
    wasm_ogg_opus_destroy: noResult,
    wasm_ogg_opus_drain: zero,
    wasm_ogg_opus_eos_seen: zero,
    wasm_ogg_opus_last_create_error: zero,
    wasm_ogg_opus_max_page_bytes: zero,
    wasm_ogg_opus_page: zero,
    wasm_ogg_opus_page_length: zero,
    wasm_ogg_opus_pcm: zero,
    wasm_ogg_opus_pcm_capacity_frames: zero,
    wasm_ogg_opus_pull_page: zero,
    wasm_ogg_opus_write: zero,
  };
}
