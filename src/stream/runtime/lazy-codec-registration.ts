import { AudioTranscoderError } from '../../errors.js';
import type { BundledWasmOutputCodec } from '../../codecs/stream-output-presets.js';

export type MediaBunnyBundledWasmOutputCodec = Exclude<
  BundledWasmOutputCodec,
  'ogg-opus'
>;

export type MediaBunnyCodecRegistrationLoader = () => Promise<() => void>;

export type MediaBunnyCodecRegistrationLoaders = Readonly<
  Record<MediaBunnyBundledWasmOutputCodec, MediaBunnyCodecRegistrationLoader>
>;

export type EnsureMediaBunnyCodecRegistered = (
  codec: MediaBunnyBundledWasmOutputCodec,
) => Promise<void>;

/**
 * Creates a Worker-local, concurrency-safe extension registrar. Successful
 * registrations stay cached. A failed lazy module load may be retried by a
 * later output probe. Each runtime-asset registrar changes its global guard only
 * after registration succeeds, so synchronous registration failures are also
 * safe to retry.
 */
export function createLazyMediaBunnyCodecRegistrar(
  loaders: MediaBunnyCodecRegistrationLoaders,
): EnsureMediaBunnyCodecRegistered {
  const registrations = new Map<
    MediaBunnyBundledWasmOutputCodec,
    Promise<void>
  >();

  return (codec): Promise<void> => {
    const existing = registrations.get(codec);
    if (existing !== undefined) {
      return existing;
    }

    const initialization = Promise.resolve()
      .then(loaders[codec])
      .then(
        async (register) => {
          try {
            await register();
          } catch (error) {
            registrations.delete(codec);
            throw error;
          }
        },
        (error: unknown) => {
          registrations.delete(codec);
          throw error;
        },
      )
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        throw new AudioTranscoderError(
          'WORKER_FAILURE',
          `Failed to initialize the runtime-asset ${codec.toUpperCase()} encoder: ${reason}`,
        );
      });
    registrations.set(codec, initialization);
    return initialization;
  };
}
