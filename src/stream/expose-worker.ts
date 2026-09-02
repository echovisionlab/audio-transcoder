import type { AudioTranscoderStreamEngine } from './contracts.js';
import { createStreamWorkerMessageHandler } from './host.js';
import type {
  AudioStreamWorkerRequest,
  AudioStreamWorkerResponse,
} from './protocol.js';

export interface AudioTranscoderStreamWorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<AudioStreamWorkerRequest>) => void,
  ): void;
  postMessage(message: AudioStreamWorkerResponse): void;
}

/** Connects an engine created inside a custom Worker to the public client API. */
export function exposeAudioTranscoderStreamWorker(
  engine: AudioTranscoderStreamEngine,
  scope: AudioTranscoderStreamWorkerScope,
): void {
  const handleMessage = createStreamWorkerMessageHandler({
    engine,
    postMessage(message): void {
      scope.postMessage(message);
    },
  });
  scope.addEventListener('message', handleMessage);
}
