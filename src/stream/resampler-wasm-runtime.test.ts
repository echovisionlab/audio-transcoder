import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('resampler WASM runtime', () => {
  it('initializes, caches compiled code, copies PCM, and closes isolated sessions', async () => {
    const exports = createExports();
    const compile = vi
      .spyOn(WebAssembly, 'compile')
      .mockResolvedValue({} as WebAssembly.Module);
    const instantiate = vi
      .spyOn(WebAssembly, 'instantiate')
      .mockResolvedValue({ exports } as unknown as WebAssembly.Instance);
    const loadWasm = vi.fn(async () => new Uint8Array([1]));
    const createResamplerWasmSession = await createSessionFactory(loadWasm);

    const first = await createResamplerWasmSession(2, 0.5);
    const second = await createResamplerWasmSession(2, 0.5);
    const input = new Float32Array([0.25, -0.25]);
    const output = new Float32Array(2);
    new Float32Array(exports.memory.buffer, 32, 2).set([0.5, -0.5]);

    expect(first.process(input, output, false)).toEqual({
      inputFramesUsed: 1,
      outputFramesGenerated: 1,
    });
    expect([...new Float32Array(exports.memory.buffer, 0, 2)]).toEqual([
      0.25, -0.25,
    ]);
    expect([...output]).toEqual([0.5, -0.5]);
    expect(exports._initialize).toHaveBeenCalledTimes(2);
    expect(exports.wasm_resampler_process).toHaveBeenCalledWith(1, 1, 1, 0);
    expect(compile).toHaveBeenCalledOnce();
    expect(loadWasm).toHaveBeenCalledOnce();
    expect(instantiate).toHaveBeenCalledTimes(2);

    first.close();
    first.close();
    second.close();
    expect(exports.wasm_resampler_destroy).toHaveBeenCalledTimes(2);
    expect(() => first.process(input, output, false)).toThrow('already closed');
  });

  it.each(['first', 'second'] as const)(
    'creates a session for the %s explicit asset loader',
    async () => {
    const exports = createExports({
      inputFramesUsed: 0,
      outputFramesGenerated: 0,
    });
    stubWebAssembly(exports);
    const loadWasm = vi.fn(async () => new Uint8Array([1]));
    const createResamplerWasmSession = await createSessionFactory(loadWasm);

    const session = await createResamplerWasmSession(1, 2);
    expect(
      session.process(new Float32Array(0), new Float32Array(1), true),
    ).toEqual({ inputFramesUsed: 0, outputFramesGenerated: 0 });
    expect(loadWasm).toHaveBeenCalledOnce();
    session.close();
    },
  );

  it('retries compilation after a rejected cached promise', async () => {
    const compile = vi
      .spyOn(WebAssembly, 'compile')
      .mockRejectedValueOnce(new Error('compile failed'))
      .mockResolvedValueOnce({} as WebAssembly.Module);
    vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({
      exports: createExports(),
    } as unknown as WebAssembly.Instance);
    const loadWasm = vi.fn(async () => new Uint8Array([1]));
    const createResamplerWasmSession = await createSessionFactory(loadWasm);

    await expect(createResamplerWasmSession(1, 2)).rejects.toThrow(
      'compile failed',
    );
    await expect(createResamplerWasmSession(1, 2)).resolves.toBeDefined();
    expect(compile).toHaveBeenCalledTimes(2);
    expect(loadWasm).toHaveBeenCalledTimes(2);
  });

  it('deduplicates an injected load and retries it after failure', async () => {
    const exports = createExports();
    const compile = vi
      .spyOn(WebAssembly, 'compile')
      .mockResolvedValue({} as WebAssembly.Module);
    vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({
      exports,
    } as unknown as WebAssembly.Instance);
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
    const { createResamplerWasmSessionFactory } =
      await import('./resampler-wasm-runtime.js');
    const createSession = createResamplerWasmSessionFactory(loadWasm);

    await expect(createSession(1, 2)).rejects.toThrow('asset unavailable');
    const first = createSession(1, 2);
    const second = createSession(1, 2);
    await vi.waitFor(() => expect(loadWasm).toHaveBeenCalledTimes(2));
    release?.(new Uint8Array([1]));

    const sessions = await Promise.all([first, second]);
    expect(compile).toHaveBeenCalledOnce();
    sessions.forEach((session) => session.close());
  });

  it('reports a native session creation failure without requiring initialization', async () => {
    const exports = createExports({ handle: 0, initialize: false });
    exports.wasm_resampler_last_create_error.mockReturnValue(7);
    stubWebAssembly(exports);
    const createResamplerWasmSession = await createSessionFactory();

    await expect(createResamplerWasmSession(1, 2)).rejects.toThrow(
      'error 7',
    );
  });

  it.each([
    ['input', new Float32Array(1), new Float32Array(2)],
    ['output', new Float32Array(2), new Float32Array(1)],
  ] as const)(
    'rejects an incomplete %s frame buffer',
    async (_name, input, output) => {
      const exports = createExports();
      stubWebAssembly(exports);
      const createResamplerWasmSession = await createSessionFactory();
      const session = await createResamplerWasmSession(2, 0.5);

      expect(() => session.process(input, output, false)).toThrow(
        'complete frames',
      );
      session.close();
    },
  );

  it('reports native allocation and processing failures', async () => {
    const exports = createExports();
    stubWebAssembly(exports);
    const createResamplerWasmSession = await createSessionFactory();
    const session = await createResamplerWasmSession(1, 2);

    exports.wasm_resampler_prepare.mockReturnValueOnce(1);
    expect(() =>
      session.process(new Float32Array(1), new Float32Array(2), false),
    ).toThrow('allocate bounded PCM buffers');
    exports.wasm_resampler_process.mockReturnValueOnce(9);
    expect(() =>
      session.process(new Float32Array(1), new Float32Array(2), true),
    ).toThrow('error 9');
    session.close();
  });

  it.each([
    ['null exports', null],
    ['missing memory', { ...createExports(), memory: {} }],
    [
      'missing function',
      { ...createExports(), wasm_resampler_process: undefined },
    ],
  ])('rejects a module with %s', async (_name, invalidExports) => {
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue(
      {} as WebAssembly.Module,
    );
    vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({
      exports: invalidExports,
    } as unknown as WebAssembly.Instance);
    const createResamplerWasmSession = await createSessionFactory();

    await expect(createResamplerWasmSession(1, 2)).rejects.toThrow(
      /does not export/,
    );
  });
});

