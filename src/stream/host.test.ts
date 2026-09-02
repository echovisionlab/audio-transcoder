import { describe, expect, it, vi } from 'vitest';
import type {
  AudioStreamInputSupportResult,
  AudioStreamInspection,
  AudioStreamOutputSupportResult,
  AudioStreamProgress,
  AudioStreamTranscodeResult,
  AudioTranscoderStreamEngine,
} from './contracts.js';
import { createStreamWorkerMessageHandler } from './host.js';
import type { AudioStreamWorkerRequest } from './protocol.js';
import { AudioTranscoderError } from '../errors.js';
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from './capabilities.js';

const INSPECTION: AudioStreamInspection = {
  bitDepth: 24,
  channels: 1,
  codec: 'pcm-s24',
  container: 'WAVE',
  decodeSupport: 'built-in',
  durationSeconds: 1,
  notes: [],
  sampleRate: 48_000,
  size: 100,
};
const RESULT: AudioStreamTranscodeResult = {
  bytesWritten: 100,
  channels: 1,
  details: { format: 'wav', rf64: false },
  durationSeconds: 1,
  format: 'wav',
  preset: {
    bitDepth: 16,
    container: 'wav',
    extension: 'wav',
    id: 'wav-pcm16',
    mimeType: 'audio/wav',
    sampleFormat: 'integer',
  },
  rf64: false,
  sampleRate: 48_000,
};
const PROGRESS: AudioStreamProgress = {
  durationSeconds: 1,
  phase: 'decode',
  processedSeconds: 0.5,
  progress: 0.49,
};
const SUPPORTED_INPUT: AudioStreamInputSupportResult = {
  inspection: INSPECTION,
  status: 'supported',
};
const SUPPORTED_OUTPUT: AudioStreamOutputSupportResult = {
  code: 'SUPPORTED',
  message: 'The output runtime probe succeeded.',
  reason: 'runtime-verified',
  status: 'supported',
};

