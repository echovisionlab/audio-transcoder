import type {
  AudioStreamInputAdapter,
  AudioStreamResamplerAdapter,
  AudioTranscoderStreamCodecRuntime,
} from './contracts.js';
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from '../capabilities.js';
import {
  inspectCustomPcmBlob,
  openCustomPcmBlobSource,
} from '../pcm-blob.js';
import {
  inspectMediaBlob,
  openMediaBlobSource,
  probeMediaBlobSupport,
} from '../media-source.js';
import { createStreamingResamplerFactory } from '../resampler.js';
import { DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS } from './ids.js';
import type { AudioTranscoderCodecAssetProvider } from '../../assets/audio-codec-assets.js';
import {
  createBundledAacEncoderRegistration,
  type BundledAacWasmLoader,
} from './bundled-aac-encoder.js';
import { createOggOpusStreamEncoderFactory } from './ogg-opus-stream-encoder.js';
import {
  createLazyMediaBunnyCodecRegistrar,
  type MediaBunnyBundledWasmOutputCodec,
} from './lazy-codec-registration.js';
import { createMediaBunnyStreamEncoderAdapter } from './mediabunny-encoder.js';

interface DefaultMediaBunnyCodecLoaders {
  readonly aac: BundledAacWasmLoader;
  readonly flac: (signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
  readonly mp3: (signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
}

const codecLoadersByAssetProvider = new WeakMap<
  object,
  DefaultMediaBunnyCodecLoaders
>();

const BUILT_IN_PCM_INPUT_ADAPTER = Object.freeze<AudioStreamInputAdapter>({
  id: DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS.inputAdapters[0],
  inspect: (input, context) => inspectCustomPcmBlob(input, context.signal),
  open: (input, context) =>
    openCustomPcmBlobSource(
      input,
      context.inputReadBytes,
      context.pcmChunkBytes,
      context.signal,
    ),
});

const MEDIABUNNY_INPUT_ADAPTER = Object.freeze<AudioStreamInputAdapter>({
  id: DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS.inputAdapters[1],
  inspect: (input, context) =>
    inspectMediaBlob(input, context.inputReadBytes, context.signal),
  open: (input, context) =>
    openMediaBlobSource(
      input,
      context.inputReadBytes,
      context.pcmChunkBytes,
      context.signal,
    ),
  probe: (input, context) =>
    probeMediaBlobSupport(input, context.inputReadBytes, context.signal),
});

/** Creates the default runtime backed only by explicitly supplied raw assets. */
export function createDefaultAudioTranscoderStreamCodecRuntime(
  assets: Pick<AudioTranscoderCodecAssetProvider, 'load'>,
): AudioTranscoderStreamCodecRuntime {
  const codecLoaders = getMediaBunnyCodecLoaders(assets);
  const binders = new Map<
    MediaBunnyBundledWasmOutputCodec,
    (config: AudioEncoderConfig, signal?: AbortSignal) => void
  >();
  const ensureCodecRegistered = createLazyMediaBunnyCodecRegistrar({
    async aac() {
      const registration = createBundledAacEncoderRegistration(
        codecLoaders.aac,
      );
      return () => {
        registration.register();
        binders.set('aac', registration.bind);
      };
    },
    async flac() {
      const extension = await import('./bundled-flac-encoder.js');
      const registration = extension.createBundledFlacEncoderRegistration(
        codecLoaders.flac,
      );
      return () => {
        registration.register();
        binders.set('flac', registration.bind);
      };
    },
    async mp3() {
      const extension = await import('./bundled-mp3-encoder.js');
      const registration = extension.createBundledMp3EncoderRegistration(
        codecLoaders.mp3,
      );
      return () => {
        registration.register();
        binders.set('mp3', registration.bind);
      };
    },
  });
  const createOggOpusEncoder = createOggOpusStreamEncoderFactory((signal) =>
    assets.load('ogg-opus', signal),
  );
  const resamplers = {
    balanced: createStreamingResamplerFactory((signal) =>
      assets.load('resampler-balanced', signal),
    ),
    best: createStreamingResamplerFactory((signal) =>
      assets.load('resampler-best', signal),
    ),
    fast: createStreamingResamplerFactory((signal) =>
      assets.load('resampler-fast', signal),
    ),
  } as const;
  const resampler = Object.freeze<AudioStreamResamplerAdapter>({
    id: DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS.resamplerAdapter,
    create(channels, inputSampleRate, outputSampleRate, quality, signal) {
      return resamplers[quality](
        channels,
        inputSampleRate,
        outputSampleRate,
        signal,
      );
    },
  });

  return Object.freeze({
    capabilities: AUDIO_TRANSCODER_STREAM_CAPABILITIES,
    encoder: createMediaBunnyStreamEncoderAdapter(
      ensureCodecRegistered,
      createOggOpusEncoder,
      (codec, config, signal) => {
        const bind = binders.get(codec);
        if (bind === undefined) {
          throw new Error(
            `The runtime-asset ${codec.toUpperCase()} encoder was used before its runtime binding was initialized.`,
          );
        }
        bind(config, signal);
      },
    ),
    inputs: Object.freeze([
      BUILT_IN_PCM_INPUT_ADAPTER,
      MEDIABUNNY_INPUT_ADAPTER,
    ]),
    resampler,
  });
}

function getMediaBunnyCodecLoaders(
  assets: Pick<AudioTranscoderCodecAssetProvider, 'load'>,
): DefaultMediaBunnyCodecLoaders {
  const existing = codecLoadersByAssetProvider.get(assets);
  if (existing !== undefined) return existing;
  const loaders = Object.freeze({
    aac: (signal?: AbortSignal) => assets.load('aac', signal),
    flac: (signal?: AbortSignal) => assets.load('flac', signal),
    mp3: (signal?: AbortSignal) => assets.load('mp3', signal),
  });
  codecLoadersByAssetProvider.set(assets, loaders);
  return loaders;
}
