import type {
  AudioOperationOptions,
  AudioProgress,
  AudioTranscoderEngine,
} from '../engine/contracts.js';
import type {
  AudioWorkerRequest,
  AudioWorkerResponse,
  WorkerOperation,
} from './protocol.js';
import { serializeWorkerError } from './serialized-error.js';

interface CreateWorkerMessageHandlerOptions {
  readonly engine: AudioTranscoderEngine;
  postMessage(
    message: AudioWorkerResponse,
    transfer?: readonly Transferable[],
  ): void;
}

export function createWorkerMessageHandler(
  options: CreateWorkerMessageHandlerOptions,
): (event: MessageEvent<AudioWorkerRequest>) => void {
  const controllers = new Map<number, AbortController>();

  return (event): void => {
    const request = event.data;
    if (request.type === 'cancel') {
      controllers.get(request.id)?.abort();
      return;
    }

    const controller = new AbortController();
    controllers.set(request.id, controller);
    void executeOperation(options, request, controller.signal).finally(() => {
      controllers.delete(request.id);
    });
  };
}

async function executeOperation(
  options: CreateWorkerMessageHandlerOptions,
  request: Exclude<AudioWorkerRequest, { readonly type: 'cancel' }>,
  signal: AbortSignal,
): Promise<void> {
  try {
    const operationOptions: AudioOperationOptions = {
      onProgress: (progress: AudioProgress) => {
        options.postMessage({ id: request.id, progress, type: 'progress' });
      },
      signal,
      ...(request.unsafeAllowLargeBuffers === undefined
        ? {}
        : { unsafeAllowLargeBuffers: request.unsafeAllowLargeBuffers }),
    };

    if (request.type === 'decode') {
      const value = await options.engine.decode(request.input, operationOptions);
      options.postMessage(
        { id: request.id, operation: 'decode', type: 'result', value },
        transferableChannelBuffers(value.channelData),
      );
      return;
    }

    const operation: WorkerOperation = request.type;
    const value =
      request.type === 'encode'
        ? await options.engine.encode(
            request.audio,
            request.presetId,
            operationOptions,
          )
        : await options.engine.transcode(
            request.input,
            request.presetId,
            operationOptions,
          );
    options.postMessage(
      { id: request.id, operation, type: 'result', value },
      [value.data],
    );
  } catch (error) {
    options.postMessage({
      error: serializeWorkerError(error),
      id: request.id,
      type: 'error',
    });
  }
}

function transferableChannelBuffers(
  channelData: readonly Float32Array[],
): readonly Transferable[] {
  return [
    ...new Set(
      channelData
        .map(({ buffer }) => buffer)
        .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer),
    ),
  ];
}