async function createSessionFactory(
  loadWasm: () => Promise<Uint8Array<ArrayBuffer>> = async () =>
    new Uint8Array([1]),
) {
  const { createResamplerWasmSessionFactory } =
    await import('./resampler-wasm-runtime.js');
  return createResamplerWasmSessionFactory(loadWasm);
}

interface FakeExports {
  readonly memory: WebAssembly.Memory;
  readonly _initialize?: ReturnType<typeof vi.fn>;
  readonly wasm_resampler_create: ReturnType<typeof vi.fn>;
  readonly wasm_resampler_destroy: ReturnType<typeof vi.fn>;
  readonly wasm_resampler_input: ReturnType<typeof vi.fn>;
  readonly wasm_resampler_input_frames_used: ReturnType<typeof vi.fn>;
  readonly wasm_resampler_last_create_error: ReturnType<typeof vi.fn>;
  readonly wasm_resampler_output: ReturnType<typeof vi.fn>;
  readonly wasm_resampler_output_frames_gen: ReturnType<typeof vi.fn>;
  readonly wasm_resampler_prepare: ReturnType<typeof vi.fn>;
  readonly wasm_resampler_process: ReturnType<typeof vi.fn>;
}

function createExports(
  options: {
    readonly handle?: number;
    readonly inputFramesUsed?: number;
    readonly initialize?: boolean;
    readonly outputFramesGenerated?: number;
  } = {},
): FakeExports {
  return {
    ...(options.initialize === false ? {} : { _initialize: vi.fn() }),
    memory: new WebAssembly.Memory({ initial: 1 }),
    wasm_resampler_create: vi.fn(() => options.handle ?? 1),
    wasm_resampler_destroy: vi.fn(),
    wasm_resampler_input: vi.fn(() => 0),
    wasm_resampler_input_frames_used: vi.fn(() => options.inputFramesUsed ?? 1),
    wasm_resampler_last_create_error: vi.fn(() => 0),
    wasm_resampler_output: vi.fn(() => 32),
    wasm_resampler_output_frames_gen: vi.fn(
      () => options.outputFramesGenerated ?? 1,
    ),
    wasm_resampler_prepare: vi.fn(() => 0),
    wasm_resampler_process: vi.fn(() => 0),
  };
}

function stubWebAssembly(exports: FakeExports): void {
  vi.spyOn(WebAssembly, 'compile').mockResolvedValue({} as WebAssembly.Module);
  vi.spyOn(WebAssembly, 'instantiate').mockImplementation(
    async (_module, imports) => {
      const env = imports?.env as Record<string, () => unknown>;
      expect(env.emscripten_notify_memory_growth!()).toBeUndefined();
      return { exports } as unknown as WebAssembly.Instance;
    },
  );
}
