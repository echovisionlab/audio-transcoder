import {
  AdtsOutputFormat,
  AudioSample,
  AudioSampleSource,
  FlacOutputFormat,
  Mp3OutputFormat,
  Output,
  StreamTarget,
  WavOutputFormat,
  type AudioEncodingConfig,
} from 'mediabunny';
import {
  findStreamOutputPresetDescriptor,
  isStreamOutputConfigurationSupported,
  type StreamOutputPresetDescriptor,
} from '../../codecs/stream-output-presets.js';
import { AudioTranscoderError } from '../../errors.js';
import { createOperationAbortedError } from '../../engine/operation-errors.js';
import { raceWithOperationAbort } from '../abortable-operation.js';
import type {
  AudioStreamEncoder,
  AudioStreamEncoderAdapter,
  AudioStreamEncoderConfiguration,
} from './contracts.js';
import { DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS } from './ids.js';
import {
  type EnsureMediaBunnyCodecRegistered,
  type MediaBunnyBundledWasmOutputCodec,
} from './lazy-codec-registration.js';
import { createAiffStreamEncoder } from './aiff-stream-encoder.js';
import type { OggOpusStreamEncoderFactory } from './ogg-opus-stream-encoder.js';

type MediaBunnyOutputPresetDescriptor = StreamOutputPresetDescriptor & {
  readonly encoding: Readonly<AudioEncodingConfig>;
  readonly format: 'aac' | 'flac' | 'mp3' | 'wav';
  readonly wasmCodec: MediaBunnyBundledWasmOutputCodec | null;
};

export type BindMediaBunnyCodecConfiguration = (
  codec: MediaBunnyBundledWasmOutputCodec,
  config: AudioEncoderConfig,
  signal?: AbortSignal,
) => void;

export function createMediaBunnyStreamEncoderAdapter(
  ensureCodecRegistered: EnsureMediaBunnyCodecRegistered,
  createOggOpusEncoder: OggOpusStreamEncoderFactory =
    missingOggOpusEncoder,
  bindCodecConfiguration: BindMediaBunnyCodecConfiguration =
    missingCodecConfigurationBinding,
): AudioStreamEncoderAdapter {
  return Object.freeze({
    id: DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS.encoderAdapter,
    async create(
      configuration: AudioStreamEncoderConfiguration,
    ): Promise<AudioStreamEncoder> {
      throwIfAborted(configuration.signal);
      const descriptor = resolvePreset(configuration.preset.id);
      if (
        !isStreamOutputConfigurationSupported(
          descriptor,
          configuration.channels,
          configuration.sampleRate,
        )
      ) {
        throw new AudioTranscoderError(
          'UNSUPPORTED_OUTPUT',
          `Preset "${descriptor.preset.id}" does not support ${configuration.channels} channels at ${configuration.sampleRate} Hz.`,
        );
      }
      const wasmCodec = descriptor.wasmCodec;
      if (wasmCodec !== null && wasmCodec !== 'ogg-opus') {
        const registration = Promise.resolve().then(() =>
          ensureCodecRegistered(wasmCodec),
        );
        await waitForCodecRegistration(registration, configuration.signal);
      }
      throwIfAborted(configuration.signal);
      if (descriptor.format === 'aiff') {
        if (
          descriptor.kind !== 'lossless' ||
          (descriptor.bitDepth !== 16 && descriptor.bitDepth !== 24)
        ) {
          throw new AudioTranscoderError(
            'UNSUPPORTED_OUTPUT',
            `Preset "${descriptor.preset.id}" is not supported by the AIFF stream writer.`,
          );
        }
        return createAiffStreamEncoder(configuration, descriptor.bitDepth);
      }
      if (descriptor.format === 'ogg') {
        if (descriptor.kind !== 'lossy') {
          throw new AudioTranscoderError(
            'UNSUPPORTED_OUTPUT',
            `Preset "${descriptor.preset.id}" is not supported by the Ogg Opus stream writer.`,
          );
        }
        return createOggOpusEncoder(configuration, descriptor.bitrate);
      }
      const encoder = await createMediaBunnyEncoder(
        configuration,
        descriptor,
        bindCodecConfiguration,
      );
      if (configuration.signal?.aborted) {
        const error = createOperationAbortedError(configuration.signal);
        await encoder.cancel(error);
        throw error;
      }
      return encoder;
    },
  });
}

async function missingOggOpusEncoder(): Promise<AudioStreamEncoder> {
  throw new AudioTranscoderError(
    'INVALID_CONFIGURATION',
    'The Ogg Opus encoder requires an explicit raw-WASM factory.',
  );
}

function missingCodecConfigurationBinding(
  codec: MediaBunnyBundledWasmOutputCodec,
): never {
  throw new AudioTranscoderError(
    'INVALID_CONFIGURATION',
    `The ${codec.toUpperCase()} encoder requires an explicit runtime configuration binding.`,
  );
}

