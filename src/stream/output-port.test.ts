import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMessagePortOutput,
  createMessagePortOutputBridge,
} from './output-port.js';

const CHUNK = Object.freeze({
  data: new Uint8Array([1, 2, 3]),
  position: 0,
  type: 'write' as const,
});

let latestChannel: MessageChannelStub;

beforeEach(() => {
  vi.stubGlobal('MessageChannel', MessageChannelStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('message-port output bridge lifecycle', () => {
  it('rejects non-stream and locked destinations', () => {
    expect(() => createMessagePortOutputBridge({} as never)).toThrow(
      'Streaming output must be an unlocked WritableStream.',
    );

    const output = new WritableStream();
    const writer = output.getWriter();
    expect(() => createMessagePortOutputBridge(output)).toThrow(
      'Streaming output must be an unlocked WritableStream.',
    );
    writer.releaseLock();
  });

  it('keeps the first settlement when a late bridge message also fails', async () => {
    const bridge = createMessagePortOutputBridge(new WritableStream());
    latestChannel.port1.failPost = new Error('port closed');

    latestChannel.port1.emit({ id: 1, type: 'close' });
    await expect(bridge.completion).resolves.toMatchObject({
      origin: 'worker-output-abort',
      status: 'failed',
    });
    latestChannel.port1.emit({ id: 2, type: 'close' });
    await Promise.resolve();
    await expect(bridge.commit()).resolves.toMatchObject({
      origin: 'worker-output-abort',
      status: 'failed',
    });
  });

  it('aborts the destination when the main port receives an unreadable message', async () => {
    const abortError = new Error('destination abort failed');
    const bridge = createMessagePortOutputBridge(
      new WritableStream({ abort: () => Promise.reject(abortError) }),
    );

    latestChannel.port1.emitMessageError();

    await expect(bridge.completion).resolves.toMatchObject({
      origin: 'destination-write',
      status: 'failed',
    });
    await Promise.resolve();
  });

  it('closes a rejected remote abort even when the destination abort hook fails', async () => {
    const bridge = createMessagePortOutputBridge(
      new WritableStream({ abort: () => Promise.reject(new Error('abort hook failed')) }),
    );
    const output = createMessagePortOutput(bridge.requestOutput);

    await output.abort(new Error('worker stopped'));

    await expect(bridge.completion).resolves.toMatchObject({
      origin: 'worker-output-abort',
      status: 'failed',
    });
    await Promise.resolve();
  });

  it('makes an unreadable Worker response terminal before the next write', async () => {
    const bridge = createMessagePortOutputBridge(new WritableStream());
    const output = createMessagePortOutput(bridge.requestOutput);
    latestChannel.port2.emit({ id: 999, type: 'ack' });
    latestChannel.port2.emitMessageError();

    const writer = output.getWriter();
    await expect(writer.write(CHUNK)).rejects.toThrow(
      'Unreadable output bridge response.',
    );
  });

  it('rejects a write when the Worker port cannot post it', async () => {
    const bridge = createMessagePortOutputBridge(new WritableStream());
    const output = createMessagePortOutput(bridge.requestOutput);
    latestChannel.port2.failPost = new DOMException(
      'The object could not be cloned.',
      'DataCloneError',
    );

    const writer = output.getWriter();
    await expect(writer.write(CHUNK)).rejects.toMatchObject({
      name: 'DataCloneError',
    });
  });
});

class MessagePortStub {
  failPost: unknown;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  peer!: MessagePortStub;

  close(): void {}

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  emitMessageError(): void {
    this.onmessageerror?.({} as MessageEvent);
  }

  postMessage(data: unknown): void {
    if (this.failPost !== undefined) {
      throw this.failPost;
    }
    queueMicrotask(() => this.peer.emit(data));
  }

  start(): void {}
}

class MessageChannelStub {
  readonly port1 = new MessagePortStub();
  readonly port2 = new MessagePortStub();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
    latestChannel = this;
  }
}
