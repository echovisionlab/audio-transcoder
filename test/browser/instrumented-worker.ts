import type { AudioTranscoderStreamWorkerScope } from '@echovisionlab/audio-transcoder';
import { exposeDefaultAudioTranscoderStreamWorker } from '../../src/stream/default-worker-host.js';

interface ResourceEntriesRequest {
  readonly token: string;
  readonly type: 'browser-matrix:resource-entries';
}

interface ResourceEntriesResponse extends ResourceEntriesRequest {
  readonly entries: readonly string[];
}

const scope: AudioTranscoderStreamWorkerScope = {
  addEventListener(_type, listener): void {
    globalThis.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (isResourceEntriesRequest(event.data)) {
        globalThis.postMessage({
          entries: performance
            .getEntriesByType('resource')
            .map(({ name }) => name),
          token: event.data.token,
          type: event.data.type,
        } satisfies ResourceEntriesResponse);
        return;
      }
      listener(event as MessageEvent<never>);
    });
  },
  postMessage(message): void {
    globalThis.postMessage(message);
  },
};

exposeDefaultAudioTranscoderStreamWorker(scope);

function isResourceEntriesRequest(
  value: unknown,
): value is ResourceEntriesRequest {
  return (
    value !== null &&
    typeof value === 'object' &&
    'token' in value &&
    typeof value.token === 'string' &&
    'type' in value &&
    value.type === 'browser-matrix:resource-entries'
  );
}
