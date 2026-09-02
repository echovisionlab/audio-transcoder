import {
  AudioSample,
  type AudioCodec,
  type EncodedPacket,
} from 'mediabunny';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BundledFlacWasmExports,
  FlacWasmByteLoader,
} from './bundled-flac-encoder.js';

const mediabunnyMocks = vi.hoisted(() => ({
  registerEncoder: vi.fn(),
}));

let bindEncoderConfig: ((config: AudioEncoderConfig) => void) | undefined;

vi.mock('mediabunny', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mediabunny')>();
  return {
    ...actual,
    registerEncoder: mediabunnyMocks.registerEncoder,
  };
});

interface TestEncoder {
  close(): void;
  encode(sample: AudioSample): Promise<void>;
  flush(): Promise<void>;
  init(): Promise<void>;
}

interface TestEncoderConstructor {
  new (): TestEncoder;
  supports(codec: AudioCodec, config: AudioEncoderConfig): boolean;
}

interface FakeFlacWasm extends BundledFlacWasmExports {
  readonly create: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly encode: ReturnType<typeof vi.fn>;
  readonly finish: ReturnType<typeof vi.fn>;
  readonly initialize: ReturnType<typeof vi.fn>;
  readonly preparePcm: ReturnType<typeof vi.fn>;
  readonly reset: ReturnType<typeof vi.fn>;
  readonly setHeader: (header: Uint8Array, pointer?: number) => void;
  readonly setOutput: (
    frames: readonly { readonly data: Uint8Array; readonly samples: number }[],
    options?: { readonly outputLength?: number; readonly pointer?: number },
  ) => void;
}

beforeEach(() => {
  vi.resetModules();
  bindEncoderConfig = undefined;
  mediabunnyMocks.registerEncoder.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bundled FLAC WASM loading', () => {
  it('caches compiled code per loader and creates isolated initialized instances', async () => {
    const firstWasm = createFakeWasm();
    const secondWasm = createFakeWasm();
    const loader = wasmLoader();
    const compile = vi
      .spyOn(WebAssembly, 'compile')
      .mockResolvedValue({} as WebAssembly.Module);
    let instantiations = 0;
    const instantiate = vi
      .spyOn(WebAssembly, 'instantiate')
      .mockImplementation(async (_module, imports) => {
        const imported = imports as {
          readonly env: {
            readonly emscripten_notify_memory_growth: () => unknown;
          };
          readonly wasi_snapshot_preview1: {
            readonly fd_write: () => unknown;
          };
        };
        expect(imported.env.emscripten_notify_memory_growth()).toBeUndefined();
        expect(() => imported.wasi_snapshot_preview1.fd_write()).toThrow(
          'unsupported WASI I/O',
        );
        instantiations += 1;
        return {
          exports: instantiations === 1 ? firstWasm : secondWasm,
        } as WebAssembly.Instance;
      });
    const { instantiateBundledFlacWasm } = await import(
      './bundled-flac-encoder.js'
    );

    const [first, second] = await Promise.all([
      instantiateBundledFlacWasm(loader),
      instantiateBundledFlacWasm(loader),
    ]);

    expect(first).toBe(firstWasm);
    expect(second).toBe(secondWasm);
    expect(loader).toHaveBeenCalledOnce();
    expect(compile).toHaveBeenCalledOnce();
    expect(instantiate).toHaveBeenCalledTimes(2);
    expect(firstWasm.initialize).toHaveBeenCalledOnce();
    expect(secondWasm.initialize).toHaveBeenCalledOnce();
  });

  it('retries a rejected byte load and accepts an absent initializer', async () => {
    const wasm = createFakeWasm();
    Reflect.deleteProperty(wasm, '_initialize');
    const loader = vi
      .fn<FlacWasmByteLoader>()
      .mockRejectedValueOnce(new Error('asset unavailable'))
      .mockResolvedValueOnce(Uint8Array.of(0, 97, 115, 109));
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue(
      {} as WebAssembly.Module,
    );
    mockInstantiation(wasm);
    const { instantiateBundledFlacWasm } = await import(
      './bundled-flac-encoder.js'
    );

    await expect(instantiateBundledFlacWasm(loader)).rejects.toThrow(
      'asset unavailable',
    );
    await expect(instantiateBundledFlacWasm(loader)).resolves.toBe(wasm);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed exports and an incompatible ABI', async () => {
    const { instantiateBundledFlacWasm } = await import(
      './bundled-flac-encoder.js'
    );
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue(
      {} as WebAssembly.Module,
    );
    const loaderWithoutMemory = wasmLoader();
    mockInstantiation({} as BundledFlacWasmExports);
    await expect(instantiateBundledFlacWasm(loaderWithoutMemory)).rejects.toThrow(
      'does not export memory',
    );

    vi.mocked(WebAssembly.instantiate).mockRestore();
    const missingFunction = createFakeWasm();
    Reflect.deleteProperty(missingFunction, 'wasm_flac_create');
    mockInstantiation(missingFunction);
    await expect(instantiateBundledFlacWasm(wasmLoader())).rejects.toThrow(
      'does not export wasm_flac_create',
    );

    vi.mocked(WebAssembly.instantiate).mockRestore();
    const incompatible = createFakeWasm();
    vi.spyOn(incompatible, 'wasm_flac_abi_version').mockReturnValue(2);
    mockInstantiation(incompatible);
    await expect(instantiateBundledFlacWasm(wasmLoader())).rejects.toThrow(
      'ABI mismatch: expected 1, received 2',
    );
  });
});

