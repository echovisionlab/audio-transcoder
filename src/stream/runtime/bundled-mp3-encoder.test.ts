import type { AudioCodec, EncodedPacket } from 'mediabunny';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BundledMp3WasmExports,
  Mp3WasmByteLoader,
} from './bundled-mp3-encoder.js';

const extensionMocks = vi.hoisted(() => ({
  registerEncoder: vi.fn(),
}));

vi.mock('mediabunny', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mediabunny')>();
  return {
    ...actual,
    registerEncoder: extensionMocks.registerEncoder,
  };
});

interface TestEncoder {
  close(): void;
  encode(sample: TestAudioSample): Promise<void>;
  flush(): Promise<void>;
  init(): Promise<void>;
}

interface TestEncoderConstructor {
  new (): TestEncoder;
  supports(codec: AudioCodec, config: AudioEncoderConfig): boolean;
}

interface TestAudioSample {
  readonly numberOfFrames: number;
  readonly timestamp: number;
  allocationSize(options: {
    readonly format: 's16-planar';
    readonly planeIndex: number;
  }): number;
  copyTo(
    destination: Uint8Array,
    options: {
      readonly format: 's16-planar';
      readonly planeIndex: number;
    },
  ): void;
}

interface FakeRuntime extends BundledMp3WasmExports {
  readonly initialize: ReturnType<typeof vi.fn>;
  readonly setEncodeOutput: (bytes: Uint8Array, result?: number) => void;
  readonly setFlushOutput: (bytes: Uint8Array, result?: number) => void;
}

type EncoderConfigOverrides = Omit<
  Partial<AudioEncoderConfig>,
  'bitrate'
> & {
  readonly bitrate?: number | undefined;
};

const EMPTY_WASM = Uint8Array.of(0, 97, 115, 109) as Uint8Array<ArrayBuffer>;
const INPUT_POINTER = 1024;
const OUTPUT_POINTER = 8192;

let bindEncoderConfig: ((config: AudioEncoderConfig) => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  bindEncoderConfig = undefined;
  vi.restoreAllMocks();
  extensionMocks.registerEncoder.mockReset();
});

