import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeAssetError, type RuntimeAssetLoadState } from '../assets/runtime-asset-provider.js';
import type { AudioTranscoderStreamEngine } from './contracts.js';
import type { AudioTranscoderStreamWorkerScope } from './expose-worker.js';
import type { AudioStreamWorkerRequest } from './protocol.js';

const mocks = vi.hoisted(() => ({
  createCodecRuntime: vi.fn(),
  createEngine: vi.fn(),
  createHandler: vi.fn(),
  createProvider: vi.fn(),
}));

vi.mock('../assets/audio-codec-assets.js', () => ({
  createAudioTranscoderCodecAssetProvider: mocks.createProvider,
}));
vi.mock('./engine.js', () => ({
  createAudioTranscoderStreamEngine: mocks.createEngine,
}));
vi.mock('./host.js', () => ({
  createStreamWorkerMessageHandler: mocks.createHandler,
}));
vi.mock('./runtime/default.js', () => ({
  createDefaultAudioTranscoderStreamCodecRuntime: mocks.createCodecRuntime,
}));

import { exposeDefaultAudioTranscoderStreamWorker } from './default-worker-host.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('default stream Worker host', () => {
  it('configures once, forwards operations, and serializes asset state', () => {
    let observeState: ((state: RuntimeAssetLoadState) => void) | undefined;
    const provider = {
      subscribe(listener: (state: RuntimeAssetLoadState) => void) {
        observeState = listener;
        return vi.fn();
      },
    };
    const codecRuntime = { id: 'runtime' };
    const engine = { id: 'engine' } as unknown as AudioTranscoderStreamEngine;
    const handleOperation = vi.fn();
    mocks.createProvider.mockReturnValue(provider);
    mocks.createCodecRuntime.mockReturnValue(codecRuntime);
    mocks.createEngine.mockReturnValue(engine);
    mocks.createHandler.mockReturnValue(handleOperation);
    const harness = createScopeHarness();
    exposeDefaultAudioTranscoderStreamWorker(harness.scope);

    const configuration = {
      codecAssets: {
        fallbackSources: [
          { baseUrl: '/fallback', kind: 'self-hosted' as const },
        ],
        source: { baseUrl: '/primary', kind: 'self-hosted' as const },
      },
      type: 'configure' as const,
    };
    harness.emit(configuration);

    expect(mocks.createProvider).toHaveBeenCalledWith({
      fallbackSources: configuration.codecAssets.fallbackSources,
      source: configuration.codecAssets.source,
    });
    expect(mocks.createCodecRuntime).toHaveBeenCalledWith(provider);
    expect(mocks.createEngine).toHaveBeenCalledWith({ codecRuntime });
    expect(mocks.createHandler).toHaveBeenCalledWith({
      engine,
      postMessage: expect.any(Function),
    });
    expect(harness.posts).toEqual([{ type: 'configured' }]);

    observeState?.(state(null));
    observeState?.(
      state(new RuntimeAssetError('INTEGRITY_MISMATCH', 'digest mismatch')),
    );
    expect(harness.posts.slice(1)).toEqual([
      { state: state(null), type: 'asset-state' },
      {
        state: {
          ...state(new RuntimeAssetError('INTEGRITY_MISMATCH', 'digest mismatch')),
          error: {
            code: 'INTEGRITY_MISMATCH',
            message: 'digest mismatch',
          },
        },
        type: 'asset-state',
      },
    ]);

    const handlerOptions = mocks.createHandler.mock.calls[0]?.[0] as {
      postMessage(message: unknown): void;
    };
    const forwarded = { id: 9, operation: 'inspect', type: 'result' };
    handlerOptions.postMessage(forwarded);
    expect(harness.posts.at(-1)).toBe(forwarded);

    const operation = inspectRequest();
    harness.emit(operation);
    expect(handleOperation).toHaveBeenCalledWith(
      expect.objectContaining({ data: operation }),
    );

    harness.emit(configuration);
    expect(harness.posts.at(-1)).toMatchObject({
      error: {
        code: 'INVALID_CONFIGURATION',
        message: 'The default audio stream Worker codec assets are already configured.',
      },
      type: 'configuration-error',
    });
  });

  it('rejects operations before configuration', () => {
    const harness = createScopeHarness();
    exposeDefaultAudioTranscoderStreamWorker(harness.scope);

    harness.emit(inspectRequest());

    expect(harness.posts).toEqual([
      {
        error: {
          code: 'INVALID_CONFIGURATION',
          message:
            'Configure codec assets before using the default audio stream Worker.',
          name: 'AudioTranscoderError',
        },
        type: 'configuration-error',
      },
    ]);
  });

  it.each([new Error('bad source'), 'uncloneable source'])(
    'reports configuration construction failures %#',
    (failure) => {
      mocks.createProvider.mockImplementationOnce(() => {
        throw failure;
      });
      const harness = createScopeHarness();
      exposeDefaultAudioTranscoderStreamWorker(harness.scope);

      harness.emit({
        codecAssets: {
          source: { baseUrl: '/primary', kind: 'self-hosted' },
        },
        type: 'configure',
      });

      expect(harness.posts).toEqual([
        {
          error: {
            code: 'INVALID_CONFIGURATION',
            message:
              failure instanceof Error ? failure.message : String(failure),
            name: 'AudioTranscoderError',
          },
          type: 'configuration-error',
        },
      ]);
    },
  );
});

function createScopeHarness() {
  let listener:
    | ((event: MessageEvent<AudioStreamWorkerRequest>) => void)
    | undefined;
  const posts: unknown[] = [];
  const scope: AudioTranscoderStreamWorkerScope = {
    addEventListener(_type, nextListener) {
      listener = nextListener;
    },
    postMessage(message) {
      posts.push(message);
    },
  };
  return {
    emit(request: AudioStreamWorkerRequest) {
      listener?.({ data: request } as MessageEvent<AudioStreamWorkerRequest>);
    },
    posts,
    scope,
  };
}

function inspectRequest(): AudioStreamWorkerRequest {
  return {
    id: 1,
    input: { blob: new Blob(['audio']) },
    options: {},
    type: 'inspect',
  };
}

function state(error: RuntimeAssetError | null): RuntimeAssetLoadState {
  return {
    assetName: 'aac',
    error,
    loadedBytes: error === null ? 1 : 0,
    phase: error === null ? 'ready' : 'error',
    totalBytes: 1,
  };
}
