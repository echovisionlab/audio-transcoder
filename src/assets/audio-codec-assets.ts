import {
  GENERATED_CODEC_ASSET_MANIFEST,
  GENERATED_CODEC_ASSET_BASE_PATH,
  GENERATED_CODEC_ASSET_REPOSITORY,
} from '../generated/codec-asset-metadata.js';
import {
  createJsDelivrGitHubRuntimeAssetSource,
  createRuntimeAssetProvider,
  type JsDelivrGitHubRuntimeAssetSource,
  type RuntimeAssetFetch,
  type RuntimeAssetLoadState,
  type RuntimeAssetProvider,
  type RuntimeAssetSource,
  type RuntimeAssetStateListener,
} from './runtime-asset-provider.js';

export const AUDIO_TRANSCODER_CODEC_ASSET_REPOSITORY =
  GENERATED_CODEC_ASSET_REPOSITORY;

export const AUDIO_TRANSCODER_CODEC_ASSET_BASE_PATH =
  GENERATED_CODEC_ASSET_BASE_PATH;

export const AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST =
  freezeCodecAssetManifest(GENERATED_CODEC_ASSET_MANIFEST);

export type AudioTranscoderCodecAssetId =
  keyof typeof AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets;

export interface AudioTranscoderCodecAssetProvider
  extends Omit<
    RuntimeAssetProvider,
    'getState' | 'load' | 'resolveUrl' | 'resolveUrls'
  > {
  getState(assetName: AudioTranscoderCodecAssetId): RuntimeAssetLoadState;
  load(
    assetName: AudioTranscoderCodecAssetId,
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>>;
  resolveUrl(assetName: AudioTranscoderCodecAssetId): string;
  resolveUrls(assetName: AudioTranscoderCodecAssetId): readonly string[];
}

export interface CreateAudioTranscoderCodecAssetProviderOptions {
  /** Explicitly selected by the application; no CDN is chosen implicitly. */
  readonly source: RuntimeAssetSource;
  readonly fallbackSources?: readonly RuntimeAssetSource[];
  readonly fetch?: RuntimeAssetFetch;
}

export interface AudioTranscoderCodecAssetsConfiguration {
  /** Primary source selected explicitly by the host application. */
  readonly source: RuntimeAssetSource;
  /** Optional same-manifest mirrors tried in order after the primary fails. */
  readonly fallbackSources?: readonly RuntimeAssetSource[];
  /** Receives Worker-local download, verification, readiness, and error state. */
  readonly onStateChange?: RuntimeAssetStateListener;
}

/**
 * Returns the version-locked jsDelivr source matching this engine package.
 * Applications still opt into it explicitly by passing the result to the
 * codec asset provider or Worker configuration.
 */
export function createAudioTranscoderJsDelivrAssetSource(): JsDelivrGitHubRuntimeAssetSource {
  return createJsDelivrGitHubRuntimeAssetSource(
    AUDIO_TRANSCODER_CODEC_ASSET_REPOSITORY,
    `v${AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version}`,
    AUDIO_TRANSCODER_CODEC_ASSET_BASE_PATH,
  );
}

export function createAudioTranscoderCodecAssetProvider(
  options: CreateAudioTranscoderCodecAssetProviderOptions,
): AudioTranscoderCodecAssetProvider {
  return createRuntimeAssetProvider({
    expectedAbiVersion: AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.abiVersion,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.fallbackSources === undefined
      ? {}
      : { fallbackSources: options.fallbackSources }),
    manifest: AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
    source: options.source,
  }) as AudioTranscoderCodecAssetProvider;
}

function freezeCodecAssetManifest<
  T extends typeof GENERATED_CODEC_ASSET_MANIFEST,
>(manifest: T): T {
  for (const descriptor of Object.values(manifest.assets)) {
    Object.freeze(descriptor);
  }
  Object.freeze(manifest.assets);
  return Object.freeze(manifest);
}
