import { createAudioTranscoderCodecAssetProvider } from '../assets/audio-codec-assets.js';
import { AudioTranscoderError } from '../errors.js';
import { serializeWorkerError } from '../worker/serialized-error.js';
import { createAudioTranscoderStreamEngine } from './engine.js';
import type { AudioTranscoderStreamWorkerScope } from './expose-worker.js';
import { createStreamWorkerMessageHandler } from './host.js';
import type {
  AudioStreamWorkerAssetLoadState,
  AudioStreamWorkerRequest,
} from './protocol.js';
import { createDefaultAudioTranscoderStreamCodecRuntime } from './runtime/default.js';

/** Installs the package Worker whose external codec source must be configured. */
export function exposeDefaultAudioTranscoderStreamWorker(
  scope: AudioTranscoderStreamWorkerScope,
): void {
  let handleOperation:
    | ((event: MessageEvent<AudioStreamWorkerRequest>) => void)
    | undefined;

  scope.addEventListener('message', (event) => {
    const request = event.data;
    if (request.type !== 'configure') {
      if (handleOperation === undefined) {
        postConfigurationError(
          scope,
          new AudioTranscoderError(
            'INVALID_CONFIGURATION',
            'Configure codec assets before using the default audio stream Worker.',
          ),
        );
        return;
      }
      handleOperation(event);
      return;
    }

    if (handleOperation !== undefined) {
      postConfigurationError(
        scope,
        new AudioTranscoderError(
          'INVALID_CONFIGURATION',
          'The default audio stream Worker codec assets are already configured.',
        ),
      );
      return;
    }

    try {
      const assets = createAudioTranscoderCodecAssetProvider({
        ...(request.codecAssets.fallbackSources === undefined
          ? {}
          : { fallbackSources: request.codecAssets.fallbackSources }),
        source: request.codecAssets.source,
      });
      assets.subscribe((state) => {
        const serialized: AudioStreamWorkerAssetLoadState = {
          ...state,
          error:
            state.error === null
              ? null
              : { code: state.error.code, message: state.error.message },
        };
        scope.postMessage({ state: serialized, type: 'asset-state' });
      });
      const engine = createAudioTranscoderStreamEngine({
        codecRuntime: createDefaultAudioTranscoderStreamCodecRuntime(assets),
      });
      handleOperation = createStreamWorkerMessageHandler({
        engine,
        postMessage(message): void {
          scope.postMessage(message);
        },
      });
      scope.postMessage({ type: 'configured' });
    } catch (error) {
      postConfigurationError(
        scope,
        new AudioTranscoderError(
          'INVALID_CONFIGURATION',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  });
}

function postConfigurationError(
  scope: AudioTranscoderStreamWorkerScope,
  error: AudioTranscoderError,
): void {
  scope.postMessage({
    error: serializeWorkerError(error),
    type: 'configuration-error',
  });
}
