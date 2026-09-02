import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
  AUDIO_TRANSCODER_CODEC_ASSET_BASE_PATH,
  AUDIO_TRANSCODER_CODEC_ASSET_REPOSITORY,
  createAudioTranscoderCodecAssetProvider,
  createAudioTranscoderJsDelivrAssetSource,
  type AudioTranscoderCodecAssetId,
} from './audio-codec-assets.js';
import { createSelfHostedRuntimeAssetSource } from './runtime-asset-provider.js';

describe('audio codec assets', () => {
  it('locks the opt-in jsDelivr source to the engine release', () => {
    const source = createAudioTranscoderJsDelivrAssetSource();

    expect(source).toEqual({
      basePath: AUDIO_TRANSCODER_CODEC_ASSET_BASE_PATH,
      kind: 'jsdelivr-github',
      repository: AUDIO_TRANSCODER_CODEC_ASSET_REPOSITORY,
      tag: `v${AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version}`,
    });
    expect(AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST).toMatchObject({
      abiVersion: 1,
      schemaVersion: 1,
    });
    expect(Object.isFrozen(AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST)).toBe(true);
    expect(
      Object.isFrozen(AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets),
    ).toBe(true);
    expect(
      Object.values(AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets).every(
        Object.isFrozen,
      ),
    ).toBe(true);
  });

  it('creates a typed provider without fetching eagerly', () => {
    const fetchAsset = vi.fn<typeof fetch>();
    const provider = createAudioTranscoderCodecAssetProvider({
      fetch: fetchAsset,
      source: createSelfHostedRuntimeAssetSource('/codec-assets'),
    });

    expect(provider.resolveUrl('aac')).toBe('/codec-assets/wasm/aac.wasm');
    expect(provider.resolveUrls('aac')).toEqual([
      '/codec-assets/wasm/aac.wasm',
    ]);
    expect(provider.getState('aac').phase).toBe('idle');
    expect(fetchAsset).not.toHaveBeenCalled();
    expectTypeOf<AudioTranscoderCodecAssetId>().toEqualTypeOf<
      | 'aac'
      | 'flac'
      | 'mp3'
      | 'ogg-opus'
      | 'resampler-fast'
      | 'resampler-balanced'
      | 'resampler-best'
    >();
  });

  it('accepts ordered fallback sources without requiring a custom fetch', () => {
    const provider = createAudioTranscoderCodecAssetProvider({
      fallbackSources: [
        createSelfHostedRuntimeAssetSource('/codec-assets-backup'),
      ],
      source: createSelfHostedRuntimeAssetSource('/codec-assets'),
    });

    expect(provider.resolveUrls('aac')).toEqual([
      '/codec-assets/wasm/aac.wasm',
      '/codec-assets-backup/wasm/aac.wasm',
    ]);
  });
});