describe('bundled FLAC registration and support', () => {
  it('validates the loader and retries registration failure', async () => {
    const extension = await import('./bundled-flac-encoder.js');
    expect(() =>
      extension.createBundledFlacEncoderRegistration(
        undefined as unknown as FlacWasmByteLoader,
      ),
    ).toThrow('requires a WASM byte loader');

    const loader = wasmLoader();
    mediabunnyMocks.registerEncoder.mockImplementationOnce(() => {
      throw new Error('registry unavailable');
    });
    const registration = extension.createBundledFlacEncoderRegistration(loader);
    expect(() => registration.register()).toThrow(
      'registry unavailable',
    );
    expect(() => registration.register()).not.toThrow();
    registration.register();
    expect(mediabunnyMocks.registerEncoder).toHaveBeenCalledTimes(2);
    const other = extension.createBundledFlacEncoderRegistration(wasmLoader());
    expect(() => other.register()).not.toThrow();
    expect(mediabunnyMocks.registerEncoder).toHaveBeenCalledTimes(2);
  });

  it('isolates different provider loaders by encoder configuration', async () => {
    installFakeRuntime(createFakeWasm());
    const firstLoader = wasmLoader();
    const Encoder = await loadEncoderConstructor(firstLoader);
    const secondFailure = new Error('second provider unavailable');
    const secondLoader = vi.fn(async () => {
      throw secondFailure;
    });
    const extension = await import('./bundled-flac-encoder.js');
    const secondRegistration = extension.createBundledFlacEncoderRegistration(
      secondLoader,
    );
    secondRegistration.register();
    const secondConfig = encoderConfig({}, false);
    secondRegistration.bind(secondConfig);

    expect(Encoder.supports('flac', encoderConfig({}, false))).toBe(false);
    expect(Encoder.supports('flac', secondConfig)).toBe(true);
    const first = configureEncoder(new Encoder(), vi.fn());
    const second = configureEncoderWithConfig(
      new Encoder(),
      vi.fn(),
      secondConfig,
    );
    await expect(first.init()).resolves.toBeUndefined();
    await expect(second.init()).rejects.toBe(secondFailure);
    const unbound = configureEncoderWithConfig(
      new Encoder(),
      vi.fn(),
      encoderConfig({}, false),
    );
    await expect(unbound.init()).rejects.toThrow(
      'No FLAC runtime-asset WASM loader was bound',
    );
    expect(firstLoader).toHaveBeenCalledOnce();
    expect(secondLoader).toHaveBeenCalledOnce();
    expect(mediabunnyMocks.registerEncoder).toHaveBeenCalledOnce();
    first.close();
  });

  it('declares only the pinned FLAC matrix', async () => {
    const wasm = createFakeWasm();
    installFakeRuntime(wasm);
    const Encoder = await loadEncoderConstructor();

    expect(Encoder.supports('flac', encoderConfig())).toBe(true);
    expect(Encoder.supports('aac', encoderConfig())).toBe(false);
    expect(
      Encoder.supports('flac', encoderConfig({ numberOfChannels: 0 })),
    ).toBe(false);
    expect(
      Encoder.supports('flac', encoderConfig({ numberOfChannels: 9 })),
    ).toBe(false);
    expect(
      Encoder.supports('flac', encoderConfig({ sampleRate: 12_345 })),
    ).toBe(false);
    for (const sampleRate of [
      8_000,
      16_000,
      22_050,
      24_000,
      32_000,
      44_100,
      48_000,
      88_200,
      96_000,
      176_400,
      192_000,
    ]) {
      expect(Encoder.supports('flac', encoderConfig({ sampleRate }))).toBe(true);
    }
  });
});