describe('bundled MP3 encoder registration and support', () => {
  it('validates the loader and retries registration failure', async () => {
    extensionMocks.registerEncoder
      .mockImplementationOnce(() => {
        throw new Error('registry unavailable');
      })
      .mockImplementation(() => undefined);
    const extension = await import('./bundled-mp3-encoder.js');
    const loader = createLoader();

    expect(() =>
      extension.createBundledMp3EncoderRegistration(
        undefined as unknown as Mp3WasmByteLoader,
      ),
    ).toThrow('requires a WASM byte loader');
    const registration = extension.createBundledMp3EncoderRegistration(loader);
    expect(() => registration.register()).toThrow(
      'registry unavailable',
    );
    expect(() => registration.register()).not.toThrow();
    registration.register();

    expect(extensionMocks.registerEncoder).toHaveBeenCalledTimes(2);
    const other = extension.createBundledMp3EncoderRegistration(createLoader());
    expect(() => other.register()).not.toThrow();
    expect(extensionMocks.registerEncoder).toHaveBeenCalledTimes(2);
  });

  it('isolates different provider loaders by encoder configuration', async () => {
    const { Encoder, loader: firstLoader } = await loadEncoder(
      createFakeRuntime(),
    );
    const secondFailure = new Error('second provider unavailable');
    const secondLoader = vi.fn(async () => {
      throw secondFailure;
    });
    const extension = await import('./bundled-mp3-encoder.js');
    const secondRegistration = extension.createBundledMp3EncoderRegistration(
      secondLoader,
    );
    secondRegistration.register();
    const secondConfig = config({}, false);
    secondRegistration.bind(secondConfig);

    expect(Encoder.supports('mp3', config({}, false))).toBe(false);
    expect(Encoder.supports('mp3', secondConfig)).toBe(true);
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
      config({}, false),
    );
    await expect(unbound.init()).rejects.toThrow(
      'No MP3 runtime-asset WASM loader was bound',
    );
    expect(firstLoader).toHaveBeenCalledOnce();
    expect(secondLoader).toHaveBeenCalledOnce();
    expect(extensionMocks.registerEncoder).toHaveBeenCalledOnce();
    first.close();
  });

  it('declares only the exact channel, sample-rate, and bitrate matrix', async () => {
    const { Encoder } = await loadEncoder(createFakeRuntime());

    for (const bitrate of [128_000, 192_000, 256_000, 320_000]) {
      for (const sampleRate of [32_000, 44_100, 48_000]) {
        expect(Encoder.supports('mp3', config({ bitrate, sampleRate }))).toBe(
          true,
        );
      }
    }
    for (const sampleRate of [16_000, 22_050, 24_000]) {
      expect(
        Encoder.supports('mp3', config({ bitrate: 128_000, sampleRate })),
      ).toBe(true);
      expect(
        Encoder.supports('mp3', config({ bitrate: 192_000, sampleRate })),
      ).toBe(false);
    }
    expect(Encoder.supports('aac', config())).toBe(false);
    expect(Encoder.supports('mp3', config({ numberOfChannels: 0 }))).toBe(
      false,
    );
    expect(Encoder.supports('mp3', config({ numberOfChannels: 3 }))).toBe(
      false,
    );
    expect(Encoder.supports('mp3', config({ bitrate: undefined }))).toBe(
      false,
    );
    expect(Encoder.supports('mp3', config({ bitrate: 96_000 }))).toBe(false);
    expect(
      Encoder.supports('mp3', config({ bitrateMode: 'variable' })),
    ).toBe(false);
    expect(Encoder.supports('mp3', config({ sampleRate: 96_000 }))).toBe(false);
  });
});

