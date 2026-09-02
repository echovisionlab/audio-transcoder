import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioOutputPreset } from '../../engine/contracts.js';
import type { AudioStreamOutputChunk } from '../contracts.js';
import type { AudioStreamEncoderConfiguration } from './contracts.js';

const mocks = vi.hoisted(() => ({
  aacFormats: [] as unknown[],
  addAudioTrack: vi.fn(),
  addSample: vi.fn(),
  audioSampleSources: [] as unknown[],
  audioSamples: [] as unknown[],
  closeSource: vi.fn(),
  flacFormats: [] as unknown[],
  mp3Formats: [] as unknown[],
  oggCreate: vi.fn(),
  outputCancel: vi.fn(),
  outputFinalize: vi.fn(),
  outputStart: vi.fn(),
  outputs: [] as unknown[],
  streamTargets: [] as unknown[],
  wavFormats: [] as unknown[],
}));

vi.mock('mediabunny', () => {
  class AdtsOutputFormat {
    constructor() {
      mocks.aacFormats.push(this);
    }
  }

  class StreamTarget {
    private writeListener: ((event: { end: number }) => void) | undefined;

    constructor(
      readonly writable: unknown,
      readonly options: { chunked: boolean; chunkSize: number },
    ) {
      mocks.streamTargets.push(this);
    }

    emitWrite(end: number): void {
      this.writeListener?.({ end });
    }

    on(type: string, listener: (event: { end: number }) => void): void {
      if (type === 'write') {
        this.writeListener = listener;
      }
    }
  }

  class WavOutputFormat {
    constructor(readonly options: { large: boolean }) {
      mocks.wavFormats.push(this);
    }
  }

  class Mp3OutputFormat {
    constructor(readonly options: { xingHeader: boolean }) {
      mocks.mp3Formats.push(this);
    }
  }

  class FlacOutputFormat {
    constructor(readonly options: { appendOnly: boolean }) {
      mocks.flacFormats.push(this);
    }
  }

  class AudioSample {
    readonly close = vi.fn();

    constructor(readonly config: Record<string, unknown>) {
      mocks.audioSamples.push(this);
    }
  }

  class AudioSampleSource {
    constructor(readonly options: Record<string, unknown>) {
      mocks.audioSampleSources.push(this);
    }

    add(sample: unknown) {
      return mocks.addSample(this, sample);
    }

    close(): void {
      mocks.closeSource(this);
    }
  }

  class Output {
    state = 'pending';
    audioSource: unknown;

    constructor(
      readonly options: { format: unknown; target: StreamTarget },
    ) {
      mocks.outputs.push(this);
    }

    addAudioTrack(source: unknown): void {
      mocks.addAudioTrack(this, source);
      this.audioSource = source;
    }

    cancel() {
      return mocks.outputCancel(this);
    }

    finalize() {
      return mocks.outputFinalize(this);
    }

    start() {
      return mocks.outputStart(this);
    }
  }

  return {
    AdtsOutputFormat,
    AudioSample,
    AudioSampleSource,
    FlacOutputFormat,
    Mp3OutputFormat,
    Output,
    StreamTarget,
    WavOutputFormat,
  };
});

vi.mock('./ogg-opus-stream-encoder.js', () => ({
  createOggOpusStreamEncoder: mocks.oggCreate,
}));

import {
  AAC_OUTPUT_PRESET_DESCRIPTORS,
  AIFF_STREAM_OUTPUT_PRESET_DESCRIPTORS,
  FLAC_OUTPUT_PRESET_DESCRIPTORS,
  MP3_OUTPUT_PRESET_DESCRIPTORS,
  OGG_OPUS_OUTPUT_PRESET_DESCRIPTORS,
  STREAM_OUTPUT_PRESET_DESCRIPTORS,
  WAV_STREAM_OUTPUT_PRESET_DESCRIPTORS,
} from '../../codecs/stream-output-presets.js';
import {
  createMediaBunnyStreamEncoderAdapter,
} from './mediabunny-encoder.js';