describe('bundled FLAC encoder', () => {
  it('maps every MediaBunny PCM format to the upstream 16/24-bit contract', async () => {
    const wasm = createFakeWasm();
    installFakeRuntime(wasm);
    const Encoder = await loadEncoderConstructor();
    const formats = [
      ['u8', 16],
      ['u8-planar', 16],
      ['s16', 16],
      ['s16-planar', 16],
      ['s32', 24],
      ['s32-planar', 24],
      ['f32', 24],
      ['f32-planar', 24],
    ] as const;

    for (const [format, bits] of formats) {
      const encoder = configureEncoder(new Encoder(), vi.fn());
      await encoder.init();
      const sample = createSample(format, 0);
      await encoder.encode(sample);
      sample.close();
      encoder.close();
      expect(wasm.create).toHaveBeenLastCalledWith(2, 48_000, bits);
    }
    expect(wasm.destroy).toHaveBeenCalledTimes(formats.length);
  });

  it('copies PCM after memory growth, emits framed packets, flushes, and resets metadata', async () => {
    const wasm = createFakeWasm();
    const copied: Int32Array[] = [];
    let calls = 0;
    wasm.preparePcm.mockImplementation(() => {
      if (calls === 0) wasm.memory.grow(1);
      return 0;
    });
    wasm.encode.mockImplementation(() => {
      calls += 1;
      copied.push(
        Int32Array.from(new Int32Array(wasm.memory.buffer, 512, 4)),
      );
      wasm.setOutput([
        { data: Uint8Array.of(0x10 + calls), samples: 2 },
        { data: Uint8Array.of(0x20 + calls, 0x30 + calls), samples: 2 },
      ]);
      return 0;
    });
    wasm.finish.mockImplementation(() => {
      wasm.setOutput([{ data: Uint8Array.of(0x40), samples: 1 }]);
      return 0;
    });
    installFakeRuntime(wasm);
    const Encoder = await loadEncoderConstructor();
    const onPacket = vi.fn();
    const encoder = configureEncoder(new Encoder(), onPacket);
    await encoder.init();

    const first = createSample('f32', 1.25);
    await encoder.encode(first);
    first.close();
    expect(copied[0]).toEqual(
      Int32Array.from([0, 536_870_912, -1_073_741_823, 1_610_612_735]),
    );
    expect(onPacket).toHaveBeenCalledTimes(2);
    expect((onPacket.mock.calls[0]![0] as EncodedPacket).timestamp).toBe(1.25);
    expect((onPacket.mock.calls[1]![0] as EncodedPacket).timestamp).toBe(
      1.25 + 2 / 48_000,
    );
    expect(onPacket.mock.calls[0]![1]).toMatchObject({
      decoderConfig: {
        codec: 'flac',
        description: Uint8Array.of(0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0),
        numberOfChannels: 2,
        sampleRate: 48_000,
      },
    });
    expect(onPacket.mock.calls[1]![1]).toBeUndefined();

    await encoder.flush();
    expect(wasm.finish).toHaveBeenCalledWith(7);
    expect(wasm.reset).toHaveBeenCalledWith(7);
    expect((onPacket.mock.calls[2]![0] as EncodedPacket).timestamp).toBe(
      1.25 + 4 / 48_000,
    );

    const second = createSample('f32', 3);
    await encoder.encode(second);
    second.close();
    expect(onPacket.mock.calls[3]![1]).toMatchObject({
      decoderConfig: { codec: 'flac' },
    });
    encoder.close();
    encoder.close();
    expect(wasm.destroy).toHaveBeenCalledOnce();
  });

  it('requires initialization, allows an empty flush, and rejects bit-depth changes', async () => {
    const wasm = createFakeWasm();
    installFakeRuntime(wasm);
    const Encoder = await loadEncoderConstructor();
    const encoder = configureEncoder(new Encoder(), vi.fn());
    const sample = createSample('f32', 0);

    await expect(encoder.encode(sample)).rejects.toThrow('not initialized');
    await expect(encoder.flush()).rejects.toThrow('not initialized');
    encoder.close();
    await encoder.init();
    await expect(encoder.flush()).resolves.toBeUndefined();
    await encoder.encode(sample);
    const changed = createSample('s16', 0);
    await expect(encoder.encode(changed)).rejects.toThrow(
      'bit depth cannot change',
    );
    sample.close();
    changed.close();
    encoder.close();
  });

  it('surfaces context, PCM, encode, finish, and reset failures', async () => {
    const cases = [
      ['context', (wasm: FakeFlacWasm) => wasm.create.mockReturnValue(0), 'initialization failed'],
      ['prepare', (wasm: FakeFlacWasm) => wasm.preparePcm.mockReturnValue(-2), 'prepare PCM'],
      ['pcm', (wasm: FakeFlacWasm) => {
        vi.spyOn(wasm, 'wasm_flac_pcm').mockReturnValue(0);
      }, 'invalid PCM buffer'],
      ['encode', (wasm: FakeFlacWasm) => wasm.encode.mockReturnValue(-4), 'encode PCM'],
      ['finish', (wasm: FakeFlacWasm) => wasm.finish.mockReturnValue(-5), 'finish'],
      ['reset', (wasm: FakeFlacWasm) => wasm.reset.mockReturnValue(-3), 'reset'],
    ] as const;

    for (const [name, mutate, message] of cases) {
      vi.resetModules();
      mediabunnyMocks.registerEncoder.mockReset();
      vi.restoreAllMocks();
      const wasm = createFakeWasm();
      mutate(wasm);
      installFakeRuntime(wasm);
      const Encoder = await loadEncoderConstructor();
      const encoder = configureEncoder(new Encoder(), vi.fn());
      await encoder.init();
      const sample = createSample('f32', 0);
      if (name === 'finish' || name === 'reset') {
        await encoder.encode(sample);
        await expect(encoder.flush()).rejects.toThrow(message);
      } else {
        await expect(encoder.encode(sample)).rejects.toThrow(message);
      }
      sample.close();
      encoder.close();
    }
  });

  it('closes a context whose FLAC header is malformed', async () => {
    for (const header of [
      Uint8Array.of(0x66, 0x4c, 0x61),
      Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0),
    ]) {
      vi.resetModules();
      mediabunnyMocks.registerEncoder.mockReset();
      vi.restoreAllMocks();
      const wasm = createFakeWasm();
      wasm.setHeader(header);
      installFakeRuntime(wasm);
      const Encoder = await loadEncoderConstructor();
      const encoder = configureEncoder(new Encoder(), vi.fn());
      await encoder.init();
      const sample = createSample('f32', 0);
      await expect(encoder.encode(sample)).rejects.toThrow(
        header.length < 8 ? 'invalid stream header' : 'invalid stream marker',
      );
      expect(wasm.destroy).toHaveBeenCalledWith(7);
      sample.close();
    }
  });

  it.each([
    ['negative frame count', -1, 0, [], 'invalid output metadata'],
    ['negative output length', 0, -1, [], 'invalid output metadata'],
    ['unframed bytes', 0, 1, [], 'unframed output'],
    ['zero frame size', 1, 1, [{ data: Uint8Array.of(), samples: 1 }], 'invalid frame'],
    ['zero frame samples', 1, 1, [{ data: Uint8Array.of(1), samples: 0 }], 'invalid frame'],
    ['oversize frame', 1, 1, [{ data: Uint8Array.of(1, 2), samples: 1 }], 'invalid frame'],
    ['size mismatch', 1, 2, [{ data: Uint8Array.of(1), samples: 1 }], 'do not match'],
  ] as const)(
    'rejects %s',
    async (_name, frameCount, outputLength, frames, message) => {
      const wasm = createFakeWasm();
      wasm.encode.mockImplementation(() => {
        wasm.setOutput(frames, { outputLength });
        vi.spyOn(wasm, 'wasm_flac_frame_count').mockReturnValue(frameCount);
        return 0;
      });
      installFakeRuntime(wasm);
      const Encoder = await loadEncoderConstructor();
      const encoder = configureEncoder(new Encoder(), vi.fn());
      await encoder.init();
      const sample = createSample('f32', 0);
      await expect(encoder.encode(sample)).rejects.toThrow(message);
      sample.close();
      encoder.close();
    },
  );

  it('accepts an encode that buffers without emitting and rejects an invalid output pointer', async () => {
    const wasm = createFakeWasm();
    let call = 0;
    wasm.encode.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        wasm.setOutput([]);
      } else {
        wasm.setOutput([{ data: Uint8Array.of(1), samples: 1 }], { pointer: 0 });
      }
      return 0;
    });
    installFakeRuntime(wasm);
    const Encoder = await loadEncoderConstructor();
    const encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    const sample = createSample('f32', 0);
    await expect(encoder.encode(sample)).resolves.toBeUndefined();
    await expect(encoder.encode(sample)).rejects.toThrow('invalid output buffer');
    sample.close();
    encoder.close();
  });

  it('rejects a sample with no complete frames', async () => {
    const wasm = createFakeWasm();
    installFakeRuntime(wasm);
    const Encoder = await loadEncoderConstructor();
    const encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    const empty = {
      allocationSize: () => 0,
      copyTo: vi.fn(),
      format: 'f32',
      numberOfFrames: 0,
      timestamp: 0,
    } as unknown as AudioSample;
    await expect(encoder.encode(empty)).rejects.toThrow('complete PCM frames');
    encoder.close();
  });
});