describe('bundled MP3 WASM loader', () => {
  it('coalesces compilation per loader, creates session-local instances, and supplies fail-closed imports', async () => {
    const firstRuntime = createFakeRuntime();
    const secondRuntime = createFakeRuntime({ initialize: false });
    const compile = vi
      .spyOn(WebAssembly, 'compile')
      .mockResolvedValue({} as WebAssembly.Module);
    const instantiate = vi
      .spyOn(WebAssembly, 'instantiate')
      .mockImplementationOnce(async (_module, imports) => {
        expect(
          (
            imports?.env as {
              emscripten_notify_memory_growth: () => unknown;
            }
          ).emscripten_notify_memory_growth(),
        ).toBeUndefined();
        const wasi = imports?.wasi_snapshot_preview1 as Record<
          string,
          () => unknown
        >;
        for (const name of ['fd_close', 'fd_seek', 'fd_write', 'proc_exit']) {
          expect(() => wasi[name]!()).toThrow(
            'The MP3 runtime-asset WASM module attempted unsupported I/O.',
          );
        }
        return { exports: firstRuntime } as unknown as WebAssembly.Instance;
      })
      .mockResolvedValueOnce({
        exports: secondRuntime,
      } as unknown as WebAssembly.Instance);
    const loader = createLoader();
    const { instantiateBundledMp3Wasm } = await import(
      './bundled-mp3-encoder.js'
    );

    const [first, second] = await Promise.all([
      instantiateBundledMp3Wasm(loader),
      instantiateBundledMp3Wasm(loader),
    ]);

    expect(first).toBe(firstRuntime);
    expect(second).toBe(secondRuntime);
    expect(loader).toHaveBeenCalledOnce();
    expect(compile).toHaveBeenCalledOnce();
    expect(instantiate).toHaveBeenCalledTimes(2);
    expect(firstRuntime.initialize).toHaveBeenCalledOnce();
    expect(secondRuntime.initialize).not.toHaveBeenCalled();
  });

  it('allows a later retry after byte loading or compilation rejects', async () => {
    const compile = vi
      .spyOn(WebAssembly, 'compile')
      .mockRejectedValueOnce(new Error('compile unavailable'))
      .mockResolvedValueOnce({} as WebAssembly.Module);
    vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({
      exports: createFakeRuntime(),
    } as unknown as WebAssembly.Instance);
    const loader = createLoader();
    const { instantiateBundledMp3Wasm } = await import(
      './bundled-mp3-encoder.js'
    );

    await expect(instantiateBundledMp3Wasm(loader)).rejects.toThrow(
      'compile unavailable',
    );
    await expect(instantiateBundledMp3Wasm(loader)).resolves.toBeDefined();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('rejects an ABI mismatch and malformed export surfaces', async () => {
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue(
      {} as WebAssembly.Module,
    );
    const instantiate = vi.spyOn(WebAssembly, 'instantiate');
    const { instantiateBundledMp3Wasm } = await import(
      './bundled-mp3-encoder.js'
    );

    instantiate.mockResolvedValueOnce({
      exports: { ...createFakeRuntime(), memory: {} },
    } as unknown as WebAssembly.Instance);
    await expect(
      instantiateBundledMp3Wasm(createLoader()),
    ).rejects.toThrow('does not export memory');

    for (const name of [
      'wasm_mp3_abi_version',
      'wasm_mp3_create',
      'wasm_mp3_destroy',
      'wasm_mp3_encode',
      'wasm_mp3_flush',
      'wasm_mp3_last_create_error',
      'wasm_mp3_output',
      'wasm_mp3_prepare_pcm',
      'wasm_mp3_reset',
    ] as const) {
      const runtime = createFakeRuntime() as Partial<BundledMp3WasmExports>;
      Reflect.deleteProperty(runtime, name);
      instantiate.mockResolvedValueOnce({
        exports: runtime,
      } as unknown as WebAssembly.Instance);
      await expect(
        instantiateBundledMp3Wasm(createLoader()),
      ).rejects.toThrow(`does not export ${name}`);
    }

    const wrongAbi = createFakeRuntime();
    vi.mocked(wrongAbi.wasm_mp3_abi_version).mockReturnValue(2);
    instantiate.mockResolvedValueOnce({
      exports: wrongAbi,
    } as unknown as WebAssembly.Instance);
    await expect(
      instantiateBundledMp3Wasm(createLoader()),
    ).rejects.toThrow('ABI mismatch: expected 1, received 2');
  });
});

describe('bundled MP3 encoder lifecycle', () => {
  it('copies planar PCM into WASM, emits complete frames with metadata once, and resets after flush', async () => {
    const runtime = createFakeRuntime();
    const firstFrame = createFrame({ payload: 0x11 });
    const secondFrame = createFrame({ payload: 0x22 });
    runtime.setEncodeOutput(firstFrame.subarray(0, 200));
    runtime.setFlushOutput(
      concat(firstFrame.subarray(200), secondFrame),
    );
    const { Encoder } = await loadEncoder(runtime);
    const onPacket = vi.fn();
    const encoder = configureEncoder(new Encoder(), onPacket);
    const sample = createSample(
      [Int16Array.of(1, 2, 3), Int16Array.of(4, 5, 6)],
      1.25,
    );

    await encoder.init();
    await encoder.encode(sample);
    expect(
      Array.from(new Int16Array(runtime.memory.buffer, INPUT_POINTER, 6)),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(onPacket).not.toHaveBeenCalled();

    await encoder.flush();
    expect(onPacket).toHaveBeenCalledTimes(2);
    const firstPacket = onPacket.mock.calls[0]![0] as EncodedPacket;
    const secondPacket = onPacket.mock.calls[1]![0] as EncodedPacket;
    expect(firstPacket.timestamp).toBe(1.25);
    expect(firstPacket.duration).toBe(1152 / 48_000);
    expect(new Uint8Array(firstPacket.data)).toEqual(firstFrame);
    expect(secondPacket.timestamp).toBe(1.25 + 1152 / 48_000);
    expect(new Uint8Array(secondPacket.data)).toEqual(secondFrame);
    expect(onPacket.mock.calls[0]![1]).toEqual({
      decoderConfig: {
        codec: 'mp3',
        numberOfChannels: 2,
        sampleRate: 48_000,
      },
    });
    expect(onPacket.mock.calls[1]![1]).toBeUndefined();
    expect(runtime.wasm_mp3_reset).toHaveBeenCalledWith(7);

    runtime.setEncodeOutput(firstFrame);
    await encoder.encode(createSample([Int16Array.of(7)], 3));
    expect(onPacket.mock.calls[2]![1]).toEqual({
      decoderConfig: expect.objectContaining({ codec: 'mp3' }),
    });
    expect((onPacket.mock.calls[2]![0] as EncodedPacket).timestamp).toBe(3);

    encoder.close();
    encoder.close();
    expect(runtime.wasm_mp3_destroy).toHaveBeenCalledOnce();
  });

  it('retains the first input timestamp and reuses its pending allocation', async () => {
    const runtime = createFakeRuntime();
    const frame = createFrame({ payload: 0x33 });
    runtime.setEncodeOutput(frame);
    const { Encoder } = await loadEncoder(runtime);
    const onPacket = vi.fn();
    const encoder = configureEncoder(new Encoder(), onPacket, {
      numberOfChannels: 1,
    });
    await encoder.init();

    await encoder.encode(createSample([Int16Array.of(1)], 4));
    runtime.setEncodeOutput(frame);
    await encoder.encode(createSample([Int16Array.of(2)], 99));

    expect((onPacket.mock.calls[0]![0] as EncodedPacket).timestamp).toBe(4);
    expect((onPacket.mock.calls[1]![0] as EncodedPacket).timestamp).toBe(
      4 + 1152 / 48_000,
    );
    encoder.close();
  });

  it('supports empty flush at timestamp zero', async () => {
    const runtime = createFakeRuntime();
    runtime.setFlushOutput(createFrame({ payload: 0x44 }));
    const { Encoder } = await loadEncoder(runtime);
    const onPacket = vi.fn();
    const encoder = configureEncoder(new Encoder(), onPacket);
    await encoder.init();

    await encoder.flush();

    expect((onPacket.mock.calls[0]![0] as EncodedPacket).timestamp).toBe(0);
    encoder.close();
  });

  it('rejects use before init, missing bitrates, and native initialization failures', async () => {
    const runtime = createFakeRuntime();
    const { Encoder } = await loadEncoder(runtime);
    const encoder = configureEncoder(new Encoder(), vi.fn());
    const sample = createSample([Int16Array.of(0)], 0);

    await expect(encoder.encode(sample)).rejects.toThrow('not initialized');
    await expect(encoder.flush()).rejects.toThrow('not initialized');
    encoder.close();

    const missingBitrate = configureEncoder(new Encoder(), vi.fn(), {
      bitrate: undefined,
    });
    await expect(missingBitrate.init()).rejects.toThrow(
      'A bitrate is required',
    );

    vi.mocked(runtime.wasm_mp3_create).mockReturnValue(0);
    vi.mocked(runtime.wasm_mp3_last_create_error).mockReturnValue(-7);
    const failed = configureEncoder(new Encoder(), vi.fn());
    await expect(failed.init()).rejects.toThrow(
      'Failed to initialize the MP3 runtime-asset encoder (-7)',
    );
  });

  it('surfaces native allocation, encode, flush, reset, and incomplete-frame failures', async () => {
    const runtime = createFakeRuntime();
    const { Encoder } = await loadEncoder(runtime);

    vi.mocked(runtime.wasm_mp3_prepare_pcm).mockReturnValue(0);
    let encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    await expect(
      encoder.encode(createSample([Int16Array.of(0)], 0)),
    ).rejects.toThrow('Failed to allocate');
    encoder.close();

    vi.mocked(runtime.wasm_mp3_prepare_pcm).mockReturnValue(INPUT_POINTER);
    vi.mocked(runtime.wasm_mp3_encode).mockReturnValue(-12);
    encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    await expect(
      encoder.encode(createSample([Int16Array.of(0)], 0)),
    ).rejects.toThrow('encoding failed (-12)');
    encoder.close();

    vi.mocked(runtime.wasm_mp3_encode).mockReturnValue(0);
    vi.mocked(runtime.wasm_mp3_flush).mockReturnValue(-13);
    encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    await expect(encoder.flush()).rejects.toThrow('flush failed (-13)');
    encoder.close();

    vi.mocked(runtime.wasm_mp3_flush).mockReturnValue(0);
    vi.mocked(runtime.wasm_mp3_reset).mockReturnValue(-14);
    encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    await expect(encoder.flush()).rejects.toThrow('reset failed (-14)');
    encoder.close();

    vi.mocked(runtime.wasm_mp3_reset).mockReturnValue(0);
    vi.mocked(runtime.wasm_mp3_encode).mockImplementation(() => {
      new Uint8Array(runtime.memory.buffer, OUTPUT_POINTER, 2).set([
        0xff, 0xfb,
      ]);
      return 2;
    });
    encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    await encoder.encode(createSample([Int16Array.of(0)], 0));
    runtime.setFlushOutput(new Uint8Array(0));
    await expect(encoder.flush()).rejects.toThrow(
      'left 2 incomplete output bytes',
    );
    encoder.close();
  });

  it('rejects malformed, mismatched, and out-of-memory native output', async () => {
    const runtime = createFakeRuntime();
    const { Encoder } = await loadEncoder(runtime);

    runtime.setEncodeOutput(Uint8Array.of(0, 0, 0, 0));
    let encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    await expect(
      encoder.encode(createSample([Int16Array.of(0)], 0)),
    ).rejects.toThrow('invalid frame data at byte 0');
    encoder.close();

    runtime.setEncodeOutput(createFrame({ sampleRate: 44_100 }));
    encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    await expect(
      encoder.encode(createSample([Int16Array.of(0)], 0)),
    ).rejects.toThrow('returned 44100 Hz for a 48000 Hz stream');
    encoder.close();

    runtime.setEncodeOutput(createFrame());
    vi.mocked(runtime.wasm_mp3_output).mockReturnValue(
      runtime.memory.buffer.byteLength - 2,
    );
    encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    await expect(
      encoder.encode(createSample([Int16Array.of(0)], 0)),
    ).rejects.toThrow('encoded output is outside WASM memory');
    encoder.close();

    vi.mocked(runtime.wasm_mp3_output).mockReturnValue(Number.NaN);
    vi.mocked(runtime.wasm_mp3_encode).mockReturnValue(4);
    encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    await expect(
      encoder.encode(createSample([Int16Array.of(0)], 0)),
    ).rejects.toThrow('encoded output is outside WASM memory');
    encoder.close();

    vi.mocked(runtime.wasm_mp3_output).mockReturnValue(0);
    vi.mocked(runtime.wasm_mp3_encode).mockReturnValue(Number.NaN);
    encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    await expect(
      encoder.encode(createSample([Int16Array.of(0)], 0)),
    ).rejects.toThrow('encoded output is outside WASM memory');
    encoder.close();
  });

  it('rejects a native PCM pointer whose complete planar input is outside memory', async () => {
    const runtime = createFakeRuntime();
    vi.mocked(runtime.wasm_mp3_prepare_pcm).mockReturnValue(
      runtime.memory.buffer.byteLength - 1,
    );
    const { Encoder } = await loadEncoder(runtime);
    const encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();

    await expect(
      encoder.encode(
        createSample([Int16Array.of(1), Int16Array.of(2)], 0),
      ),
    ).rejects.toThrow('input buffer is outside WASM memory');
    encoder.close();
  });
});

describe('bundled MP3 frame parser', () => {
  it('parses MPEG-1, MPEG-2, MPEG-2.5, and padding', async () => {
    const { parseBundledMp3FrameHeader } = await import(
      './bundled-mp3-encoder.js'
    );

    expect(parseBundledMp3FrameHeader(frameWord())).toEqual({
      audioSamplesInFrame: 1152,
      sampleRate: 48_000,
      totalSize: 384,
    });
    expect(
      parseBundledMp3FrameHeader(
        frameWord({ bitrateIndex: 12, versionBits: 2 }),
      ),
    ).toEqual({
      audioSamplesInFrame: 576,
      sampleRate: 24_000,
      totalSize: 384,
    });
    expect(
      parseBundledMp3FrameHeader(
        frameWord({
          bitrateIndex: 12,
          padding: 1,
          sampleRateIndex: 0,
          versionBits: 0,
        }),
      ),
    ).toEqual({
      audioSamplesInFrame: 576,
      sampleRate: 11_025,
      totalSize: 836,
    });
  });

  it.each([
    ['sync', frameWord() & 0x7fff_ffff],
    ['version', frameWord({ versionBits: 1 })],
    ['layer', frameWord({ layerBits: 2 })],
    ['free bitrate', frameWord({ bitrateIndex: 0 })],
    ['bad bitrate', frameWord({ bitrateIndex: 15 })],
    ['sample rate', frameWord({ sampleRateIndex: 3 })],
  ])('rejects an invalid %s field', async (_name, word) => {
    const { parseBundledMp3FrameHeader } = await import(
      './bundled-mp3-encoder.js'
    );
    expect(parseBundledMp3FrameHeader(word)).toBeNull();
  });
});

async function loadEncoder(runtime: FakeRuntime): Promise<{
  readonly Encoder: TestEncoderConstructor;
  readonly loader: Mp3WasmByteLoader & ReturnType<typeof vi.fn>;
}> {
  vi.spyOn(WebAssembly, 'compile').mockResolvedValue(
    {} as WebAssembly.Module,
  );
  vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({
    exports: runtime,
  } as unknown as WebAssembly.Instance);
  const loader = createLoader();
  const { createBundledMp3EncoderRegistration } = await import(
    './bundled-mp3-encoder.js'
  );
  const registration = createBundledMp3EncoderRegistration(loader);
  bindEncoderConfig = registration.bind;
  registration.register();
  const Encoder = extensionMocks.registerEncoder.mock
    .calls[0]![0] as TestEncoderConstructor;
  return { Encoder, loader };
}

function configureEncoder(
  encoder: TestEncoder,
  onPacket: ReturnType<typeof vi.fn>,
  options: EncoderConfigOverrides = {},
): TestEncoder {
  const encoderConfig = config(options);
  return configureEncoderWithConfig(encoder, onPacket, encoderConfig);
}

function configureEncoderWithConfig(
  encoder: TestEncoder,
  onPacket: ReturnType<typeof vi.fn>,
  encoderConfig: AudioEncoderConfig,
): TestEncoder {
  Object.assign(encoder, {
    codec: 'mp3',
    config: encoderConfig,
    onError: vi.fn(),
    onPacket,
  });
  return encoder;
}

function config(
  options: EncoderConfigOverrides = {},
  bind = true,
): AudioEncoderConfig {
  const { bitrate, ...otherOptions } = options;
  const encoderConfig = {
    codec: 'mp3',
    numberOfChannels: 2,
    sampleRate: 48_000,
    ...otherOptions,
    ...(!('bitrate' in options)
      ? { bitrate: 128_000 }
      : bitrate === undefined
        ? {}
        : { bitrate }),
  };
  if (bind) bindEncoderConfig?.(encoderConfig);
  return encoderConfig;
}

function createLoader(): Mp3WasmByteLoader & ReturnType<typeof vi.fn> {
  return vi.fn(async () => EMPTY_WASM) as Mp3WasmByteLoader &
    ReturnType<typeof vi.fn>;
}

function createFakeRuntime(
  options: { readonly initialize?: boolean } = {},
): FakeRuntime {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let encodeBytes = new Uint8Array(0);
  let encodeResult: number | undefined;
  let flushBytes = new Uint8Array(0);
  let flushResult: number | undefined;
  const initialize = vi.fn();
  const runtime = {
    memory,
    ...(options.initialize === false ? {} : { _initialize: initialize }),
    wasm_mp3_abi_version: vi.fn(() => 1),
    wasm_mp3_create: vi.fn(() => 7),
    wasm_mp3_destroy: vi.fn(),
    wasm_mp3_encode: vi.fn(() => {
      new Uint8Array(memory.buffer, OUTPUT_POINTER, encodeBytes.byteLength).set(
        encodeBytes,
      );
      return encodeResult ?? encodeBytes.byteLength;
    }),
    wasm_mp3_flush: vi.fn(() => {
      new Uint8Array(memory.buffer, OUTPUT_POINTER, flushBytes.byteLength).set(
        flushBytes,
      );
      return flushResult ?? flushBytes.byteLength;
    }),
    wasm_mp3_last_create_error: vi.fn(() => 0),
    wasm_mp3_output: vi.fn(() => OUTPUT_POINTER),
    wasm_mp3_prepare_pcm: vi.fn(() => INPUT_POINTER),
    wasm_mp3_reset: vi.fn(() => 0),
    initialize,
    setEncodeOutput(bytes: Uint8Array, result?: number): void {
      encodeBytes = new Uint8Array(bytes);
      encodeResult = result;
    },
    setFlushOutput(bytes: Uint8Array, result?: number): void {
      flushBytes = new Uint8Array(bytes);
      flushResult = result;
    },
  };
  return runtime as unknown as FakeRuntime;
}

function createSample(
  planes: readonly Int16Array[],
  timestamp: number,
): TestAudioSample {
  return {
    numberOfFrames: planes[0]!.length,
    timestamp,
    allocationSize: () => planes[0]!.byteLength,
    copyTo(destination, { planeIndex }): void {
      const plane = planes[planeIndex] ?? planes[0]!;
      destination.set(
        new Uint8Array(
          plane.buffer,
          plane.byteOffset,
          plane.byteLength,
        ),
      );
    },
  };
}

function createFrame(
  options: {
    readonly payload?: number;
    readonly sampleRate?: 44_100 | 48_000;
  } = {},
): Uint8Array {
  const sampleRateIndex = options.sampleRate === 44_100 ? 0 : 1;
  const word = frameWord({ sampleRateIndex });
  const size = Math.floor(
    (144 * 128_000) / (options.sampleRate ?? 48_000),
  );
  const frame = new Uint8Array(size).fill(options.payload ?? 0);
  new DataView(frame.buffer).setUint32(0, word, false);
  return frame;
}

function frameWord(
  options: {
    readonly bitrateIndex?: number;
    readonly layerBits?: number;
    readonly padding?: number;
    readonly sampleRateIndex?: number;
    readonly versionBits?: number;
  } = {},
): number {
  return (
    (0x7ff << 21) |
    ((options.versionBits ?? 3) << 19) |
    ((options.layerBits ?? 1) << 17) |
    (1 << 16) |
    ((options.bitrateIndex ?? 9) << 12) |
    ((options.sampleRateIndex ?? 1) << 10) |
    ((options.padding ?? 0) << 9)
  ) >>> 0;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
