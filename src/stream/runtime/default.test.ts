import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockRegistration {
  readonly bind: ReturnType<typeof vi.fn>;
  readonly loadWasm: (
    signal?: AbortSignal,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  readonly register: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  adapters: [] as unknown[][],
  aacRegistrations: [] as MockRegistration[],
  createAacRegistration: vi.fn(),
  createEncoderAdapter: vi.fn(),
  createFlacRegistration: vi.fn(),
  createMp3Registration: vi.fn(),
  createOggFactory: vi.fn(),
  createRegistrar: vi.fn(),
  createResamplerFactory: vi.fn(),
  flacRegistrations: [] as MockRegistration[],
  mp3Registrations: [] as MockRegistration[],
  registrarLoaders: [] as Record<string, () => Promise<() => void>>[],
}));

vi.mock('../resampler.js', () => ({
  createStreamingResamplerFactory: mocks.createResamplerFactory,
}));
vi.mock('./bundled-aac-encoder.js', () => ({
  createBundledAacEncoderRegistration: mocks.createAacRegistration,
}));
vi.mock('./bundled-flac-encoder.js', () => ({
  createBundledFlacEncoderRegistration: mocks.createFlacRegistration,
}));
vi.mock('./bundled-mp3-encoder.js', () => ({
  createBundledMp3EncoderRegistration: mocks.createMp3Registration,
}));
vi.mock('./lazy-codec-registration.js', () => ({
  createLazyMediaBunnyCodecRegistrar: mocks.createRegistrar,
}));
vi.mock('./mediabunny-encoder.js', () => ({
  createMediaBunnyStreamEncoderAdapter: mocks.createEncoderAdapter,
}));
vi.mock('./ogg-opus-stream-encoder.js', () => ({
  createOggOpusStreamEncoderFactory: mocks.createOggFactory,
}));

import { createDefaultAudioTranscoderStreamCodecRuntime } from './default.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapters.length = 0;
  mocks.aacRegistrations.length = 0;
  mocks.flacRegistrations.length = 0;
  mocks.mp3Registrations.length = 0;
  mocks.registrarLoaders.length = 0;
  installRegistrationFactory(
    mocks.createAacRegistration,
    mocks.aacRegistrations,
  );
  installRegistrationFactory(
    mocks.createFlacRegistration,
    mocks.flacRegistrations,
  );
  installRegistrationFactory(
    mocks.createMp3Registration,
    mocks.mp3Registrations,
  );
  mocks.createRegistrar.mockImplementation((loaders) => {
    mocks.registrarLoaders.push(loaders);
    return vi.fn();
  });
  mocks.createEncoderAdapter.mockImplementation((...args) => {
    mocks.adapters.push(args);
    return { id: 'external-encoder' };
  });
  mocks.createOggFactory.mockImplementation((loadWasm) => loadWasm);
  mocks.createResamplerFactory.mockImplementation(
    (loadWasm) => async (
      _channels: number,
      _inputSampleRate: number,
      _outputSampleRate: number,
      signal?: AbortSignal,
    ) => {
      await loadWasm(signal);
      return null;
    },
  );
});

