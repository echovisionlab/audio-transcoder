import { describe, expect, it, vi } from 'vitest';
import type {
  AudioTranscoderCodecAssetId,
  AudioTranscoderCodecAssetProvider,
} from '../../assets/audio-codec-assets.js';
import type { AudioStreamOutputProbeTarget } from '../contracts.js';
import { createTestCodecAssetProvider } from '../codec-assets.test-support.js';
import { createAudioTranscoderStreamEngine } from '../engine.js';

const TARGETS = [
  {
    asset: 'aac',
    channels: 2,
    presetId: 'aac-128kbps',
    sampleRate: 48_000,
  },
  {
    asset: 'mp3',
    channels: 2,
    presetId: 'mp3-128kbps',
    sampleRate: 48_000,
  },
  {
    asset: 'flac',
    channels: 2,
    presetId: 'flac-16bit',
    sampleRate: 48_000,
  },
] as const satisfies readonly (AudioStreamOutputProbeTarget & {
  readonly asset: AudioTranscoderCodecAssetId;
})[];

describe('default runtime provider identity', () => {
  it.each(TARGETS)(
    'supports $asset from two direct engines sharing one provider',
    async ({ asset: _asset, ...target }) => {
      const provider = createTestCodecAssetProvider();
      const first = createAudioTranscoderStreamEngine({
        codecAssets: provider,
      });
      const second = createAudioTranscoderStreamEngine({
        codecAssets: provider,
      });

      await expect(first.probeOutputSupport(target)).resolves.toMatchObject({
        code: 'SUPPORTED',
        status: 'supported',
      });
      await expect(second.probeOutputSupport(target)).resolves.toMatchObject({
        code: 'SUPPORTED',
        status: 'supported',
      });
    },
  );

  it.each(TARGETS)(
    'does not reuse the first provider when a second $asset provider fails',
    async ({ asset, ...target }) => {
      const realProvider = createTestCodecAssetProvider();
      const failedLoad = vi.fn(
        async (
          _assetName: AudioTranscoderCodecAssetId,
          _signal?: AbortSignal,
        ): Promise<Uint8Array<ArrayBuffer>> => {
          throw new Error('second provider unavailable');
        },
      );
      const unavailableProvider = Object.freeze({
        ...realProvider,
        load: failedLoad,
      }) satisfies AudioTranscoderCodecAssetProvider;

      await expect(
        createAudioTranscoderStreamEngine({
          codecAssets: realProvider,
        }).probeOutputSupport(target),
      ).resolves.toMatchObject({ code: 'SUPPORTED', status: 'supported' });
      await expect(
        createAudioTranscoderStreamEngine({
          codecAssets: unavailableProvider,
        }).probeOutputSupport(target),
      ).resolves.toMatchObject({
        code: 'OUTPUT_RUNTIME_UNAVAILABLE',
        status: 'runtime-unavailable',
      });
      expect(failedLoad).toHaveBeenCalledOnce();
      expect(failedLoad.mock.calls[0]?.[0]).toBe(asset);
    },
  );

  it.each(TARGETS)(
    'aborts a pending $asset provider load and retries cleanly',
    async ({ asset, ...target }) => {
      const realProvider = createTestCodecAssetProvider();
      const loaderSignals: AbortSignal[] = [];
      let shouldHang = true;
      const load = vi.fn(
        (
          assetName: AudioTranscoderCodecAssetId,
          signal?: AbortSignal,
        ): Promise<Uint8Array<ArrayBuffer>> => {
          if (!shouldHang) return realProvider.load(assetName, signal);
          if (signal === undefined) {
            throw new Error('Expected a codec asset operation signal.');
          }
          loaderSignals.push(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(signal.reason),
              { once: true },
            );
          });
        },
      );
      const provider = Object.freeze({
        ...realProvider,
        load,
      }) satisfies AudioTranscoderCodecAssetProvider;
      const engine = createAudioTranscoderStreamEngine({
        codecAssets: provider,
      });
      const controller = new AbortController();
      const pending = engine.probeOutputSupport(target, {
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(loaderSignals).toHaveLength(1));

      controller.abort(`${asset} load stopped`);
      await expect(pending).rejects.toMatchObject({
        code: 'OPERATION_ABORTED',
        message: `${asset} load stopped`,
      });
      expect(loaderSignals[0]?.aborted).toBe(true);

      shouldHang = false;
      await expect(engine.probeOutputSupport(target)).resolves.toMatchObject({
        code: 'SUPPORTED',
        status: 'supported',
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(load.mock.calls.map(([assetName]) => assetName)).toEqual([
        asset,
        asset,
      ]);
    },
  );
});
