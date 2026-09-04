import type { AudioStreamOutput, AudioStreamOutputChunk } from './contracts.js';
import type { AudioStreamWorkerOutputPort } from './protocol.js';
import type { SerializedWorkerError } from '../worker/protocol.js';
import { deserializeWorkerError, serializeWorkerError } from '../worker/serialized-error.js';

type OutputPortRequest =
  | { readonly chunk: AudioStreamOutputChunk; readonly id: number; readonly type: 'write' }
  | { readonly id: number; readonly type: 'close' }
  | { readonly error: SerializedWorkerError; readonly id: number; readonly type: 'abort' };

type OutputPortResponse =
  | { readonly id: number; readonly type: 'ack' }
  | { readonly error: SerializedWorkerError; readonly id: number; readonly type: 'error' }
  | { readonly error: SerializedWorkerError; readonly type: 'bridge-error' };

export interface MessagePortOutputBridge {
  abort(reason: unknown): Promise<void>;
  commit(): Promise<Awaited<MessagePortOutputBridge['completion']>>;
  readonly completion: Promise<
    | {
        readonly origin: 'client-abort' | 'destination-close' | 'destination-write' | 'worker-output-abort';
        readonly reason: unknown;
        readonly status: 'failed';
      }
    | { readonly reason: undefined; readonly status: 'closed' }
  >;
  readonly ready: Promise<
    | {
        readonly origin: 'client-abort' | 'destination-close' | 'destination-write' | 'worker-output-abort';
        readonly reason: unknown;
        readonly status: 'failed';
      }
    | { readonly status: 'ready' }
  >;
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
  let readinessState: Awaited<MessagePortOutputBridge['ready']> | undefined;
  let settled = false;
  let resolveReady!: (value: Awaited<MessagePortOutputBridge['ready']>) => void;
  let resolveCompletion!: (value: Awaited<MessagePortOutputBridge['completion']>) => void;
  const ready = new Promise<Awaited<MessagePortOutputBridge['ready']>>((resolve) => {
    resolveReady = resolve;
  });
  const completion = new Promise<Awaited<MessagePortOutputBridge['completion']>>((resolve) => {
    resolveCompletion = resolve;
  });

  const setReadiness = (value: Awaited<MessagePortOutputBridge['ready']>): void => {
    if (readinessState === undefined) {
      readinessState = value;
      resolveReady(value);
    }
  };
  const settle = (value: Awaited<MessagePortOutputBridge['completion']>): void => {
    if (settled) return;
    settled = true;
    channel.port1.close();
    writer.releaseLock();
    resolveCompletion(value);
  };
  const fail = (
    reason: unknown,
    origin: 'client-abort' | 'destination-close' | 'destination-write' | 'worker-output-abort',
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
  channel.port1.onmessageerror = () => fail(new Error('Unreadable output bridge message.'), 'destination-write');
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
  const commit = async (): Promise<Awaited<MessagePortOutputBridge['completion']>> => {
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
  port.onmessage = (event: MessageEvent<OutputPortResponse>) => {
    const message = event.data;
    if (message.type === 'bridge-error') {
      terminalError = deserializeWorkerError(message.error);
      for (const operation of pending.values()) operation.reject(terminalError);
      pending.clear();
      port.close();
      return;
    }
    const operation = pending.get(message.id);
    if (operation === undefined) return;
    pending.delete(message.id);
    if (message.type === 'error') operation.reject(deserializeWorkerError(message.error));
    else operation.resolve();
  };
  port.onmessageerror = () => {
    const error = new Error('Unreadable output bridge response.');
    terminalError = error;
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
    port.close();
  };
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
        pending.delete(message.id);
        reject(error);
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
      await send({ id, type: 'close' });
    },
    write(chunk) {
      const id = nextId++;
      const data = chunk.data.slice();
      return send(
        { chunk: { ...chunk, data }, id, type: 'write' },
        [data.buffer],
      );
    },
  });
}
