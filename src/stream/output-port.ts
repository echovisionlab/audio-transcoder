import type { AudioStreamOutput, AudioStreamOutputChunk } from './contracts.js';
import type { AudioStreamWorkerOutputPort } from './protocol.js';
import type { SerializedWorkerError } from '../worker/protocol.js';
import { deserializeWorkerError, serializeWorkerError } from '../worker/serialized-error.js';

// WritableStream transfer is not implemented consistently across supported
// browsers. This protocol keeps the stream on its owning thread and transfers
// only a MessagePort, with one acknowledgement per write for backpressure.
type OutputPortRequest =
  | { readonly chunk: AudioStreamOutputChunk; readonly id: number; readonly type: 'write' }
  | { readonly id: number; readonly type: 'close' }
  | { readonly error: SerializedWorkerError; readonly id: number; readonly type: 'abort' };

type OutputPortResponse =
  | { readonly id: number; readonly type: 'ack' }
  | { readonly error: SerializedWorkerError; readonly id: number; readonly type: 'error' }
  | { readonly error: SerializedWorkerError; readonly type: 'bridge-error' };

export type OutputBridgeFailureOrigin =
  | 'client-abort'
  | 'destination-close'
  | 'destination-write'
  | 'worker-output-abort';

export interface OutputBridgeFailure {
  readonly origin: OutputBridgeFailureOrigin;
  readonly reason: unknown;
  readonly status: 'failed';
}

export type OutputBridgeSettlement =
  | OutputBridgeFailure
  | { readonly reason: undefined; readonly status: 'closed' };

export type OutputBridgeReadiness =
  | OutputBridgeFailure
  | { readonly status: 'ready' };

export interface MessagePortOutputBridge {
  abort(reason: unknown): Promise<void>;
  commit(): Promise<OutputBridgeSettlement>;
  readonly completion: Promise<OutputBridgeSettlement>;
  readonly ready: Promise<OutputBridgeReadiness>;
  readonly requestOutput: AudioStreamWorkerOutputPort;
  readonly transfer: Transferable[];
}

export function createMessagePortOutputBridge(output: AudioStreamOutput): MessagePortOutputBridge {
  if (!(output instanceof WritableStream) || output.locked) {
    throw new TypeError('Streaming output must be an unlocked WritableStream.');
  }
  const channel = new MessageChannel();
  const writer = output.getWriter();
  let abortPromise: Promise<void> | undefined;
  let readinessState: OutputBridgeReadiness | undefined;
  let settled = false;
  let resolveReady!: (value: OutputBridgeReadiness) => void;
  let resolveCompletion!: (value: OutputBridgeSettlement) => void;
  const ready = new Promise<OutputBridgeReadiness>((resolve) => {
    resolveReady = resolve;
  });
  const completion = new Promise<OutputBridgeSettlement>((resolve) => {
    resolveCompletion = resolve;
  });

  const setReadiness = (value: OutputBridgeReadiness): void => {
    if (readinessState === undefined) {
      readinessState = value;
      resolveReady(value);
    }
  };
  const settle = (value: OutputBridgeSettlement): void => {
    if (settled) return;
    settled = true;
    channel.port1.close();
    writer.releaseLock();
    resolveCompletion(value);
  };
  const fail = (
    reason: unknown,
    origin: OutputBridgeFailureOrigin,
  ): void => {
    const failure = { origin, reason, status: 'failed' } as const;
    setReadiness(failure);
    settle(failure);
  };
  const post = (message: OutputPortResponse): void => channel.port1.postMessage(message);

  channel.port1.onmessage = (event: MessageEvent<OutputPortRequest>) => {
    const message = event.data;
    void (async () => {
      try {
        if (message.type === 'write') {
          await writer.write(message.chunk);
          post({ id: message.id, type: 'ack' });
          return;
        }
        if (message.type === 'close') {
          setReadiness({ status: 'ready' });
          post({ id: message.id, type: 'ack' });
          return;
        }
        const reason = deserializeWorkerError(message.error);
        const aborting = writer.abort(reason);
        post({ id: message.id, type: 'ack' });
        fail(reason, 'worker-output-abort');
        await aborting.catch(() => undefined);
      } catch (error) {
        try {
          post({ error: serializeWorkerError(error), id: message.id, type: 'error' });
        } catch {
          // The local destination failure is already authoritative.
        }
        if (!settled) {
          fail(error, message.type === 'write' ? 'destination-write' : 'worker-output-abort');
        }
      }
    })();
  };
  channel.port1.onmessageerror = () => {
    const error = new Error('Unreadable output bridge message.');
    const aborting = writer.abort(error);
    fail(error, 'destination-write');
    void aborting.catch(() => undefined);
  };
  channel.port1.start();

  const abort = (reason: unknown): Promise<void> => {
    if (abortPromise === undefined) {
      if (settled) {
        abortPromise = Promise.resolve();
      } else {
        const aborting = writer.abort(reason);
        try {
          post({ error: serializeWorkerError(reason), type: 'bridge-error' });
        } catch {
          // Closing the port below is still terminal.
        }
        fail(reason, 'client-abort');
        abortPromise = aborting;
      }
    }
    return abortPromise;
  };
  const commit = async (): Promise<OutputBridgeSettlement> => {
    try {
      await writer.close();
      settle({ reason: undefined, status: 'closed' });
    } catch (error) {
      fail(error, 'destination-close');
    }
    return completion;
  };

  return {
    abort,
    commit,
    completion,
    ready,
    requestOutput: { port: channel.port2, type: 'message-port' },
    transfer: [channel.port2],
  };
}

export function createMessagePortOutput(output: AudioStreamWorkerOutputPort): AudioStreamOutput {
  const port = output.port;
  const pending = new Map<number, { reject(reason: unknown): void; resolve(): void }>();
  let nextId = 1;
  let terminalError: unknown;

  const failPending = (error: unknown): void => {
    terminalError = error;
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
    port.close();
  };

  port.onmessage = (event: MessageEvent<OutputPortResponse>) => {
    const message = event.data;
    if (message.type === 'bridge-error') {
      failPending(deserializeWorkerError(message.error));
      return;
    }
    const operation = pending.get(message.id);
    if (operation === undefined) return;
    if (message.type === 'error') {
      failPending(deserializeWorkerError(message.error));
      return;
    }
    pending.delete(message.id);
    operation.resolve();
  };
  port.onmessageerror = () => failPending(new Error('Unreadable output bridge response.'));
  port.start();

  const send = (message: OutputPortRequest, transfer: Transferable[] = []): Promise<void> =>
    new Promise((resolve, reject) => {
      if (terminalError !== undefined) {
        reject(terminalError);
        return;
      }
      pending.set(message.id, { reject, resolve });
      try {
        port.postMessage(message, transfer);
      } catch (error) {
        failPending(error);
      }
    });

  return new WritableStream<AudioStreamOutputChunk>({
    async abort(reason) {
      const id = nextId++;
      try {
        await send({ error: serializeWorkerError(reason), id, type: 'abort' });
      } finally {
        port.close();
      }
    },
    async close() {
      const id = nextId++;
      try {
        await send({ id, type: 'close' });
      } finally {
        port.close();
      }
    },
    write(chunk) {
      const id = nextId++;
      // Do not detach a buffer the encoder may reuse. The copied buffer is
      // bounded by outputChunkBytes and is released after the write ack.
      const data = chunk.data.slice();
      return send(
        { chunk: { ...chunk, data }, id, type: 'write' },
        [data.buffer],
      );
    },
  });
}
