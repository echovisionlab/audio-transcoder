import { describe, expect, it, vi } from 'vitest';
import type {
  AudioOperationOptions,
  AudioProgress,
  AudioTranscoderEngine,
  DecodedAudio,
  EncodedAudio,
} from '../engine/contracts.js';
import { AudioTranscoderError } from '../errors.js';
import { createWorkerMessageHandler } from './host.js';
import type { AudioWorkerRequest } from './protocol.js';

const PROGRESS: AudioProgress = {
  completedFrames: 1,
  operation: 'decode',
  phase: 'decode',
  progress: 0.5,
  totalFrames: 2,
};
const PRESET = {
  bitDepth: 16,
  container: 'test',
  extension: 'test',
  id: 'test',
  mimeType: 'audio/test',
  sampleFormat: 'integer' as const,
};

describe('audio worker host', () => {
  it('forwards decode progress and transfers unique channel buffers', async () => {
    const buffer = new ArrayBuffer(16);
    const shared = new SharedArrayBuffer(4);
    const decoded: DecodedAudio = {
      channelData: [
        new Float32Array(buffer, 0, 2),
        new Float32Array(buffer, 8, 2),
        new Float32Array(shared),
      ],
      durationSeconds: 1,
      sampleRate: 2,
      source: 'test',
    };
    const decode = vi.fn(
      async (_input, options): Promise<DecodedAudio> => {
        options?.onProgress?.(PROGRESS);
        return decoded;
      },
    );
    const engine = createEngine({ decode });
    const postMessage = vi.fn();
    const handleMessage = createWorkerMessageHandler({ engine, postMessage });

    handleMessage(messageEvent({
      id: 1,
      input: { data: new ArrayBuffer(1) },
      type: 'decode',
      unsafeAllowLargeBuffers: true,
    }));
    await flushTasks();

    expect(postMessage).toHaveBeenNthCalledWith(1, {
      id: 1,
      progress: PROGRESS,
      type: 'progress',
    });
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      { id: 1, operation: 'decode', type: 'result', value: decoded },
      [buffer],
    );
    expect(decode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ unsafeAllowLargeBuffers: true }),
    );
  });

  it.each(['encode', 'transcode'] as const)(
    'executes and transfers %s results',
    async (operation) => {
      const encoded: EncodedAudio = { data: new ArrayBuffer(2), preset: PRESET };
      const engine = createEngine({
        encode: vi.fn(async () => encoded),
        transcode: vi.fn(async () => encoded),
      });
      const postMessage = vi.fn();
      const handleMessage = createWorkerMessageHandler({ engine, postMessage });
      const request: AudioWorkerRequest =
        operation === 'encode'
          ? {
              audio: { channelData: [new Float32Array(1)], sampleRate: 1 },
              id: 2,
              presetId: PRESET.id,
              type: 'encode',
              unsafeAllowLargeBuffers: true,
            }
          : {
              id: 2,
              input: { data: new ArrayBuffer(1) },
              presetId: PRESET.id,
              type: 'transcode',
              unsafeAllowLargeBuffers: true,
            };

      handleMessage(messageEvent(request));
      await flushTasks();

      expect(engine[operation]).toHaveBeenCalledWith(
        expect.anything(),
        PRESET.id,
        expect.objectContaining({ unsafeAllowLargeBuffers: true }),
      );
      expect(postMessage).toHaveBeenCalledWith(
        { id: 2, operation, type: 'result', value: encoded },
        [encoded.data],
      );
    },
  );

  it('aborts an active request and ignores unknown cancellation ids', async () => {
    const engine = createEngine({
      async decode(_input, options): Promise<DecodedAudio> {
        await waitForAbort(options);
        throw new AudioTranscoderError('OPERATION_ABORTED', 'host cancelled');
      },
    });
    const postMessage = vi.fn();
    const handleMessage = createWorkerMessageHandler({ engine, postMessage });

    handleMessage(messageEvent({
      id: 3,
      input: { data: new ArrayBuffer(1) },
      type: 'decode',
    }));
    handleMessage(messageEvent({ id: 404, type: 'cancel' }));
    handleMessage(messageEvent({ id: 3, type: 'cancel' }));
    await flushTasks();

    expect(postMessage).toHaveBeenCalledWith({
      error: {
        code: 'OPERATION_ABORTED',
        message: 'host cancelled',
        name: 'AudioTranscoderError',
      },
      id: 3,
      type: 'error',
    });
  });

  it.each([
    [
      new TypeError('typed failure'),
      {
        message: 'typed failure',
        name: 'TypeError',
        stack: expect.any(String),
      },
    ],
    ['string failure', { message: 'string failure', name: 'Error' }],
    [42, { message: '42', name: 'Error' }],
  ])('serializes non-engine failures %#', async (failure, serialized) => {
    const engine = createEngine({
      async decode(): Promise<DecodedAudio> {
        throw failure;
      },
    });
    const postMessage = vi.fn();
    const handleMessage = createWorkerMessageHandler({ engine, postMessage });

    handleMessage(messageEvent({
      id: 4,
      input: { data: new ArrayBuffer(1) },
      type: 'decode',
    }));
    await flushTasks();

    expect(postMessage).toHaveBeenCalledWith({
      error: serialized,
      id: 4,
      type: 'error',
    });
  });
});

function createEngine(
  overrides: Partial<AudioTranscoderEngine> = {},
): AudioTranscoderEngine {
  const decoded: DecodedAudio = {
    channelData: [new Float32Array(1)],
    durationSeconds: 1,
    sampleRate: 1,
    source: 'default',
  };
  const encoded: EncodedAudio = { data: new ArrayBuffer(1), preset: PRESET };

  return {
    async decode(): Promise<DecodedAudio> {
      return decoded;
    },
    async encode(): Promise<EncodedAudio> {
      return encoded;
    },
    getCapabilities: () => ({ decode: [], encode: [], inspect: [] }),
    getInfo: () => ({ name: 'test', version: '0.0.0' }),
    getVersion: () => '0.0.0',
    inspect: () => ({
      bitDepth: null,
      channels: null,
      codec: 'test',
      container: 'test',
      decodeSupport: 'unknown',
      durationSeconds: null,
      notes: [],
      sampleRate: null,
    }),
    async transcode(): Promise<EncodedAudio> {
      return encoded;
    },
    ...overrides,
  };
}

function messageEvent(request: AudioWorkerRequest): MessageEvent<AudioWorkerRequest> {
  return { data: request } as MessageEvent<AudioWorkerRequest>;
}

function waitForAbort(options: AudioOperationOptions | undefined): Promise<void> {
  return new Promise((resolve) => {
    options?.signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function flushTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