describe('default stream codec runtime', () => {
  it('routes every external codec and resampler to its manifest asset and signal', async () => {
    const load = vi.fn<
      (
        assetName: string,
        signal?: AbortSignal,
      ) => Promise<Uint8Array<ArrayBuffer>>
    >(async () => new Uint8Array([0, 97, 115, 109]));
    const assets = { load } as never;
    const signal = new AbortController().signal;

    const runtime = createDefaultAudioTranscoderStreamCodecRuntime(assets);

    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.inputs)).toBe(true);
    expect(Object.isFrozen(runtime.resampler)).toBe(true);
    expect(runtime.encoder).toEqual({ id: 'external-encoder' });

    const loaders = mocks.registrarLoaders[0]!;
    const registerAac = await loaders.aac!();
    registerAac();
    const registerFlac = await loaders.flac!();
    registerFlac();
    const registerMp3 = await loaders.mp3!();
    registerMp3();
    await mocks.aacRegistrations[0]!.loadWasm(signal);
    await mocks.flacRegistrations[0]!.loadWasm(signal);
    await mocks.mp3Registrations[0]!.loadWasm(signal);
    const createOgg = mocks.adapters[0]![1] as (
      signal?: AbortSignal,
    ) => Promise<Uint8Array<ArrayBuffer>>;
    await createOgg(signal);
    await runtime.resampler.create(2, 48_000, 44_100, 'fast', signal);
    await runtime.resampler.create(2, 48_000, 44_100, 'balanced', signal);
    await runtime.resampler.create(2, 48_000, 44_100, 'best', signal);

    expect(load.mock.calls).toEqual([
      ['aac', signal],
      ['flac', signal],
      ['mp3', signal],
      ['ogg-opus', signal],
      ['resampler-fast', signal],
      ['resampler-balanced', signal],
      ['resampler-best', signal],
    ]);
  });

  it('reuses loader identity for the same provider and isolates different providers', async () => {
    const firstProvider = { load: vi.fn() } as never;
    const secondProvider = { load: vi.fn() } as never;

    createDefaultAudioTranscoderStreamCodecRuntime(firstProvider);
    createDefaultAudioTranscoderStreamCodecRuntime(firstProvider);
    createDefaultAudioTranscoderStreamCodecRuntime(secondProvider);

    for (const loaders of mocks.registrarLoaders) {
      await loaders.aac!();
      await loaders.flac!();
      await loaders.mp3!();
    }

    for (const registrations of [
      mocks.aacRegistrations,
      mocks.flacRegistrations,
      mocks.mp3Registrations,
    ]) {
      expect(registrations).toHaveLength(3);
      expect(registrations[0]!.loadWasm).toBe(registrations[1]!.loadWasm);
      expect(registrations[2]!.loadWasm).not.toBe(
        registrations[0]!.loadWasm,
      );
    }
  });

  it('binds each runtime configuration through its own registration context', async () => {
    const assets = { load: vi.fn() } as never;
    createDefaultAudioTranscoderStreamCodecRuntime(assets);
    createDefaultAudioTranscoderStreamCodecRuntime(assets);

    const firstBind = mocks.adapters[0]![2] as (
      codec: 'aac' | 'flac' | 'mp3',
      config: AudioEncoderConfig,
      signal?: AbortSignal,
    ) => void;
    const secondBind = mocks.adapters[1]![2] as typeof firstBind;
    expect(() =>
      firstBind('aac', { codec: 'aac' } as AudioEncoderConfig),
    ).toThrow('used before its runtime binding was initialized');

    for (const loaders of mocks.registrarLoaders) {
      for (const codec of ['aac', 'flac', 'mp3'] as const) {
        const register = await loaders[codec]!();
        register();
      }
    }

    const firstConfig = { codec: 'aac' } as AudioEncoderConfig;
    const secondConfig = { codec: 'aac' } as AudioEncoderConfig;
    const firstSignal = new AbortController().signal;
    const secondSignal = new AbortController().signal;
    firstBind('aac', firstConfig, firstSignal);
    secondBind('aac', secondConfig, secondSignal);

    expect(mocks.aacRegistrations[0]!.bind).toHaveBeenCalledWith(
      firstConfig,
      firstSignal,
    );
    expect(mocks.aacRegistrations[0]!.bind.mock.calls[0]![0]).toBe(firstConfig);
    expect(mocks.aacRegistrations[1]!.bind).toHaveBeenCalledWith(
      secondConfig,
      secondSignal,
    );
    expect(mocks.aacRegistrations[1]!.bind.mock.calls[0]![0]).toBe(secondConfig);
  });
});

function installRegistrationFactory(
  factory: ReturnType<typeof vi.fn>,
  registrations: MockRegistration[],
): void {
  factory.mockImplementation((loadWasm) => {
    const registration = {
      bind: vi.fn(),
      loadWasm,
      register: vi.fn(),
    };
    registrations.push(registration);
    return registration;
  });
}
