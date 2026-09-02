import {
  AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
  createAudioTranscoderCodecAssetProvider,
} from '../assets/audio-codec-assets.js';
import { createSelfHostedRuntimeAssetSource } from '../assets/runtime-asset-provider.js';

const TEST_ASSET_BASE_URL = 'https://audio-transcoder.test/codec-assets';

/** Creates a verified provider backed by the checked-in raw integration assets. */
export function createTestCodecAssetProvider() {
  const assetFiles = new Map(
    Object.values(AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets).map(
      ({ path }) => [
        `${TEST_ASSET_BASE_URL}/${path}`,
        new URL(`../../codec-assets/${path}`, import.meta.url),
      ],
    ),
  );

  return createAudioTranscoderCodecAssetProvider({
    source: createSelfHostedRuntimeAssetSource(TEST_ASSET_BASE_URL),
    async fetch(input) {
      const url = input instanceof Request ? input.url : String(input);
      const file = assetFiles.get(url);
      if (file === undefined) {
        return new Response(null, { status: 404 });
      }
      // @ts-expect-error This test-only helper executes in Node under Vitest.
      const { readFile } = await import('node:fs/promises');
      const bytes = Uint8Array.from(await readFile(file));
      return new Response(bytes, {
        headers: { 'content-length': String(bytes.byteLength) },
      });
    },
  });
}