async function createMediaBunnyEncoder(
  configuration: AudioStreamEncoderConfiguration,
  descriptor: StreamOutputPresetDescriptor,
  bindCodecConfiguration: BindMediaBunnyCodecConfiguration,
): Promise<AudioStreamEncoder> {
  if (descriptor.encoding === null) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_OUTPUT',
      `Preset "${descriptor.preset.id}" requires a built-in stream writer.`,
    );
  }
  const mediaBunnyDescriptor = descriptor as MediaBunnyOutputPresetDescriptor;
  const streamTarget = new StreamTarget(configuration.writable, {
    chunked: true,
    chunkSize: configuration.outputChunkBytes,
  });
  let bytesWritten = 0;
  streamTarget.on('write', ({ end }) => {
    bytesWritten = Math.max(bytesWritten, end);
  });

  const output = new Output({
    format: createOutputFormat(mediaBunnyDescriptor, configuration.rf64),
    target: streamTarget,
  });

  try {
    const source = new AudioSampleSource(
      createMediaBunnyEncodingConfiguration(
        mediaBunnyDescriptor,
        bindCodecConfiguration,
        configuration.signal,
      ),
    );
    let sourceClosed = false;
    const closeSource = (): void => {
      if (!sourceClosed) {
        sourceClosed = true;
        source.close();
      }
    };
    output.addAudioTrack(source);

    const cancel = async (): Promise<void> => {
      closeSource();
      if (output.state !== 'canceled' && output.state !== 'finalized') {
        await raceWithOperationAbort(
          output.cancel(),
          configuration.signal,
        ).catch(() => undefined);
      }
    };

    return {
      cancel,
      async finalize(): Promise<void> {
        try {
          throwIfAborted(configuration.signal);
          closeSource();
          await raceWithOperationAbort(
            output.finalize(),
            configuration.signal,
          );
          throwIfAborted(configuration.signal);
        } catch (error) {
          await cancel();
          throw error;
        }
      },
      getBytesWritten: () => bytesWritten,
      async start(): Promise<void> {
        throwIfAborted(configuration.signal);
        await raceWithOperationAbort(output.start(), configuration.signal);
        throwIfAborted(configuration.signal);
      },
      async write(samples, frameOffset): Promise<void> {
        throwIfAborted(configuration.signal);
        const sample = new AudioSample({
          data: samples,
          format: 'f32',
          numberOfChannels: configuration.channels,
          sampleRate: configuration.sampleRate,
          timestamp: frameOffset / configuration.sampleRate,
        });
        try {
          await raceWithOperationAbort(
            source.add(sample),
            configuration.signal,
          );
          throwIfAborted(configuration.signal);
        } finally {
          sample.close();
        }
      },
    };
  } catch (error) {
    await raceWithOperationAbort(
      output.cancel(),
      configuration.signal,
    ).catch(() => undefined);
    throw error;
  }
}

function createMediaBunnyEncodingConfiguration(
  descriptor: MediaBunnyOutputPresetDescriptor,
  bindCodecConfiguration: BindMediaBunnyCodecConfiguration,
  signal: AbortSignal | undefined,
): Readonly<AudioEncodingConfig> {
  const codec = descriptor.wasmCodec;
  if (codec === null) {
    return descriptor.encoding;
  }
  const onEncoderConfig = descriptor.encoding.onEncoderConfig;
  return {
    ...descriptor.encoding,
    onEncoderConfig(config): void {
      onEncoderConfig?.(config);
      bindCodecConfiguration(codec, config, signal);
    },
  };
}

async function waitForCodecRegistration(
  registration: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await registration;
    return;
  }
  throwIfAborted(signal);
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = (): void => reject(createOperationAbortedError(signal));
    signal.addEventListener('abort', abort, { once: true });
  });
  void registration.catch(() => undefined);
  try {
    await Promise.race([registration, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createOperationAbortedError(signal);
  }
}

function createOutputFormat(
  descriptor: MediaBunnyOutputPresetDescriptor,
  rf64: boolean | null,
): AdtsOutputFormat | FlacOutputFormat | Mp3OutputFormat | WavOutputFormat {
  switch (descriptor.format) {
    case 'aac':
      return new AdtsOutputFormat();
    case 'flac':
      return new FlacOutputFormat({ appendOnly: false });
    case 'mp3':
      return new Mp3OutputFormat({ xingHeader: true });
    case 'wav':
      return new WavOutputFormat({ large: rf64 === true });
  }
}

function resolvePreset(presetId: string): StreamOutputPresetDescriptor {
  const descriptor = findStreamOutputPresetDescriptor(presetId);
  if (descriptor === undefined) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_OUTPUT',
      `The MediaBunny adapter does not support preset "${presetId}".`,
    );
  }
  return descriptor;
}
