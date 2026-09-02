import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AIFF_OUTPUT_PRESETS,
  AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
  AUDIO_TRANSCODER_CODEC_ASSET_BASE_PATH,
  AUDIO_TRANSCODER_CODEC_ASSET_REPOSITORY,
  AUDIO_TRANSCODER_PACKAGE,
  AUDIO_TRANSCODER_VERSION,
  AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES,
  AUDIO_STREAM_AUTOMATIC_SAMPLE_RATE,
  AudioTranscoderError,
  WAV_OUTPUT_PRESETS,
  audioTranscoder,
  createAudioTranscoderEngine,
  createAudioTranscoderJsDelivrAssetSource,
  createSelfHostedRuntimeAssetSource,
  getAudioStreamOutputParameters,
  getAudioStreamOutputSampleRateOptions,
  getEngineInfo,
  getVersion,
  resolveAudioStreamFormatTarget,
  resolveAudioStreamSourceAwareFormatTarget,
  type AudioDecodeEstimate,
  type AudioOutputPreset,
  type AudioStreamBuiltInInputFormatDescriptor,
  type AudioStreamBuiltInOutputFormatDescriptor,
  type AudioStreamRuntimeAssetOutputFormatDescriptor,
  type AudioStreamInputFormatDescriptor,
  type AudioStreamInputFormatId,
  type AudioStreamBlobInput,
  type AudioStreamHttpCredentials,
  type AudioStreamHttpInput,
  type AudioStreamHttpSource,
  type AudioStreamInput,
  type AudioStreamInputSupportResult,
  type AudioStreamIntegerOutputPresetId,
  type AudioStreamLosslessOutputPresetDescriptor,
  type AudioStreamLossyOutputPresetDescriptor,
  type AudioStreamOutputParameterId,
  type AudioStreamOutputParameterSelection,
  type AudioStreamNonIntegerOutputPresetId,
  type AudioStreamNonWavTarget,
  type AudioStreamNonWavTranscodeResult,
  type AudioStreamOutputFormatDescriptor,
  type AudioStreamOutputFormatId,
  type AudioStreamOutputProbeTarget,
  type AudioStreamOutputPreset,
  type AudioStreamOutputPresetDescriptor,
  type AudioStreamOutputSupportResult,
  type AudioStreamOutputSampleRateConstraints,
  type AudioStreamOutputSampleRateOption,
  type AudioStreamOutputSampleRateOptionsResult,
  type AudioStreamOutputTargetConstraints,
  type AudioStreamProcessingPrecision,
  type AudioStreamRecognizedUnsupportedInputResult,
  type AudioStreamRuntimeInputFormatDescriptor,
  type AudioStreamSampleRateSelection,
  type AudioStreamSourceAwareSampleRateSelection,
  type AudioStreamSupportedInputResult,
  type AudioStreamSupportedOutputResult,
  type AudioStreamUnsupportedInputResult,
  type AudioStreamUnsupportedOutputConfigurationResult,
  type AudioStreamUnavailableOutputResult,
  type AudioStreamWavTarget,
  type AudioStreamWavTranscodeResult,
  type AudioTranscoderCustomStreamWorkerRuntimeOptions,
  type AudioTranscoderCodecAssetsConfiguration,
  type AudioTranscoderDefaultStreamWorkerRuntimeOptions,
  type AudioTranscoderPlugin,
  type AudioTranscoderStreamCapabilities,
  type AudioTranscoderStreamEngine,
  type AudioTranscoderStreamWorkerRuntimeOptions,
  type CreateAudioTranscoderStreamWorkerEngineOptions,
  type CreateAudioTranscoderStreamWorkerPoolOptions,
} from './index.js';
import { CodecRegistry } from './codecs/codec-registry.js';
import { DefaultAudioTranscoderEngine } from './engine/default-audio-transcoder-engine.js';

const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const UNKNOWN_INPUT = { data: new Uint8Array([1, 2, 3]).buffer };