async function loadEncoderConstructor(
  loader: FlacWasmByteLoader = wasmLoader(),
): Promise<TestEncoderConstructor> {
  const extension = await import('./bundled-flac-encoder.js');
  const registration = extension.createBundledFlacEncoderRegistration(loader);
  bindEncoderConfig = registration.bind;
  registration.register();
  const registered = mediabunnyMocks.registerEncoder.mock.calls.at(-1)?.[0];
  if (registered === undefined) {
    throw new Error('FLAC encoder was not registered.');
  }
  return registered as unknown as TestEncoderConstructor;
}

function installFakeRuntime(wasm: BundledFlacWasmExports): void {
  vi.spyOn(WebAssembly, 'compile').mockResolvedValue(
    {} as WebAssembly.Module,
  );
  mockInstantiation(wasm);
}

function mockInstantiation(wasm: BundledFlacWasmExports): void {
  vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({
    exports: wasm,
  } as WebAssembly.Instance);
}

function wasmLoader(): ReturnType<typeof vi.fn<FlacWasmByteLoader>> {
  return vi.fn<FlacWasmByteLoader>(async () =>
    Uint8Array.of(0, 97, 115, 109),
  );
}

function configureEncoder(
  encoder: TestEncoder,
  onPacket: ReturnType<typeof vi.fn>,
): TestEncoder {
  const config = encoderConfig();
  return configureEncoderWithConfig(encoder, onPacket, config);
}

