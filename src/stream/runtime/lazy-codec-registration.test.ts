import { describe, expect, it, vi } from 'vitest';

import {
  createLazyMediaBunnyCodecRegistrar,
  type MediaBunnyBundledWasmOutputCodec,
  type MediaBunnyCodecRegistrationLoader,
  type MediaBunnyCodecRegistrationLoaders,
} from './lazy-codec-registration.js';

const MEDIABUNNY_CODECS = ['aac', 'flac', 'mp3'] as const;

describe('lazy MediaBunny codec registration', () => {
  it.each(MEDIABUNNY_CODECS)(
    'returns one in-flight successful %s initialization to concurrent callers',
    async (codec) => {
      let release: ((register: () => void) => void) | undefined;
      const register = vi.fn();
      const load = vi.fn(
        () =>
          new Promise<() => void>((resolve) => {
            release = resolve;
          }),
      );
      const ensureRegistered = createLazyMediaBunnyCodecRegistrar(
        loadersWith(codec, load),
      );

      const first = ensureRegistered(codec);
      const second = ensureRegistered(codec);
      expect(second).toBe(first);
      expect(load).not.toHaveBeenCalled();

      await Promise.resolve();
      expect(load).toHaveBeenCalledOnce();
      release?.(register);
      await expect(Promise.all([first, second])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(register).toHaveBeenCalledOnce();
      await expect(ensureRegistered(codec)).resolves.toBeUndefined();
      expect(load).toHaveBeenCalledOnce();
    },
  );

  it.each(MEDIABUNNY_CODECS)(
    'wraps a failed %s lazy load and allows a later retry',
    async (codec) => {
      const register = vi.fn();
      const load = vi
        .fn()
        .mockRejectedValueOnce(new Error('chunk unavailable'))
        .mockResolvedValueOnce(register);
      const ensureRegistered = createLazyMediaBunnyCodecRegistrar(
        loadersWith(codec, load),
      );

      const first = ensureRegistered(codec);
      await expect(first).rejects.toMatchObject({
        code: 'WORKER_FAILURE',
        message: `Failed to initialize the runtime-asset ${codec.toUpperCase()} encoder: chunk unavailable`,
      });

      const retry = ensureRegistered(codec);
      expect(retry).not.toBe(first);
      await expect(retry).resolves.toBeUndefined();
      expect(load).toHaveBeenCalledTimes(2);
      expect(register).toHaveBeenCalledOnce();
    },
  );

  it.each(MEDIABUNNY_CODECS)(
    'allows bundled %s registration to recover after a synchronous failure',
    async (codec) => {
      const register = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('registry unavailable');
        })
        .mockImplementationOnce(() => undefined);
      const load = vi.fn().mockResolvedValue(register);
      const ensureRegistered = createLazyMediaBunnyCodecRegistrar(
        loadersWith(codec, load),
      );

      const first = ensureRegistered(codec);
      await expect(first).rejects.toMatchObject({
        code: 'WORKER_FAILURE',
        message: `Failed to initialize the runtime-asset ${codec.toUpperCase()} encoder: registry unavailable`,
      });
      const retry = ensureRegistered(codec);
      expect(retry).not.toBe(first);
      await expect(retry).resolves.toBeUndefined();
      await expect(ensureRegistered(codec)).resolves.toBeUndefined();
      expect(load).toHaveBeenCalledTimes(2);
      expect(register).toHaveBeenCalledTimes(2);
    },
  );

  it('normalizes a non-Error loader rejection', async () => {
    const ensureRegistered = createLazyMediaBunnyCodecRegistrar(
      loadersWith('aac', vi.fn().mockRejectedValue('asset offline')),
    );

    await expect(ensureRegistered('aac')).rejects.toMatchObject({
      code: 'WORKER_FAILURE',
      message:
        'Failed to initialize the runtime-asset AAC encoder: asset offline',
    });
  });
});

function loadersWith(
  codec: MediaBunnyBundledWasmOutputCodec,
  loader: MediaBunnyCodecRegistrationLoader,
): MediaBunnyCodecRegistrationLoaders {
  const ready = async (): Promise<() => void> => () => undefined;
  return {
    aac: codec === 'aac' ? loader : ready,
    flac: codec === 'flac' ? loader : ready,
    mp3: codec === 'mp3' ? loader : ready,
  };
}
