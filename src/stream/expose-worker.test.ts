import { describe, expect, it, vi } from 'vitest';
import type { AudioTranscoderStreamEngine } from './contracts.js';

const mocks = vi.hoisted(() => ({
  createHandler: vi.fn(),
}));

vi.mock('./host.js', () => ({
  createStreamWorkerMessageHandler: mocks.createHandler,
}));

import { exposeAudioTranscoderStreamWorker } from './expose-worker.js';

describe('custom stream Worker exposure', () => {
  it('connects the supplied engine and Worker scope', () => {
    const engine = {} as AudioTranscoderStreamEngine;
    const handleMessage = vi.fn();
    const addEventListener = vi.fn();
    const postMessage = vi.fn();
    mocks.createHandler.mockReturnValue(handleMessage);

    exposeAudioTranscoderStreamWorker(engine, {
      addEventListener,
      postMessage,
    });

    expect(mocks.createHandler).toHaveBeenCalledWith({
      engine,
      postMessage: expect.any(Function),
    });
    expect(addEventListener).toHaveBeenCalledWith('message', handleMessage);

    const bridge = mocks.createHandler.mock.calls[0]![0].postMessage;
    const response = { id: 1, operation: 'inspect', type: 'result', value: {} };
    bridge(response);
    expect(postMessage).toHaveBeenCalledWith(response);
  });
});