describe('stream worker host', () => {
  it('rejects package codec configuration on a custom Worker host', () => {
    const postMessage = vi.fn();
    const handle = createStreamWorkerMessageHandler({
      engine: createEngine(),
      postMessage,
    });

    handle(
      messageEvent({
        codecAssets: {
          source: { baseUrl: '/codec-assets', kind: 'self-hosted' },
        },
        type: 'configure',
      }),
    );

    expect(postMessage).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: 'INVALID_CONFIGURATION',
        message: expect.stringContaining('custom stream Worker'),
      }),
      type: 'configuration-error',
    });
  });

  it('executes requests serially in FIFO order', async () => {
    let resolveFirst!: (value: AudioStreamInspection) => void;
    const inspect = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AudioStreamInspection>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(INSPECTION);
    const postMessage = vi.fn();
    const handle = createStreamWorkerMessageHandler({
      engine: createEngine({ inspect }),
      postMessage,
    });

    handle(messageEvent(inspectRequest(1)));
    handle(messageEvent(inspectRequest(2)));
    expect(inspect).toHaveBeenCalledTimes(1);

    resolveFirst(INSPECTION);
    await flushTasks();

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { id: 1, operation: 'inspect', type: 'result', value: INSPECTION },
      { id: 2, operation: 'inspect', type: 'result', value: INSPECTION },
    ]);
  });

  it('forwards transcode options and progress', async () => {
    const transcode = vi.fn(async (_input, _target, _output, options) => {
      options?.onProgress?.(PROGRESS);
      return RESULT;
    });
    const postMessage = vi.fn();
    const handle = createStreamWorkerMessageHandler({
      engine: createEngine({ transcode }),
      postMessage,
    });
    const output = new WritableStream();

    handle(messageEvent({
      id: 3,
      input: { blob: new Blob(['audio']) },
      options: {
        inputReadBytes: 65_536,
        maxOutputBytes: 524_288,
        outputChunkBytes: 131_072,
        pcmChunkBytes: 262_144,
      },
      output,
      target: { presetId: 'wav-pcm16' },
      type: 'transcode',
    }));
    await flushTasks();

    expect(transcode).toHaveBeenCalledWith(
      expect.anything(),
      { presetId: 'wav-pcm16' },
      output,
      expect.objectContaining({
        inputReadBytes: 65_536,
        maxOutputBytes: 524_288,
        outputChunkBytes: 131_072,
        pcmChunkBytes: 262_144,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(postMessage).toHaveBeenNthCalledWith(1, {
      id: 3,
      progress: PROGRESS,
      type: 'progress',
    });
    expect(postMessage).toHaveBeenNthCalledWith(2, {
      id: 3,
      operation: 'transcode',
      type: 'result',
      value: RESULT,
    });
  });

  it('forwards per-file support probes to the production engine API', async () => {
    const probeInputSupport = vi.fn(async () => SUPPORTED_INPUT);
    const inspect = vi.fn();
    const postMessage = vi.fn();
    const handle = createStreamWorkerMessageHandler({
      engine: createEngine({ inspect, probeInputSupport }),
      postMessage,
    });
    const input = { blob: new Blob(['audio']), name: 'candidate.flac' };

    handle(messageEvent({
      id: 7,
      input,
      options: { inputReadBytes: 65_536 },
      type: 'probeInputSupport',
    }));
    await flushTasks();

    expect(probeInputSupport).toHaveBeenCalledWith(
      input,
      expect.objectContaining({
        inputReadBytes: 65_536,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(inspect).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      id: 7,
      operation: 'probeInputSupport',
      type: 'result',
      value: SUPPORTED_INPUT,
    });
  });

  it('forwards concrete output probes through the serial Worker host', async () => {
    const probeOutputSupport = vi.fn(async () => SUPPORTED_OUTPUT);
    const postMessage = vi.fn();
    const handle = createStreamWorkerMessageHandler({
      engine: createEngine({ probeOutputSupport }),
      postMessage,
    });
    const target = {
      channels: 2,
      presetId: 'wav-pcm16' as const,
      sampleRate: 48_000,
    };

    handle(messageEvent({
      id: 8,
      target,
      type: 'probeOutputSupport',
    }));
    await flushTasks();

    expect(probeOutputSupport).toHaveBeenCalledWith(target, {
      signal: expect.any(AbortSignal),
    });
    expect(postMessage).toHaveBeenCalledWith({
      id: 8,
      operation: 'probeOutputSupport',
      type: 'result',
      value: SUPPORTED_OUTPUT,
    });
  });

  it('cancels active and queued requests and ignores unknown ids', async () => {
    const inspect = vi.fn(async (_input, options) => {
      if (options?.signal?.aborted) {
        throw new AudioTranscoderError('OPERATION_ABORTED', 'queued canceled');
      }
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new AudioTranscoderError('OPERATION_ABORTED', 'active canceled');
    });
    const postMessage = vi.fn();
    const handle = createStreamWorkerMessageHandler({
      engine: createEngine({ inspect }),
      postMessage,
    });

    handle(messageEvent(inspectRequest(4)));
    handle(messageEvent(inspectRequest(5)));
    handle(messageEvent({ id: 404, type: 'cancel' }));
    handle(messageEvent({ id: 5, type: 'cancel' }));
    handle(messageEvent({ id: 4, type: 'cancel' }));
    await flushTasks();

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledWith({
      error: {
        code: 'OPERATION_ABORTED',
        message: 'active canceled',
        name: 'AudioTranscoderError',
      },
      id: 4,
      type: 'error',
    });
    expect(postMessage).toHaveBeenCalledWith({
      error: {
        code: 'OPERATION_ABORTED',
        message: 'queued canceled',
        name: 'AudioTranscoderError',
      },
      id: 5,
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
  ])('serializes operation failures %#', async (failure, serialized) => {
    const postMessage = vi.fn();
    const handle = createStreamWorkerMessageHandler({
      engine: createEngine({
        async inspect() {
          throw failure;
        },
      }),
      postMessage,
    });

    handle(messageEvent(inspectRequest(6)));
    await flushTasks();

    expect(postMessage).toHaveBeenCalledWith({
      error: serialized,
      id: 6,
      type: 'error',
    });
  });
});

function createEngine(
  overrides: Partial<AudioTranscoderStreamEngine> = {},
): AudioTranscoderStreamEngine {
  return {
    getCapabilities: () => AUDIO_TRANSCODER_STREAM_CAPABILITIES,
    getInfo: () => ({ name: 'test', version: '0.0.0' }),
    getVersion: () => '0.0.0',
    inspect: async () => INSPECTION,
    probeInputSupport: async () => SUPPORTED_INPUT,
    probeOutputSupport: async () => SUPPORTED_OUTPUT,
    transcode: async () => RESULT,
    ...overrides,
  };
}

function inspectRequest(id: number): AudioStreamWorkerRequest {
  return {
    id,
    input: { blob: new Blob(['audio']) },
    options: {},
    type: 'inspect',
  };
}

function messageEvent(
  request: AudioStreamWorkerRequest,
): MessageEvent<AudioStreamWorkerRequest> {
  return { data: request } as MessageEvent<AudioStreamWorkerRequest>;
}

async function flushTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