describe('public package metadata', () => {
  it('exposes the package name and a semantic version', () => {
    expect(AUDIO_TRANSCODER_PACKAGE).toBe('@echovisionlab/audio-transcoder');
    expect(AUDIO_TRANSCODER_VERSION).toMatch(SEMANTIC_VERSION_PATTERN);
  });

  it('provides both engine and functional version APIs', () => {
    expect(audioTranscoder.getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
    expect(getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
  });

  it('exposes the whole-buffer safety limit', () => {
    expect(AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES).toBe(64 * 1024 * 1024);
  });

  it('exposes version-locked codec asset metadata without choosing a CDN', () => {
    expect(AUDIO_TRANSCODER_CODEC_ASSET_REPOSITORY).toBe(
      'echovisionlab/audio-transcoder',
    );
    expect(AUDIO_TRANSCODER_CODEC_ASSET_BASE_PATH).toBe('codec-assets');
    expect(AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version).toBe(
      AUDIO_TRANSCODER_VERSION,
    );
    expect(
      Object.keys(AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets).sort(),
    ).toEqual([
      'aac',
      'flac',
      'mp3',
      'ogg-opus',
      'resampler-balanced',
      'resampler-best',
      'resampler-fast',
    ]);
    expect(createAudioTranscoderJsDelivrAssetSource()).toEqual({
      basePath: 'codec-assets',
      kind: 'jsdelivr-github',
      repository: 'echovisionlab/audio-transcoder',
      tag: `v${AUDIO_TRANSCODER_VERSION}`,
    });
    expect(createSelfHostedRuntimeAssetSource('/codec-assets/')).toEqual({
      baseUrl: '/codec-assets',
      kind: 'self-hosted',
    });
  });

  it('returns stable, immutable engine information', () => {
    const info = getEngineInfo();

    expect(info).toBe(audioTranscoder.getInfo());
    expect(info).toEqual({
      name: AUDIO_TRANSCODER_PACKAGE,
      version: AUDIO_TRANSCODER_VERSION,
    });
    expect(Object.isFrozen(info)).toBe(true);
  });
});

describe('public stream type surface', () => {
  it('exports discovery, probe, target, and format-specific result contracts', () => {
    expectTypeOf<AudioStreamInput>().toMatchTypeOf<
      AudioStreamBlobInput | AudioStreamHttpInput
    >();
    expectTypeOf<AudioStreamHttpCredentials>().toEqualTypeOf<
      'include' | 'omit' | 'same-origin'
    >();
    expectTypeOf<AudioStreamHttpSource>().toMatchTypeOf<{
      readonly credentials?: AudioStreamHttpCredentials;
      readonly headers?: Readonly<Record<string, string>>;
      readonly size: number;
      readonly url: string;
    }>();
    expectTypeOf<AudioStreamInputFormatId>().toMatchTypeOf<string>();
    expectTypeOf<AudioStreamInputFormatDescriptor>().toMatchTypeOf<
      | AudioStreamBuiltInInputFormatDescriptor
      | AudioStreamRuntimeInputFormatDescriptor
    >();
    expectTypeOf<AudioStreamOutputFormatId>().toEqualTypeOf<
      'aac' | 'aiff' | 'flac' | 'mp3' | 'ogg' | 'wav'
    >();
    expectTypeOf<AudioStreamOutputFormatDescriptor>().toMatchTypeOf<
      | AudioStreamBuiltInOutputFormatDescriptor
      | AudioStreamRuntimeAssetOutputFormatDescriptor
    >();
    expectTypeOf<AudioStreamOutputPresetDescriptor>().toMatchTypeOf<
      | AudioStreamLosslessOutputPresetDescriptor
      | AudioStreamLossyOutputPresetDescriptor
    >();
    expectTypeOf<AudioStreamOutputPreset['id']>().toMatchTypeOf<string>();
    expectTypeOf<AudioStreamOutputParameterId>().toEqualTypeOf<
      'bit-depth' | 'bitrate-bps' | 'codec' | 'sample-format'
    >();
    expectTypeOf<AudioStreamOutputParameterSelection>().toMatchTypeOf<{
      readonly bitDepth?: number;
      readonly bitrateBps?: number;
      readonly codec?: string;
      readonly sampleFormat?: 'float' | 'integer' | 'lossy';
    }>();
    expectTypeOf(getAudioStreamOutputParameters).toBeFunction();
    expectTypeOf(getAudioStreamOutputSampleRateOptions).toBeFunction();
    expectTypeOf(resolveAudioStreamFormatTarget).toBeFunction();
    expectTypeOf(resolveAudioStreamSourceAwareFormatTarget).toBeFunction();
    expect(AUDIO_STREAM_AUTOMATIC_SAMPLE_RATE).toBe('automatic');
    expectTypeOf<AudioStreamSampleRateSelection>().toEqualTypeOf<
      'source' | number
    >();
    expectTypeOf<AudioStreamSourceAwareSampleRateSelection>().toEqualTypeOf<
      'automatic' | 'source' | number
    >();
    expectTypeOf<AudioStreamOutputSampleRateOption['status']>().toEqualTypeOf<
      'supported' | 'unsupported'
    >();
    expectTypeOf<
      AudioStreamOutputSampleRateOptionsResult['status']
    >().toEqualTypeOf<'resolved' | 'unsupported'>();
    expectTypeOf<AudioStreamOutputTargetConstraints['sampleRate']>().toEqualTypeOf<
      AudioStreamOutputSampleRateConstraints
    >();
    expectTypeOf<
      AudioStreamLosslessOutputPresetDescriptor['processingPrecision']
    >().toEqualTypeOf<AudioStreamProcessingPrecision>();
    expectTypeOf<AudioStreamInputSupportResult>().toMatchTypeOf<
      | AudioStreamRecognizedUnsupportedInputResult
      | AudioStreamSupportedInputResult
      | AudioStreamUnsupportedInputResult
    >();
    expectTypeOf<AudioStreamOutputProbeTarget>().toEqualTypeOf<{
      readonly channels: number;
      readonly presetId: AudioStreamOutputPreset['id'];
      readonly sampleRate: number;
    }>();
    expectTypeOf<AudioStreamOutputSupportResult>().toMatchTypeOf<
      | AudioStreamSupportedOutputResult
      | AudioStreamUnavailableOutputResult
      | AudioStreamUnsupportedOutputConfigurationResult
    >();
    expectTypeOf<
      Parameters<AudioTranscoderStreamEngine['probeOutputSupport']>[0]
    >().toEqualTypeOf<AudioStreamOutputProbeTarget>();
    expectTypeOf<
      Awaited<ReturnType<AudioTranscoderStreamEngine['probeOutputSupport']>>
    >().toEqualTypeOf<AudioStreamOutputSupportResult>();
    expectTypeOf<AudioStreamIntegerOutputPresetId>().toMatchTypeOf<string>();
    expectTypeOf<AudioStreamNonIntegerOutputPresetId>().toMatchTypeOf<string>();
    expectTypeOf<AudioStreamWavTarget['presetId']>().toMatchTypeOf<string>();
    expectTypeOf<AudioStreamNonWavTarget['presetId']>().toMatchTypeOf<string>();
    expectTypeOf<AudioStreamWavTranscodeResult['format']>().toEqualTypeOf<'wav'>();
    expectTypeOf<AudioStreamNonWavTranscodeResult['format']>().toEqualTypeOf<
      'aac' | 'aiff' | 'flac' | 'mp3' | 'ogg'
    >();
    expectTypeOf<AudioTranscoderStreamWorkerRuntimeOptions>()
      .toMatchTypeOf<
        | AudioTranscoderCustomStreamWorkerRuntimeOptions
        | AudioTranscoderDefaultStreamWorkerRuntimeOptions
      >();
    expectTypeOf<{
      runtime: 'default';
      codecAssets: AudioTranscoderCodecAssetsConfiguration;
      workerFactory: () => Worker;
    }>().toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<{
      runtime: 'custom';
      capabilities: AudioTranscoderStreamCapabilities;
      workerFactory: () => Worker;
    }>().toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<{
      runtime: 'custom';
      capabilities: AudioTranscoderStreamCapabilities;
      workerFactory: (workerIndex: number) => Worker;
    }>().toMatchTypeOf<CreateAudioTranscoderStreamWorkerPoolOptions>();
  });
});

describe('public plugin type surface', () => {
  it('exports the exact decoder preflight estimate contract', () => {
    expectTypeOf<AudioDecodeEstimate>().toEqualTypeOf<{
      readonly channels: number;
      readonly frames: number;
    }>();
  });
});

describe('built-in engine facade', () => {
  it('reports deterministic immutable capabilities', () => {
    const capabilities = audioTranscoder.getCapabilities();

    expect(capabilities.inspect).toEqual([
      'aif',
      'aifc',
      'aiff',
      'caf',
      'flac',
      'mp3',
      'wav',
    ]);
    expect(capabilities.decode).toEqual(['aif', 'aifc', 'aiff', 'caf', 'wav']);
    expect(capabilities.encode.map(({ id }) => id)).toEqual([
      'aiff-pcm16',
      'aiff-pcm24',
      'wav-float32',
      'wav-pcm16',
      'wav-pcm24',
      'wav-pcm32',
    ]);
    expect(capabilities.encode).toEqual(
      [...AIFF_OUTPUT_PRESETS, ...WAV_OUTPUT_PRESETS].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    );
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.inspect)).toBe(true);
    expect(Object.isFrozen(capabilities.decode)).toBe(true);
    expect(Object.isFrozen(capabilities.encode)).toBe(true);
    expect(Object.isFrozen(capabilities.encode[0])).toBe(true);
  });

  it('returns immutable unknown inspection details', () => {
    const withExtension = audioTranscoder.inspect({
      ...UNKNOWN_INPUT,
      name: 'recording.xyz',
    });
    const withoutExtension = audioTranscoder.inspect(UNKNOWN_INPUT);

    expect(withExtension.container).toBe('XYZ');
    expect(withExtension.decodeSupport).toBe('unknown');
    expect(withoutExtension.container).toBe('Unknown');
    expect(Object.isFrozen(withExtension)).toBe(true);
    expect(Object.isFrozen(withExtension.notes)).toBe(true);
  });

  it('rejects unsupported input and output with stable error codes', async () => {
    await expect(audioTranscoder.decode(UNKNOWN_INPUT)).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
      name: 'AudioTranscoderError',
    });
    await expect(
      audioTranscoder.encode(
        { channelData: [new Float32Array([0])], sampleRate: 48_000 },
        'missing',
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
  });
});

