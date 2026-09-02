import type {
  AudioStreamProgress,
  AudioTranscoderStreamEngine,
} from './contracts.js';
import type {
  AudioStreamWorkerRequest,
  AudioStreamWorkerResponse,
} from './protocol.js';
import { serializeWorkerError } from '../worker/serialized-error.js';
import { AudioTranscoderError } from '../errors.js';

interface CreateStreamWorkerMessageHandlerOptions {
  readonly engine: AudioTranscoderStreamEngine;
  postMessage(message: AudioStreamWorkerResponse): void;
}

interface QueuedRequest {
  readonly controller: AbortController;
  readonly request: Exclude<
    AudioStreamWorkerRequest,
    { readonly type: 'cancel' | 'configure' }
  >;
}

export function createStreamWorkerMessageHandler(
  options: CreateStreamWorkerMessageHandlerOptions,
): (event: MessageEvent<AudioStreamWorkerRequest>) => void {
  const controllers = new Map<number, AbortController>();
  const queue: QueuedRequest[] = [];
  let running = false;

  const drain = (): void => {
    if (running) {
      return;
    }
    const queued = queue.shift();
    if (queued === undefined) {
      return;
    }
    running = true;
    void executeOperation(
      options,
      queued.request,
      queued.controller.signal,
    ).finally(() => {
      controllers.delete(queued.request.id);
      running = false;
      drain();
    });
  };

  return (event): void => {
    const request = event.data;
    if (request.type === 'configure') {
      options.postMessage({
        error: serializeWorkerError(
          new AudioTranscoderError(
            'INVALID_CONFIGURATION',
            'A custom stream Worker cannot be configured with the package codec asset runtime.',
          ),
        ),
        type: 'configuration-error',
      });
      return;
    }
    if (request.type === 'cancel') {
      controllers.get(request.id)?.abort();
      return;
    }
    const controller = new AbortController();
    controllers.set(request.id, controller);
    queue.push({ controller, request });
    drain();
  };
}

async function executeOperation(
  options: CreateStreamWorkerMessageHandlerOptions,
  request: Exclude<
    AudioStreamWorkerRequest,
    { readonly type: 'cancel' | 'configure' }
  >,
  signal: AbortSignal,
): Promise<void> {
  try {
    const baseOptions = {
      ...('options' in request ? request.options : {}),
      signal,
    };
    const value = request.type === 'inspect'
      ? await options.engine.inspect(request.input, baseOptions)
      : request.type === 'probeInputSupport'
        ? await options.engine.probeInputSupport(request.input, baseOptions)
        : request.type === 'probeOutputSupport'
          ? await options.engine.probeOutputSupport(
              request.target,
              { signal },
            )
        : await options.engine.transcode(
            request.input,
            request.target,
            request.output,
            {
              ...baseOptions,
              onProgress(progress: AudioStreamProgress): void {
                options.postMessage({ id: request.id, progress, type: 'progress' });
              },
            },
          );
    options.postMessage({
      id: request.id,
      operation: request.type,
      type: 'result',
      value,
    } as AudioStreamWorkerResponse);
  } catch (error) {
    options.postMessage({
      error: serializeWorkerError(error),
      id: request.id,
      type: 'error',
    });
  }
}