interface MockAudioSample {
  readonly close: ReturnType<typeof vi.fn>;
  readonly config: Record<string, unknown>;
}

interface MockAudioSampleSource {
  readonly options: Record<string, unknown>;
}

interface MockOutputFormat {
  readonly options: Record<string, unknown>;
}

interface MockStreamTarget {
  emitWrite(end: number): void;
  readonly options: { readonly chunked: boolean; readonly chunkSize: number };
  readonly writable: unknown;
}

interface MockOutput {
  audioSource: unknown;
  readonly options: {
    readonly format: MockOutputFormat;
    readonly target: MockStreamTarget;
  };
  state: string;
}

const DEFAULT_PRESET = WAV_STREAM_OUTPUT_PRESET_DESCRIPTORS[0].preset;
const MEDIABUNNY_OUTPUT_PRESET_DESCRIPTORS =
  STREAM_OUTPUT_PRESET_DESCRIPTORS.filter(
    ({ format }) => format !== 'aiff' && format !== 'ogg',
  );

beforeEach(() => {
  mocks.aacFormats.length = 0;
  mocks.addAudioTrack.mockReset();
  mocks.addSample.mockReset().mockResolvedValue(undefined);
  mocks.closeSource.mockReset();
  mocks.outputCancel.mockReset().mockResolvedValue(undefined);
  mocks.outputFinalize.mockReset().mockResolvedValue(undefined);
  mocks.outputStart.mockReset().mockResolvedValue(undefined);
  mocks.audioSampleSources.length = 0;
  mocks.audioSamples.length = 0;
  mocks.flacFormats.length = 0;
  mocks.mp3Formats.length = 0;
  mocks.oggCreate.mockReset();
  mocks.outputs.length = 0;
  mocks.streamTargets.length = 0;
  mocks.wavFormats.length = 0;
});