describe('plugin composition', () => {
  it('prioritizes plugins and supports async decode-to-encode transcoding', async () => {
    const preset = createTestPreset('test-output');
    const plugin: AudioTranscoderPlugin = {
      id: 'test-plugin',
      inspectors: [
        {
          formats: ['test'],
          id: 'test-inspector',
          inspect: () => ({
            bitDepth: 32,
            channels: 1,
            codec: 'Test PCM',
            container: 'TEST',
            decodeSupport: 'built-in',
            durationSeconds: 1,
            notes: ['plugin'],
            sampleRate: 1,
          }),
        },
      ],
      decoders: [
        {
          formats: ['test'],
          id: 'test-decoder',
          decode: async () => ({
            channelData: [new Float32Array([0.25])],
            durationSeconds: 1,
            sampleRate: 1,
            source: 'test decoder',
          }),
        },
      ],
      encoders: [
        {
          id: 'test-encoder',
          presets: [preset],
          encode: async (audio, selectedPreset) => ({
            data: new Uint8Array([audio.channelData.length]).buffer,
            preset: selectedPreset,
          }),
        },
      ],
    };
    const engine = createAudioTranscoderEngine({ plugins: [plugin] });

    const inspection = engine.inspect(UNKNOWN_INPUT);
    const decoded = await engine.decode(UNKNOWN_INPUT);
    const transcoded = await engine.transcode(UNKNOWN_INPUT, preset.id);

    expect(inspection.container).toBe('TEST');
    expect(Object.isFrozen(inspection.notes)).toBe(true);
    expect(decoded.source).toBe('test decoder');
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.channelData)).toBe(true);
    expect(new Uint8Array(transcoded.data)).toEqual(new Uint8Array([1]));
    expect(engine.getCapabilities().inspect).toContain('test');
    expect(engine.getCapabilities().encode).toContainEqual(preset);
  });

  it('creates independent facades over shared immutable metadata', () => {
    const first = createAudioTranscoderEngine();
    const second = createAudioTranscoderEngine();

    expect(first).not.toBe(second);
    expect(first.getInfo()).toEqual(second.getInfo());
    expect(first.getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
  });

  it.each([
    ['plugin', duplicatePluginOptions()],
    ['inspector adapter', duplicateInspectorOptions()],
    ['decoder adapter', duplicateDecoderOptions()],
    ['encoder adapter', duplicateEncoderOptions()],
    ['output preset', duplicatePresetOptions()],
  ])('rejects duplicate %s registrations', (_kind, options) => {
    expect(() => createAudioTranscoderEngine(options)).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_REGISTRATION' }),
    );
  });
});

