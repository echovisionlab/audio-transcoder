import { createAudioTranscoderEngine } from '../engine/factory.js';
import { createWorkerMessageHandler } from './host.js';
import type { AudioWorkerRequest, AudioWorkerResponse } from './protocol.js';

interface AudioWorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<AudioWorkerRequest>) => void,
  ): void;
  postMessage(
    message: AudioWorkerResponse,
    transfer?: readonly Transferable[],
  ): void;
}

const scope = globalThis as unknown as AudioWorkerScope;
const handleMessage = createWorkerMessageHandler({
  engine: createAudioTranscoderEngine(),
  postMessage(message, transfer): void {
    scope.postMessage(message, transfer);
  },
});

scope.addEventListener('message', handleMessage);
