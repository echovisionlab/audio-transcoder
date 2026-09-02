import { AudioTranscoderError } from '@echovisionlab/audio-transcoder';
import type {
  AudioStreamWorkerRequest,
  AudioStreamWorkerResponse,
} from '../../src/stream/protocol.js';
import { serializeWorkerError } from '../../src/worker/serialized-error.js';

globalThis.addEventListener(
  'message',
  (event: MessageEvent<AudioStreamWorkerRequest>) => {
    const request = event.data;
    if (request.type === 'configure') {
      post({ type: 'configured' });
      return;
    }
    if (request.type === 'cancel') {
      return;
    }

    post({
      error: serializeWorkerError(diagnosticError(request)),
      id: request.id,
      type: 'error',
    });
  },
);

function diagnosticError(
  request: Exclude<
    AudioStreamWorkerRequest,
    { readonly type: 'cancel' | 'configure' }
  >,
): unknown {
  if (request.type !== 'inspect') {
    return new Error(`Unexpected diagnostic operation: ${request.type}`);
  }
  switch (request.input.name) {
    case 'known':
      return new AudioTranscoderError(
        'UNSUPPORTED_OUTPUT',
        'RIFF cannot represent this output',
        { reason: 'target-size-limit' },
      );
    case 'unknown': {
      const error = new TypeError('codec bridge exploded');
      error.stack =
        'TypeError: codec bridge exploded\n    at worker-codec.js:4:2';
      return error;
    }
    case 'arbitrary':
      return {
        message: 'plain thrown diagnostic',
        name: 'CodecDiagnostic',
        stack: 'codec-diagnostic-stack',
      };
    default:
      return new Error(`Unknown diagnostic case: ${String(request.input.name)}`);
  }
}

function post(message: AudioStreamWorkerResponse): void {
  globalThis.postMessage(message);
}