describe('DefaultAudioTranscoderEngine', () => {
  it('takes an immutable snapshot of injected engine information', () => {
    const source = { name: 'test-engine', version: '1.2.3' };
    const registry = new CodecRegistry({
      decoders: [],
      encoders: [],
      inspectors: [],
    });
    const engine = new DefaultAudioTranscoderEngine(source, registry);

    source.name = 'changed';
    source.version = '9.9.9';

    expect(engine.getInfo()).toEqual({
      name: 'test-engine',
      version: '1.2.3',
    });
    expect(engine.getVersion()).toBe('1.2.3');
    expect(Object.isFrozen(engine.getInfo())).toBe(true);
  });
});

describe('AudioTranscoderError', () => {
  it('preserves its machine-readable code and message', () => {
    const error = new AudioTranscoderError('INVALID_AUDIO_DATA', 'bad input');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AudioTranscoderError');
    expect(error.code).toBe('INVALID_AUDIO_DATA');
    expect(error.message).toBe('bad input');
  });
});

function createTestPreset(id: string): AudioOutputPreset {
  return {
    bitDepth: null,
    container: 'test',
    extension: 'test',
    id,
    mimeType: 'audio/test',
    sampleFormat: 'lossy',
  };
}

function duplicatePluginOptions() {
  return { plugins: [{ id: 'same' }, { id: 'same' }] };
}

