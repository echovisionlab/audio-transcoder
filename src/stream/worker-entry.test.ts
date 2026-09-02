import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exposeDefaultWorker: vi.fn() }));

vi.mock('./default-worker-host.js', () => ({
  exposeDefaultAudioTranscoderStreamWorker: mocks.exposeDefaultWorker,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

it('installs the configurable default stream Worker host', async () => {
  const scope = {
    addEventListener: vi.fn(),
    postMessage: vi.fn(),
  };
  vi.stubGlobal('addEventListener', scope.addEventListener);
  vi.stubGlobal('postMessage', scope.postMessage);

  await import('./worker-entry.js');

  expect(mocks.exposeDefaultWorker).toHaveBeenCalledOnce();
  expect(mocks.exposeDefaultWorker).toHaveBeenCalledWith(globalThis);
});
