import { AudioSample, type AudioCodec, type EncodedPacket } from 'mediabunny';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BundledAacEmscriptenModule } from './aac.generated.mjs';
import type { BundledAacEmscriptenModuleOptions } from './aac.generated.mjs';

const extensionMocks = vi.hoisted(() => ({
  createModule: vi.fn(),
  registerEncoder: vi.fn(),
}));

const EMPTY_WASM_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

let bindEncoderConfig: ((config: AudioEncoderConfig) => void) | undefined;

vi.mock('./aac.generated.mjs', () => ({
  default: extensionMocks.createModule,
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
  encode(sample: AudioSample): Promise<void>;
  flush(): Promise<void>;
  init(): Promise<void>;
}

interface TestEncoderConstructor {
  new (): TestEncoder;
  supports(codec: AudioCodec, config: AudioEncoderConfig): boolean;
}

interface QueuedPacket {
  readonly data: Uint8Array;
  readonly duration: number;
}

interface FakeRuntime {
  readonly closeEncoder: ReturnType<typeof vi.fn>;
  readonly cwrap: BundledAacEmscriptenModule['cwrap'];
  readonly describeError: ReturnType<typeof vi.fn>;
  readonly flushEncoderStart: ReturnType<typeof vi.fn>;
  readonly getEncodeInputPointer: ReturnType<typeof vi.fn>;
  readonly getEncoderExtradata: ReturnType<typeof vi.fn>;
  readonly getEncoderExtradataSize: ReturnType<typeof vi.fn>;
  readonly getEncoderFrameSize: ReturnType<typeof vi.fn>;
  readonly heap: Uint8Array;
  readonly initEncoder: ReturnType<typeof vi.fn>;
  readonly queuePacket: (packet: QueuedPacket) => void;
  readonly receivePacket: ReturnType<typeof vi.fn>;
  readonly replaceHeap: (heap: Uint8Array) => void;
  readonly resetEncoder: ReturnType<typeof vi.fn>;
  readonly sendFrame: ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.resetModules();
  bindEncoderConfig = undefined;
  extensionMocks.createModule.mockReset();
  extensionMocks.registerEncoder.mockReset();
});

describe('bundled AAC encoder', () => {
  it('allows registration to retry after a synchronous MediaBunny failure', async () => {
    extensionMocks.registerEncoder
      .mockImplementationOnce(() => {
        throw new Error('registry unavailable');
      })
      .mockImplementationOnce(() => undefined);
    const extension = await import('./bundled-aac-encoder.js');
    expect(() =>
      extension.createBundledAacEncoderRegistration(
        undefined as unknown as () => Promise<Uint8Array<ArrayBuffer>>,
      ),
    ).toThrow('requires a WASM byte loader');
    const registration = extension.createBundledAacEncoderRegistration(
      async () => EMPTY_WASM_MODULE.slice(),
    );

    expect(() => registration.register()).toThrow('registry unavailable');
    expect(() => registration.register()).not.toThrow();
    registration.register();
    expect(extensionMocks.registerEncoder).toHaveBeenCalledTimes(2);
  });

  it('registers one universal class and isolates loaders by encoder configuration', async () => {
    const runtime = createFakeRuntime();
    extensionMocks.createModule.mockResolvedValue(runtimeModule(runtime));
    const firstLoader = vi.fn(async () => EMPTY_WASM_MODULE.slice());
    const secondFailure = new Error('second provider unavailable');
    const secondLoader = vi.fn(async () => {
      throw secondFailure;
    });
    const extension = await import('./bundled-aac-encoder.js');
    const firstRegistration = extension.createBundledAacEncoderRegistration(
      firstLoader,
    );
    const secondRegistration = extension.createBundledAacEncoderRegistration(
      secondLoader,
    );
    firstRegistration.register();
    secondRegistration.register();
    const Encoder = extensionMocks.registerEncoder.mock.calls[0]?.[0] as
      | TestEncoderConstructor
      | undefined;
    if (Encoder === undefined) throw new Error('AAC encoder was not registered.');

    const firstConfig = createEncoderConfig({}, false);
    const secondConfig = createEncoderConfig({}, false);
    firstRegistration.bind(firstConfig);
    secondRegistration.bind(secondConfig);
    expect(Encoder.supports('aac', createEncoderConfig({}, false))).toBe(false);
    expect(Encoder.supports('aac', firstConfig)).toBe(true);
    expect(Encoder.supports('aac', secondConfig)).toBe(true);

    const first = configureEncoderWithConfig(new Encoder(), vi.fn(), firstConfig);
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
      createEncoderConfig({}, false),
    );
    await expect(unbound.init()).rejects.toThrow(
      'No AAC runtime-asset WASM loader was bound',
    );
    expect(firstLoader).toHaveBeenCalledOnce();
    expect(secondLoader).toHaveBeenCalledOnce();
    expect(extensionMocks.registerEncoder).toHaveBeenCalledOnce();
    first.close();
  });

  it('registers once and declares only the pinned AAC-LC matrix', async () => {
    const Encoder = await loadEncoderConstructor();

    expect(extensionMocks.registerEncoder).toHaveBeenCalledOnce();
    expect(
      Encoder.supports('aac', createEncoderConfig({ aacFormat: undefined })),
    ).toBe(true);
    expect(
      Encoder.supports('aac', createEncoderConfig({ aacFormat: 'aac' })),
    ).toBe(true);
    expect(Encoder.supports('opus', createEncoderConfig())).toBe(false);
    expect(
      Encoder.supports('aac', createEncoderConfig({ numberOfChannels: 0 })),
    ).toBe(false);
    expect(
      Encoder.supports('aac', createEncoderConfig({ numberOfChannels: 3 })),
    ).toBe(false);
    expect(
      Encoder.supports('aac', createEncoderConfig({ sampleRate: 24_000 })),
    ).toBe(false);
    expect(
      Encoder.supports('aac', createEncoderConfig({ bitrate: undefined })),
    ).toBe(false);
    expect(
      Encoder.supports('aac', createEncoderConfig({ bitrate: 320_000 })),
    ).toBe(false);
    expect(
      Encoder.supports('aac', createEncoderConfig({ aacFormat: 'adts' })),
    ).toBe(false);
  });

  it('encodes interleaved frames, carries ASC once, pads flush, and reuses the module', async () => {
    const runtime = createFakeRuntime();
    const copiedInputs: Float32Array[] = [];
    runtime.sendFrame.mockImplementation(
      (_context: number, _timestamp: bigint) => {
        copiedInputs.push(
          new Float32Array(runtime.heap.buffer.slice(256, 256 + 8 * 4)),
        );
        runtime.queuePacket({
          data: Uint8Array.of(0x21 + copiedInputs.length),
          duration: 4,
        });
        return 0;
      },
    );
    extensionMocks.createModule.mockResolvedValue(runtimeModule(runtime));
    const Encoder = await loadEncoderConstructor();
    const onPacket = vi.fn();
    const encoder = configureEncoder(new Encoder(), onPacket);

    await encoder.init();
    const first = createSample(
      [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, -1],
      1.5,
    );
    const second = createSample([0.25, -0.25, 0.5, -0.5], 99);
    await encoder.encode(first);
    await encoder.encode(second);
    first.close();
    second.close();

    expect(runtime.sendFrame).toHaveBeenNthCalledWith(1, 7, 72_000n);
    expect(runtime.sendFrame).toHaveBeenNthCalledWith(2, 7, 72_004n);
    expect(copiedInputs[0]).toEqual(
      Float32Array.from([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]),
    );
    expect(copiedInputs[1]).toEqual(
      Float32Array.from([0.8, 0.9, 1, -1, 0.25, -0.25, 0.5, -0.5]),
    );
    expect(onPacket).toHaveBeenCalledTimes(2);
    expect((onPacket.mock.calls[0]![0] as EncodedPacket).timestamp).toBe(1.5);
    expect((onPacket.mock.calls[1]![0] as EncodedPacket).timestamp).toBe(
      1.5 + 4 / 48_000,
    );
    expect(onPacket.mock.calls[0]![1]).toMatchObject({
      decoderConfig: {
        codec: 'mp4a.40.2',
        description: Uint8Array.of(0x11, 0x90),
        numberOfChannels: 2,
        sampleRate: 48_000,
      },
    });
    expect(onPacket.mock.calls[1]![1]).toBeUndefined();

    await encoder.flush();
    expect(runtime.flushEncoderStart).toHaveBeenCalledOnce();
    expect(runtime.resetEncoder).toHaveBeenCalledOnce();

    const remainder = createSample([0.75, -0.75], 2);
    await encoder.encode(remainder);
    remainder.close();
    await encoder.flush();
    expect(Array.from(copiedInputs[2]!)).toEqual([
      0.75, -0.75, 0, 0, 0, 0, 0, 0,
    ]);
    expect(onPacket.mock.calls[2]![1]).toMatchObject({
      decoderConfig: { description: Uint8Array.of(0x11, 0x90) },
    });

    const secondEncoder = configureEncoder(new Encoder(), vi.fn());
    await secondEncoder.init();
    expect(extensionMocks.createModule).toHaveBeenCalledTimes(2);
    secondEncoder.close();
    encoder.close();
    encoder.close();
    expect(runtime.closeEncoder).toHaveBeenCalledTimes(2);
  });

  it('creates isolated module instances for concurrent encoder initialization', async () => {
    const runtime = createFakeRuntime();
    let release: ((module: BundledAacEmscriptenModule) => void) | undefined;
    extensionMocks.createModule.mockReturnValue(
      new Promise<BundledAacEmscriptenModule>((resolve) => {
        release = resolve;
      }),
    );
    const Encoder = await loadEncoderConstructor();
    const firstEncoder = configureEncoder(new Encoder(), vi.fn());
    const secondEncoder = configureEncoder(new Encoder(), vi.fn());

    const first = firstEncoder.init();
    const second = secondEncoder.init();
    await vi.waitFor(() =>
      expect(extensionMocks.createModule).toHaveBeenCalledTimes(2),
    );
    release?.(runtimeModule(runtime));
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(extensionMocks.createModule).toHaveBeenCalledTimes(2);
    firstEncoder.close();
    secondEncoder.close();
  });

  it('injects raw WASM, deduplicates compilation, and retries a failed load', async () => {
    const runtime = createFakeRuntime();
    const emptyWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
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
    const compile = vi.spyOn(WebAssembly, 'compile');
    extensionMocks.createModule.mockImplementation(
      async (options?: BundledAacEmscriptenModuleOptions) => {
        expect(options?.instantiateWasm).toEqual(expect.any(Function));
        let received = false;
        const exports = options!.instantiateWasm!({}, () => {
          received = true;
        });
        expect(received).toBe(true);
        expect(exports).toEqual({});
        return runtimeModule(runtime);
      },
    );
    const extension = await import('./bundled-aac-encoder.js');
    const registration = extension.createBundledAacEncoderRegistration(loadWasm);
    bindEncoderConfig = registration.bind;
    registration.register();
    registration.register();
    const Encoder = extensionMocks.registerEncoder.mock.calls[0]?.[0] as
      | TestEncoderConstructor
      | undefined;
    expect(Encoder).toBeDefined();
    if (Encoder === undefined)
      throw new Error('AAC encoder was not registered.');
    expect(extensionMocks.registerEncoder).toHaveBeenCalledOnce();

    const failed = configureEncoder(new Encoder(), vi.fn());
    await expect(failed.init()).rejects.toThrow('asset unavailable');
    const first = configureEncoder(new Encoder(), vi.fn());
    const second = configureEncoder(new Encoder(), vi.fn());
    const firstInitialization = first.init();
    const secondInitialization = second.init();
    await vi.waitFor(() => expect(loadWasm).toHaveBeenCalledTimes(2));
    release?.(emptyWasm);

    await expect(
      Promise.all([firstInitialization, secondInitialization]),
    ).resolves.toEqual([undefined, undefined]);
    expect(compile).toHaveBeenCalledOnce();
    expect(extensionMocks.createModule).toHaveBeenCalledTimes(2);
    first.close();
    second.close();
  });

  it('rejects use before initialization and an absent bitrate', async () => {
    const runtime = createFakeRuntime();
    extensionMocks.createModule.mockResolvedValue(runtimeModule(runtime));
    const Encoder = await loadEncoderConstructor();
    const encoder = configureEncoder(new Encoder(), vi.fn());
    const sample = createSample([0, 0], 0);

    await expect(encoder.encode(sample)).rejects.toThrow(
      'The AAC runtime-asset encoder is not initialized.',
    );
    await expect(encoder.flush()).rejects.toThrow(
      'The AAC runtime-asset encoder is not initialized.',
    );
    encoder.close();
    sample.close();

    const missingBitrate = configureEncoder(new Encoder(), vi.fn(), {
      bitrate: undefined,
    });
    await expect(missingBitrate.init()).rejects.toThrow(
      'A bitrate is required for the AAC runtime-asset encoder.',
    );
  });

  it('retries a failed module load and surfaces native initialization failures', async () => {
    const recoveredRuntime = createFakeRuntime();
    extensionMocks.createModule
      .mockRejectedValueOnce(new Error('module unavailable'))
      .mockResolvedValueOnce(runtimeModule(recoveredRuntime));
    let Encoder = await loadEncoderConstructor();
    await expect(
      configureEncoder(new Encoder(), vi.fn()).init(),
    ).rejects.toThrow('module unavailable');
    const recoveredEncoder = configureEncoder(new Encoder(), vi.fn());
    await expect(recoveredEncoder.init()).resolves.toBeUndefined();
    expect(extensionMocks.createModule).toHaveBeenCalledTimes(2);
    recoveredEncoder.close();

    vi.resetModules();
    extensionMocks.registerEncoder.mockReset();
    const runtime = createFakeRuntime();
    runtime.initEncoder.mockReturnValue(0);
    extensionMocks.createModule.mockReset();
    extensionMocks.createModule.mockResolvedValue(runtimeModule(runtime));
    Encoder = await loadEncoderConstructor();
    await expect(
      configureEncoder(new Encoder(), vi.fn()).init(),
    ).rejects.toThrow('Failed to initialize the AAC runtime-asset encoder.');
  });

  it.each([
    ['frame size', { frameSize: 0 }],
    ['extradata pointer', { extradataPointer: 0 }],
    ['extradata size', { extradataSize: 0 }],
  ] as const)(
    'closes a native context with invalid %s',
    async (_name, options) => {
      const runtime = createFakeRuntime(options);
      extensionMocks.createModule.mockResolvedValue(runtimeModule(runtime));
      const Encoder = await loadEncoderConstructor();

      await expect(
        configureEncoder(new Encoder(), vi.fn()).init(),
      ).rejects.toThrow('The AAC runtime-asset encoder returned invalid metadata.');
      expect(runtime.closeEncoder).toHaveBeenCalledWith(7);
    },
  );

  it('surfaces input allocation and encoding failures', async () => {
    const runtime = createFakeRuntime();
    runtime.getEncodeInputPointer.mockReturnValueOnce(0);
    extensionMocks.createModule.mockResolvedValue(runtimeModule(runtime));
    let Encoder = await loadEncoderConstructor();
    let encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    let sample = createSample(new Array<number>(8).fill(0), 0);
    await expect(encoder.encode(sample)).rejects.toThrow(
      'Failed to allocate the AAC runtime-asset input buffer.',
    );
    sample.close();
    encoder.close();

    vi.resetModules();
    extensionMocks.registerEncoder.mockReset();
    const failingRuntime = createFakeRuntime();
    failingRuntime.sendFrame.mockReturnValue(-22);
    extensionMocks.createModule.mockReset();
    extensionMocks.createModule.mockResolvedValue(
      runtimeModule(failingRuntime),
    );
    Encoder = await loadEncoderConstructor();
    encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    sample = createSample(new Array<number>(8).fill(0), 0);
    await expect(encoder.encode(sample)).rejects.toThrow(
      'AAC runtime-asset encoding failed at input sample 0: Native error -22 (-22).',
    );
    sample.close();
    encoder.close();
  });

  it('drains and retries when FFmpeg applies send-side backpressure', async () => {
    const runtime = createFakeRuntime();
    runtime.sendFrame.mockReturnValueOnce(-6).mockReturnValueOnce(0);
    extensionMocks.createModule.mockResolvedValue(runtimeModule(runtime));
    const Encoder = await loadEncoderConstructor();
    const encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    const sample = createSample(new Array<number>(8).fill(0), 0);

    await encoder.encode(sample);

    expect(runtime.sendFrame).toHaveBeenCalledTimes(2);
    expect(runtime.receivePacket).toHaveBeenCalledTimes(2);
    sample.close();
    encoder.close();
  });

  it('pads an initial partial frame without exceeding its PCM buffer', async () => {
    const runtime = createFakeRuntime();
    const copiedInputs: Float32Array[] = [];
    runtime.sendFrame.mockImplementation(() => {
      copiedInputs.push(
        new Float32Array(runtime.heap.buffer.slice(256, 256 + 8 * 4)),
      );
      return 0;
    });
    extensionMocks.createModule.mockResolvedValue(runtimeModule(runtime));
    const Encoder = await loadEncoderConstructor();
    const encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    const sample = createSample([0.5, -0.5], 0);

    await encoder.encode(sample);
    await encoder.flush();

    expect(copiedInputs[0]).toEqual(
      Float32Array.from([0.5, -0.5, 0, 0, 0, 0, 0, 0]),
    );
    sample.close();
    encoder.close();
  });

  it('uses the current WASM heap after native memory growth', async () => {
    const runtime = createFakeRuntime();
    let copiedInput: Float32Array | undefined;
    runtime.getEncodeInputPointer.mockImplementation(() => {
      const grownHeap = new Uint8Array(16_384);
      grownHeap.set(runtime.heap);
      runtime.replaceHeap(grownHeap);
      return 4_096;
    });
    runtime.sendFrame.mockImplementation(() => {
      copiedInput = new Float32Array(
        runtime.heap.buffer.slice(4_096, 4_096 + 8 * 4),
      );
      return 0;
    });
    extensionMocks.createModule.mockResolvedValue(runtimeModule(runtime));
    const Encoder = await loadEncoderConstructor();
    const encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    const sample = createSample([1, 2, 3, 4, 5, 6, 7, 8], 0);

    await encoder.encode(sample);

    expect(copiedInput).toEqual(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    sample.close();
    encoder.close();
  });

  it('surfaces a native flush failure before draining packets', async () => {
    const runtime = createFakeRuntime();
    runtime.flushEncoderStart.mockReturnValue(-12);
    extensionMocks.createModule.mockResolvedValue(runtimeModule(runtime));
    const Encoder = await loadEncoderConstructor();
    const encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();

    await expect(encoder.flush()).rejects.toThrow(
      'AAC runtime-asset flush failed: Native error -12 (-12).',
    );
    expect(runtime.receivePacket).not.toHaveBeenCalled();
    encoder.close();
  });

  it('rejects invalid packet timing and native drain failures', async () => {
    const runtime = createFakeRuntime();
    runtime.queuePacket({ data: Uint8Array.of(1), duration: 4 });
    extensionMocks.createModule.mockResolvedValue(runtimeModule(runtime));
    let Encoder = await loadEncoderConstructor();
    let encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    await expect(encoder.flush()).rejects.toThrow(
      'AAC output timestamps were not initialized.',
    );
    encoder.close();

    vi.resetModules();
    extensionMocks.registerEncoder.mockReset();
    const durationRuntime = createFakeRuntime();
    durationRuntime.sendFrame.mockImplementation(() => {
      durationRuntime.queuePacket({ data: Uint8Array.of(2), duration: 0 });
      return 0;
    });
    extensionMocks.createModule.mockReset();
    extensionMocks.createModule.mockResolvedValue(
      runtimeModule(durationRuntime),
    );
    Encoder = await loadEncoderConstructor();
    encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    let sample = createSample(new Array<number>(8).fill(0), 0);
    await expect(encoder.encode(sample)).rejects.toThrow(
      'The AAC runtime-asset encoder returned an invalid duration.',
    );
    sample.close();
    encoder.close();

    vi.resetModules();
    extensionMocks.registerEncoder.mockReset();
    const drainRuntime = createFakeRuntime();
    drainRuntime.receivePacket.mockReturnValue(-5);
    extensionMocks.createModule.mockReset();
    extensionMocks.createModule.mockResolvedValue(runtimeModule(drainRuntime));
    Encoder = await loadEncoderConstructor();
    encoder = configureEncoder(new Encoder(), vi.fn());
    await encoder.init();
    sample = createSample(new Array<number>(8).fill(0), 0);
    await expect(encoder.encode(sample)).rejects.toThrow(
      'AAC runtime-asset packet drain failed: Native error -5 (-5).',
    );
    sample.close();
    encoder.close();
  });
});

async function loadEncoderConstructor(): Promise<TestEncoderConstructor> {
  const extension = await import('./bundled-aac-encoder.js');
  const registration = extension.createBundledAacEncoderRegistration(
    async () => EMPTY_WASM_MODULE.slice(),
  );
  bindEncoderConfig = registration.bind;
  registration.register();
  registration.register();
  const registered = extensionMocks.registerEncoder.mock.calls[0]?.[0];
  if (registered === undefined) {
    throw new Error('AAC encoder was not registered.');
  }
  return registered as unknown as TestEncoderConstructor;
}

function configureEncoder(
  encoder: TestEncoder,
  onPacket: ReturnType<typeof vi.fn>,
  options: { readonly bitrate?: number | undefined } = {},
): TestEncoder {
  const config = createEncoderConfig(options);
  return configureEncoderWithConfig(encoder, onPacket, config);
}

function configureEncoderWithConfig(
  encoder: TestEncoder,
  onPacket: ReturnType<typeof vi.fn>,
  config: AudioEncoderConfig,
): TestEncoder {
  Object.assign(encoder, {
    codec: 'aac',
    config,
    onError: vi.fn(),
    onPacket,
  });
  return encoder;
}

function createEncoderConfig(
  options: {
    readonly aacFormat?: string | undefined;
    readonly bitrate?: number | undefined;
    readonly numberOfChannels?: number;
    readonly sampleRate?: number;
  } = {},
  bind = true,
): AudioEncoderConfig {
  const config = {
    aac:
      'aacFormat' in options
        ? { format: options.aacFormat }
        : { format: 'aac' },
    bitrate:
      options.bitrate === undefined && 'bitrate' in options
        ? undefined
        : (options.bitrate ?? 128_000),
    bitrateMode: 'variable',
    codec: 'mp4a.40.2',
    numberOfChannels: options.numberOfChannels ?? 2,
    sampleRate: options.sampleRate ?? 48_000,
  } as AudioEncoderConfig;
  if (bind) bindEncoderConfig?.(config);
  return config;
}

function createSample(data: readonly number[], timestamp: number): AudioSample {
  return new AudioSample({
    data: Float32Array.from(data),
    format: 'f32',
    numberOfChannels: 2,
    sampleRate: 48_000,
    timestamp,
  });
}

function createFakeRuntime(
  options: {
    readonly extradataPointer?: number;
    readonly extradataSize?: number;
    readonly frameSize?: number;
  } = {},
): FakeRuntime {
  let heap: Uint8Array = new Uint8Array(8_192);
  const extradataPointer = options.extradataPointer ?? 64;
  const extradataSize = options.extradataSize ?? 2;
  heap.set(Uint8Array.of(0x11, 0x90), extradataPointer);
  const packets: QueuedPacket[] = [];
  let activePacket: QueuedPacket | undefined;
  const closeEncoder = vi.fn();
  const describeError = vi.fn(
    (errorCode: number) => `Native error ${errorCode}`,
  );
  const flushEncoderStart = vi.fn(() => 0);
  const getEncodeInputPointer = vi.fn(() => 256);
  const getEncodedData = vi.fn(() => 2_048);
  const getEncodedDuration = vi.fn(() => activePacket?.duration ?? 0);
  const getEncoderExtradata = vi.fn(() => extradataPointer);
  const getEncoderExtradataSize = vi.fn(() => extradataSize);
  const getEncoderFrameSize = vi.fn(() => options.frameSize ?? 4);
  const initEncoder = vi.fn(() => 7);
  const receivePacket = vi.fn(() => {
    activePacket = packets.shift();
    if (activePacket === undefined) {
      return 0;
    }
    heap.set(activePacket.data, 2_048);
    return activePacket.data.byteLength;
  });
  const resetEncoder = vi.fn();
  const sendFrame = vi.fn(() => 0);
  const functions: Readonly<Record<string, ReturnType<typeof vi.fn>>> = {
    close_encoder: closeEncoder,
    get_error_description: describeError,
    flush_encoder_start: flushEncoderStart,
    get_encode_input_ptr: getEncodeInputPointer,
    get_encoded_data: getEncodedData,
    get_encoded_duration: getEncodedDuration,
    get_encoder_extradata: getEncoderExtradata,
    get_encoder_extradata_size: getEncoderExtradataSize,
    get_encoder_frame_size: getEncoderFrameSize,
    get_again_error_code: vi.fn(() => -6),
    init_encoder: initEncoder,
    receive_packet: receivePacket,
    reset_encoder: resetEncoder,
    send_frame: sendFrame,
  };
  const cwrap: BundledAacEmscriptenModule['cwrap'] = (name) => functions[name];
  return {
    closeEncoder,
    cwrap,
    describeError,
    flushEncoderStart,
    getEncodeInputPointer,
    getEncoderExtradata,
    getEncoderExtradataSize,
    getEncoderFrameSize,
    get heap() {
      return heap;
    },
    initEncoder,
    queuePacket(packet) {
      packets.push(packet);
    },
    receivePacket,
    replaceHeap(nextHeap) {
      heap = nextHeap;
    },
    resetEncoder,
    sendFrame,
  };
}

function runtimeModule(runtime: FakeRuntime): BundledAacEmscriptenModule {
  return {
    get HEAPU8() {
      return runtime.heap;
    },
    cwrap: runtime.cwrap,
  };
}