function duplicateInspectorOptions() {
  const inspector = {
    formats: ['test'],
    id: 'same-inspector',
    inspect: () => null,
  };
  return {
    plugins: [
      { id: 'one', inspectors: [inspector] },
      { id: 'two', inspectors: [inspector] },
    ],
  };
}

function duplicateDecoderOptions() {
  const decoder = {
    formats: ['test'],
    id: 'same-decoder',
    decode: () => null,
  };
  return {
    plugins: [
      { id: 'one', decoders: [decoder] },
      { id: 'two', decoders: [decoder] },
    ],
  };
}

function duplicateEncoderOptions() {
  const encoder = {
    id: 'same-encoder',
    presets: [createTestPreset('one'), createTestPreset('two')],
    encode: () => ({ data: new ArrayBuffer(0), preset: createTestPreset('one') }),
  };
  return {
    plugins: [
      { id: 'one', encoders: [encoder] },
      { id: 'two', encoders: [encoder] },
    ],
  };
}

function duplicatePresetOptions() {
  return {
    plugins: [
      {
        id: 'duplicate-preset',
        encoders: [
          {
            id: 'custom-encoder',
            presets: [createTestPreset('wav-pcm16')],
            encode: (_audio: unknown, preset: AudioOutputPreset) => ({
              data: new ArrayBuffer(0),
              preset,
            }),
          },
        ],
      },
    ],
  };
}