function configureEncoderWithConfig(
  encoder: TestEncoder,
  onPacket: ReturnType<typeof vi.fn>,
  config: AudioEncoderConfig,
): TestEncoder {
  Object.assign(encoder, {
    codec: 'flac',
    config,
    onError: vi.fn(),
    onPacket,
  });
  return encoder;
}

function encoderConfig(
  options: {
    readonly numberOfChannels?: number;
    readonly sampleRate?: number;
  } = {},
  bind = true,
): AudioEncoderConfig {
  const config = {
    codec: 'flac',
    numberOfChannels: options.numberOfChannels ?? 2,
    sampleRate: options.sampleRate ?? 48_000,
  };
  if (bind) bindEncoderConfig?.(config);
  return config;
}

function createSample(
  format: AudioSample['format'],
  timestamp: number,
): AudioSample {
  const values = [0, 0.25, -0.5, 0.75];
  const data = format.startsWith('u8')
    ? Uint8Array.from([128, 160, 64, 224])
    : format.startsWith('s16')
      ? Int16Array.from(values, (value) => Math.round(value * 32_767))
      : format.startsWith('s32')
        ? Int32Array.from(values, (value) => Math.round(value * 2_147_483_647))
        : Float32Array.from(values);
  return new AudioSample({
    data,
    format,
    numberOfChannels: 2,
    sampleRate: 48_000,
    timestamp,
  });
}