describe('MediaBunny stream encoder adapter', () => {
  it('creates a frozen adapter without initializing a codec', () => {
    const adapter = createMediaBunnyStreamEncoderAdapter(vi.fn());
    expect(adapter.id).toBe('mediabunny');
    expect(Object.isFrozen(adapter)).toBe(true);
  });

  it.each(MEDIABUNNY_OUTPUT_PRESET_DESCRIPTORS)(
    'maps $preset.id to its exact MediaBunny format and source configuration',
    async (descriptor) => {
      const ensureCodec = vi.fn().mockResolvedValue(undefined);
      const bindCodecConfiguration = vi.fn();
      const operationSignal = new AbortController().signal;
      const adapter = createMediaBunnyStreamEncoderAdapter(
        ensureCodec,
        mocks.oggCreate,
        bindCodecConfiguration,
      );
      const writable = createWritable();
      const encoder = await adapter.create(
        createConfiguration({
          outputChunkBytes: 128 * 1024,
          preset: descriptor.preset,
          rf64: descriptor.format === 'wav' ? true : null,
          signal: operationSignal,
          writable,
        }),
      );
      const target = current<MockStreamTarget>(mocks.streamTargets);
      const source = current<MockAudioSampleSource>(mocks.audioSampleSources);
      const output = current<MockOutput>(mocks.outputs);

      expect(target).toMatchObject({
        options: { chunked: true, chunkSize: 128 * 1024 },
      });
      expect(target.writable).toBe(writable);
      expect(source.options).toMatchObject(descriptor.encoding!);
      expect(output.options.target).toBe(target);
      expect(output.audioSource).toBe(source);

      if (descriptor.wasmCodec === null) {
        expect(ensureCodec).not.toHaveBeenCalled();
        expect(source.options).toBe(descriptor.encoding);
        expect(bindCodecConfiguration).not.toHaveBeenCalled();
      } else {
        expect(ensureCodec).toHaveBeenCalledOnce();
        expect(ensureCodec).toHaveBeenCalledWith(descriptor.wasmCodec);
        expect(source.options).not.toBe(descriptor.encoding);
        const config = {
          codec: descriptor.encoding!.codec,
          numberOfChannels: 2,
          sampleRate: 48_000,
        } as AudioEncoderConfig;
        const onEncoderConfig = source.options.onEncoderConfig as
          | ((encoderConfig: AudioEncoderConfig) => void)
          | undefined;
        expect(onEncoderConfig).toEqual(expect.any(Function));
        onEncoderConfig?.(config);
        expect(bindCodecConfiguration).toHaveBeenCalledWith(
          descriptor.wasmCodec,
          config,
          operationSignal,
        );
      }

      if (descriptor.format === 'aac') {
        expect(mocks.aacFormats).toHaveLength(1);
      } else if (descriptor.format === 'wav') {
        expect(current<MockOutputFormat>(mocks.wavFormats).options).toEqual({
          large: true,
        });
      } else if (descriptor.format === 'mp3') {
        expect(current<MockOutputFormat>(mocks.mp3Formats).options).toEqual({
          xingHeader: true,
        });
      } else {
        expect(current<MockOutputFormat>(mocks.flacFormats).options).toEqual({
          appendOnly: false,
        });
      }

      await expect(encoder.start()).resolves.toBeUndefined();
      expect(mocks.outputStart).toHaveBeenCalledWith(output);
    },
  );

  it('keeps simultaneous adapter bindings isolated by runtime', async () => {
    const firstBind = vi.fn();
    const secondBind = vi.fn();
    const preset = MP3_OUTPUT_PRESET_DESCRIPTORS[0]!.preset;
    const firstSignal = new AbortController().signal;
    const secondSignal = new AbortController().signal;
    const first = createMediaBunnyStreamEncoderAdapter(
      vi.fn().mockResolvedValue(undefined),
      mocks.oggCreate,
      firstBind,
    );
    const second = createMediaBunnyStreamEncoderAdapter(
      vi.fn().mockResolvedValue(undefined),
      mocks.oggCreate,
      secondBind,
    );

    await first.create(createConfiguration({ preset, signal: firstSignal }));
    await second.create(createConfiguration({ preset, signal: secondSignal }));
    const firstSource = mocks.audioSampleSources[0] as MockAudioSampleSource;
    const secondSource = mocks.audioSampleSources[1] as MockAudioSampleSource;
    const firstConfig = { codec: 'mp3' } as AudioEncoderConfig;
    const secondConfig = { codec: 'mp3' } as AudioEncoderConfig;
    const firstOnConfig = firstSource.options.onEncoderConfig as (
      config: AudioEncoderConfig,
    ) => void;
    const secondOnConfig = secondSource.options.onEncoderConfig as (
      config: AudioEncoderConfig,
    ) => void;

    firstOnConfig(firstConfig);
    secondOnConfig(secondConfig);

    expect(firstBind).toHaveBeenCalledWith('mp3', firstConfig, firstSignal);
    expect(firstBind.mock.calls[0]![1]).toBe(firstConfig);
    expect(secondBind).toHaveBeenCalledWith('mp3', secondConfig, secondSignal);
    expect(secondBind.mock.calls[0]![1]).toBe(secondConfig);
  });

  it('fails closed when a bundled codec has no runtime binding', async () => {
    const adapter = createMediaBunnyStreamEncoderAdapter(
      vi.fn().mockResolvedValue(undefined),
    );
    await adapter.create(
      createConfiguration({ preset: MP3_OUTPUT_PRESET_DESCRIPTORS[0]!.preset }),
    );
    const source = current<MockAudioSampleSource>(mocks.audioSampleSources);
    const onEncoderConfig = source.options.onEncoderConfig as (
      config: AudioEncoderConfig,
    ) => void;

    expect(() =>
      onEncoderConfig({ codec: 'mp3' } as AudioEncoderConfig),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_CONFIGURATION',
        message: expect.stringContaining('explicit runtime configuration'),
      }),
    );
  });

  it.each(OGG_OPUS_OUTPUT_PRESET_DESCRIPTORS)(
    'routes $preset.id to the bundled Ogg Opus writer without MediaBunny allocation',
    async (descriptor) => {
      const oggEncoder = { id: descriptor.preset.id };
      mocks.oggCreate.mockResolvedValueOnce(oggEncoder);
      const ensureCodec = vi.fn().mockResolvedValue(undefined);
      const adapter = createMediaBunnyStreamEncoderAdapter(
        ensureCodec,
        mocks.oggCreate,
      );
      const configuration = createConfiguration({
        preset: descriptor.preset,
        rf64: null,
      });

      await expect(adapter.create(configuration)).resolves.toBe(oggEncoder);

      expect(mocks.oggCreate).toHaveBeenCalledOnce();
      expect(mocks.oggCreate).toHaveBeenCalledWith(
        configuration,
        descriptor.bitrate,
      );
      expect(ensureCodec).not.toHaveBeenCalled();
      expect(mocks.streamTargets).toHaveLength(0);
      expect(mocks.outputs).toHaveLength(0);
    },
  );

  it('uses an injected Ogg Opus factory for an external raw-WASM runtime', async () => {
    const oggEncoder = { id: 'external-ogg' };
    const createOgg = vi.fn().mockResolvedValue(oggEncoder);
    const adapter = createMediaBunnyStreamEncoderAdapter(vi.fn(), createOgg);
    const descriptor = OGG_OPUS_OUTPUT_PRESET_DESCRIPTORS[0]!;
    const configuration = createConfiguration({
      preset: descriptor.preset,
      rf64: null,
    });

    await expect(adapter.create(configuration)).resolves.toBe(oggEncoder);
    expect(createOgg).toHaveBeenCalledWith(
      configuration,
      descriptor.bitrate,
    );
    expect(mocks.oggCreate).not.toHaveBeenCalled();
  });

  it.each(AIFF_STREAM_OUTPUT_PRESET_DESCRIPTORS)(
    'routes $preset.id to the built-in seekable writer without MediaBunny allocation',
    async (descriptor) => {
      const ensureCodec = vi.fn().mockResolvedValue(undefined);
      const adapter = createMediaBunnyStreamEncoderAdapter(ensureCodec);
      const writes: AudioStreamOutputChunk[] = [];
      const writable = new WritableStream<AudioStreamOutputChunk>({
        write(chunk) {
          writes.push({
            data: Uint8Array.from(chunk.data),
            position: chunk.position,
            type: 'write',
          });
        },
      });
      const encoder = await adapter.create(
        createConfiguration({
          channels: 1,
          preset: descriptor.preset,
          rf64: null,
          writable,
        }),
      );

      await encoder.start();
      await encoder.write(new Float32Array([0.25]), 0);
      await encoder.finalize();

      expect(ensureCodec).not.toHaveBeenCalled();
      expect(mocks.streamTargets).toHaveLength(0);
      expect(mocks.outputs).toHaveLength(0);
      expect(writes[0]).toMatchObject({ position: 0 });
      expect(writes.at(-1)).toMatchObject({ position: 0 });
      expect(encoder.getBytesWritten()).toBe(
        54 + descriptor.bitDepth / 8 + (descriptor.bitDepth === 24 ? 1 : 0),
      );
    },
  );

  it('does not initialize either WASM codec for WAV', async () => {
    const ensureCodec = vi.fn().mockResolvedValue(undefined);
    const adapter = createMediaBunnyStreamEncoderAdapter(ensureCodec);

    await adapter.create(createConfiguration());

    expect(ensureCodec).not.toHaveBeenCalled();
  });

  it('rejects a pre-aborted configuration before loading a codec', async () => {
    const controller = new AbortController();
    controller.abort('pre-aborted');
    const ensureCodec = vi.fn().mockResolvedValue(undefined);
    const adapter = createMediaBunnyStreamEncoderAdapter(ensureCodec);

    await expect(
      adapter.create(createConfiguration({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(ensureCodec).not.toHaveBeenCalled();
    expect(mocks.outputs).toHaveLength(0);
  });

  it('cancels an encoder when construction aborts after allocation', async () => {
    const controller = new AbortController();
    mocks.addAudioTrack.mockImplementation(() => {
      controller.abort('allocated then blocked');
    });
    const adapter = createMediaBunnyStreamEncoderAdapter(
      vi.fn().mockResolvedValue(undefined),
    );

    await expect(
      adapter.create(createConfiguration({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(mocks.closeSource).toHaveBeenCalledOnce();
    expect(mocks.outputCancel).toHaveBeenCalledOnce();
  });

  it('waits for codec registration before allocating MediaBunny resources', async () => {
    let release: (() => void) | undefined;
    const ensureCodec = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const adapter = createMediaBunnyStreamEncoderAdapter(ensureCodec);
    const mp3 = STREAM_OUTPUT_PRESET_DESCRIPTORS.find(
      ({ format }) => format === 'mp3',
    );
    if (mp3 === undefined) {
      throw new Error('Expected an MP3 preset.');
    }

    const creation = adapter.create(createConfiguration({ preset: mp3.preset }));
    expect(mocks.streamTargets).toHaveLength(0);
    expect(mocks.outputs).toHaveLength(0);

    await vi.waitFor(() => expect(ensureCodec).toHaveBeenCalledOnce());
    release!();
    await expect(creation).resolves.toBeDefined();
    expect(mocks.streamTargets).toHaveLength(1);
    expect(mocks.outputs).toHaveLength(1);
  });

  it.each([
    ['AAC', AAC_OUTPUT_PRESET_DESCRIPTORS[0].preset],
    ['MP3', MP3_OUTPUT_PRESET_DESCRIPTORS[0].preset],
    ['FLAC', FLAC_OUTPUT_PRESET_DESCRIPTORS[0].preset],
  ])(
    'aborts pending %s registration promptly and does not block WAV creation',
    async (_format, preset) => {
      let rejectRegistration!: (error: Error) => void;
      const ensureCodec = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectRegistration = reject;
          }),
      );
      const adapter = createMediaBunnyStreamEncoderAdapter(ensureCodec);
      const controller = new AbortController();
      const creation = adapter.create(
        createConfiguration({ preset, signal: controller.signal }),
      );
      await vi.waitFor(() => expect(ensureCodec).toHaveBeenCalledOnce());

      controller.abort('registration stopped');
      await expect(creation).rejects.toMatchObject({
        code: 'OPERATION_ABORTED',
      });
      expect(mocks.outputs).toHaveLength(0);

      const wavEncoder = await adapter.create(createConfiguration());
      expect(ensureCodec).toHaveBeenCalledOnce();
      expect(mocks.outputs).toHaveLength(1);
      await wavEncoder.cancel();

      rejectRegistration(new Error('late registration failure'));
      await Promise.resolve();
      await Promise.resolve();
    },
  );

  it('continues after a live signal wins completed codec registration', async () => {
    const ensureCodec = vi.fn().mockResolvedValue(undefined);
    const adapter = createMediaBunnyStreamEncoderAdapter(ensureCodec);
    const controller = new AbortController();

    await expect(
      adapter.create(
        createConfiguration({
          preset: MP3_OUTPUT_PRESET_DESCRIPTORS[0].preset,
          signal: controller.signal,
        }),
      ),
    ).resolves.toBeDefined();
    expect(ensureCodec).toHaveBeenCalledOnce();
  });

  it.each([
    ['AAC', AAC_OUTPUT_PRESET_DESCRIPTORS[0].preset],
    ['MP3', MP3_OUTPUT_PRESET_DESCRIPTORS[0].preset],
    ['FLAC', FLAC_OUTPUT_PRESET_DESCRIPTORS[0].preset],
  ])(
    'aborts a never-settling %s MediaBunny startup promptly',
    async (_format, preset) => {
      const startup = deferred<void>();
      mocks.outputStart.mockReturnValueOnce(startup.promise);
      const controller = new AbortController();
      const adapter = createMediaBunnyStreamEncoderAdapter(
        vi.fn().mockResolvedValue(undefined),
        mocks.oggCreate,
        vi.fn(),
      );
      const encoder = await adapter.create(
        createConfiguration({ preset, signal: controller.signal }),
      );

      const pending = encoder.start();
      await vi.waitFor(() => expect(mocks.outputStart).toHaveBeenCalledOnce());
      controller.abort(`${_format} startup stopped`);

      await expect(pending).rejects.toMatchObject({
        code: 'OPERATION_ABORTED',
        message: `${_format} startup stopped`,
      });
      startup.reject(new Error(`late ${_format} startup failure`));
    },
  );

  it('awaits write backpressure and always closes the input sample', async () => {
    let release: (() => void) | undefined;
    mocks.addSample.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const encoder = await createEncoder({ channels: 2, sampleRate: 48_000 });
    const samples = new Float32Array([0.25, -0.25, 0.5, -0.5]);
    const source = current<MockAudioSampleSource>(mocks.audioSampleSources);

    const write = encoder.write(samples, 12_000);
    const sample = current<MockAudioSample>(mocks.audioSamples);
    expect(sample.config).toEqual({
      data: samples,
      format: 'f32',
      numberOfChannels: 2,
      sampleRate: 48_000,
      timestamp: 0.25,
    });
    expect(mocks.addSample).toHaveBeenCalledWith(source, sample);
    expect(sample.close).not.toHaveBeenCalled();

    release?.();
    await expect(write).resolves.toBeUndefined();
    expect(sample.close).toHaveBeenCalledOnce();
  });

  it('closes a sample when MediaBunny rejects the write', async () => {
    const failure = new Error('sample write failed');
    mocks.addSample.mockRejectedValue(failure);
    const encoder = await createEncoder();

    await expect(encoder.write(new Float32Array([0]), 0)).rejects.toBe(failure);
    expect(current<MockAudioSample>(mocks.audioSamples).close).toHaveBeenCalledOnce();
  });

  it('tracks the greatest random-access write end', async () => {
    const encoder = await createEncoder();
    const target = current<MockStreamTarget>(mocks.streamTargets);

    expect(encoder.getBytesWritten()).toBe(0);
    target.emitWrite(64);
    target.emitWrite(512);
    target.emitWrite(256);
    expect(encoder.getBytesWritten()).toBe(512);
  });

  it('closes the source before finalizing the output', async () => {
    const encoder = await createEncoder();
    const source = current<MockAudioSampleSource>(mocks.audioSampleSources);
    const output = current<MockOutput>(mocks.outputs);

    await expect(encoder.finalize()).resolves.toBeUndefined();
    expect(mocks.closeSource).toHaveBeenCalledWith(source);
    expect(mocks.outputFinalize).toHaveBeenCalledWith(output);
    expect(mocks.closeSource.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.outputFinalize.mock.invocationCallOrder[0]!,
    );
  });

  it('cancels resources when finalization fails', async () => {
    const failure = new Error('finalize failed');
    mocks.outputFinalize.mockRejectedValue(failure);
    const encoder = await createEncoder();

    await expect(encoder.finalize()).rejects.toBe(failure);
    expect(mocks.outputCancel).toHaveBeenCalledOnce();
  });

  it('cancels an active output and ignores cleanup failure', async () => {
    mocks.outputCancel.mockRejectedValue(new Error('cancel failed'));
    const encoder = await createEncoder();

    await expect(encoder.cancel()).resolves.toBeUndefined();
    expect(mocks.outputCancel).toHaveBeenCalledOnce();
  });

  it('closes encoder input resources only once across repeated cancellation', async () => {
    const encoder = await createEncoder();

    await encoder.cancel();
    await encoder.cancel();

    expect(mocks.closeSource).toHaveBeenCalledOnce();
    expect(mocks.outputCancel).toHaveBeenCalledTimes(2);
  });

  it.each(['canceled', 'finalized'] as const)(
    'does not cancel an already %s output',
    async (state) => {
      const encoder = await createEncoder();
      current<MockOutput>(mocks.outputs).state = state;

      await expect(encoder.cancel()).resolves.toBeUndefined();
      expect(mocks.outputCancel).not.toHaveBeenCalled();
    },
  );

  it('cancels partially-created output resources without masking the cause', async () => {
    const failure = new Error('track rejected');
    mocks.addAudioTrack.mockImplementation(() => {
      throw failure;
    });
    mocks.outputCancel.mockRejectedValue(new Error('cancel failed'));

    await expect(createEncoder()).rejects.toBe(failure);
    expect(mocks.outputCancel).toHaveBeenCalledOnce();
  });

  it('rejects an unsupported preset before registration or allocation', async () => {
    const preset: AudioOutputPreset = {
      ...DEFAULT_PRESET,
      id: 'wav-unknown',
    };
    const ensureCodec = vi.fn().mockResolvedValue(undefined);
    const adapter = createMediaBunnyStreamEncoderAdapter(ensureCodec);

    await expect(
      adapter.create(createConfiguration({ preset })),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      message: expect.stringContaining('preset "wav-unknown"'),
    });
    expect(ensureCodec).not.toHaveBeenCalled();
    expect(mocks.streamTargets).toHaveLength(0);
    expect(mocks.outputs).toHaveLength(0);
    expect(mocks.audioSampleSources).toHaveLength(0);
  });

  it.each([
    {
      channels: 3,
      preset: MP3_OUTPUT_PRESET_DESCRIPTORS[0].preset,
      sampleRate: 48_000,
    },
    {
      channels: 2,
      preset: MP3_OUTPUT_PRESET_DESCRIPTORS[0].preset,
      sampleRate: 96_000,
    },
    {
      channels: 9,
      preset: FLAC_OUTPUT_PRESET_DESCRIPTORS[0].preset,
      sampleRate: 48_000,
    },
    {
      channels: 2,
      preset: FLAC_OUTPUT_PRESET_DESCRIPTORS[0].preset,
      sampleRate: 11_025,
    },
  ])(
    'rejects unsupported $preset.id boundaries at $channels channels/$sampleRate Hz before loading WASM',
    async ({ channels, preset, sampleRate }) => {
      const ensureCodec = vi.fn().mockResolvedValue(undefined);
      const adapter = createMediaBunnyStreamEncoderAdapter(ensureCodec);

      await expect(
        adapter.create(
          createConfiguration({ channels, preset, sampleRate }),
        ),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_OUTPUT',
        message: expect.stringContaining(
          `${channels} channels at ${sampleRate} Hz`,
        ),
      });
      expect(ensureCodec).not.toHaveBeenCalled();
      expect(mocks.streamTargets).toHaveLength(0);
      expect(mocks.outputs).toHaveLength(0);
    },
  );
});

async function createEncoder(
  overrides: Partial<AudioStreamEncoderConfiguration> = {},
) {
  const adapter = createMediaBunnyStreamEncoderAdapter(
    vi.fn().mockResolvedValue(undefined),
  );
  return adapter.create(createConfiguration(overrides));
}

function createConfiguration(
  overrides: Partial<AudioStreamEncoderConfiguration> = {},
): AudioStreamEncoderConfiguration {
  return {
    channels: 2,
    outputChunkBytes: 64 * 1024,
    preset: DEFAULT_PRESET,
    rf64: false,
    sampleRate: 48_000,
    writable: createWritable(),
    ...overrides,
  };
}

function createWritable(): WritableStream<AudioStreamOutputChunk> {
  return new WritableStream<AudioStreamOutputChunk>();
}

function current<T>(items: readonly unknown[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error('Expected a current MediaBunny mock instance.');
  }
  return item as T;
}

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
