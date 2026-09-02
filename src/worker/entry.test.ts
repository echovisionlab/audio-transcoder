import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioWorkerRequest, AudioWorkerResponse } from './protocol.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('audio worker entry', () => {
  it('installs the worker host and posts transferable results', async () => {
    const addEventListener = vi.fn();
    const postMessage = vi.fn();
    vi.stubGlobal('addEventListener', addEventListener);
    vi.stubGlobal('postMessage', postMessage);

    await import('./entry.js');
    const handleMessage = addEventListener.mock.calls[0]?.[1] as (
      event: MessageEvent<AudioWorkerRequest>,
    ) => void;
    handleMessage({
      data: {
        audio: { channelData: [new Float32Array([0])], sampleRate: 48_000 },
        id: 1,
        presetId: 'wav-pcm16',
        type: 'encode',
      },
    } as unknown as MessageEvent<AudioWorkerRequest>);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    const result = postMessage.mock.calls.find(
      ([message]) => (message as AudioWorkerResponse).type === 'result',
    );
    expect(result?.[0]).toMatchObject({
      id: 1,
      operation: 'encode',
      type: 'result',
    });
    expect(result?.[1]).toHaveLength(1);
  });
});