function createFakeWasm(): FakeFlacWasm {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
  let headerPointer = 64;
  let headerLength = 0;
  let outputPointer = 4_096;
  let outputLength = 0;
  let frames: readonly { readonly data: Uint8Array; readonly samples: number }[] = [];
  const create = vi.fn(() => 7);
  const destroy = vi.fn();
  const encode = vi.fn(() => 0);
  const finish = vi.fn(() => 0);
  const initialize = vi.fn();
  const preparePcm = vi.fn(() => 0);
  const reset = vi.fn(() => 0);
  const wasm: FakeFlacWasm = {
    memory,
    _initialize: initialize,
    create,
    destroy,
    encode,
    finish,
    initialize,
    preparePcm,
    reset,
    setHeader(header, pointer = 64) {
      headerPointer = pointer;
      headerLength = header.byteLength;
      if (pointer >= 0 && pointer + header.byteLength <= memory.buffer.byteLength) {
        new Uint8Array(memory.buffer).set(header, pointer);
      }
    },
    setOutput(nextFrames, options = {}) {
      frames = nextFrames;
      outputPointer = options.pointer ?? 4_096;
      const bytes = nextFrames.reduce(
        (total, frame) => total + frame.data.byteLength,
        0,
      );
      outputLength = options.outputLength ?? bytes;
      if (outputPointer > 0 && outputPointer + bytes <= memory.buffer.byteLength) {
        let offset = outputPointer;
        for (const frame of nextFrames) {
          new Uint8Array(memory.buffer).set(frame.data, offset);
          offset += frame.data.byteLength;
        }
      }
    },
    wasm_flac_abi_version: vi.fn(() => 1),
    wasm_flac_create: create,
    wasm_flac_last_create_error: vi.fn(() => -3),
    wasm_flac_last_error: vi.fn(() => -9),
    wasm_flac_prepare_pcm: preparePcm,
    wasm_flac_pcm: vi.fn(() => 512),
    wasm_flac_encode: encode,
    wasm_flac_output: vi.fn(() => outputPointer),
    wasm_flac_output_length: vi.fn(() => outputLength),
    wasm_flac_frame_count: vi.fn(() => frames.length),
    wasm_flac_frame_size: vi.fn((_handle, index) => frames[index]?.data.byteLength ?? 0),
    wasm_flac_frame_samples: vi.fn((_handle, index) => frames[index]?.samples ?? 0),
    wasm_flac_header: vi.fn(() => headerPointer),
    wasm_flac_header_length: vi.fn(() => headerLength),
    wasm_flac_finish: finish,
    wasm_flac_reset: reset,
    wasm_flac_destroy: destroy,
  };
  wasm.setHeader(Uint8Array.of(0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0));
  return wasm;
}
