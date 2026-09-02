import { describe, expect, it, vi } from 'vitest';
import type { AudioCodecOperationContext } from './contracts.js';
import {
  CODEC_FRAME_BATCH_SIZE,
  processFrameBatches,
} from './frame-batches.js';

describe('processFrameBatches', () => {
  it('processes one range and reports its boundaries', async () => {
    const context = createContext();
    const processRange = vi.fn();

    await processFrameBatches(3, context, processRange);

    expect(processRange).toHaveBeenCalledWith(0, 3);
    expect(context.reportProgress).toHaveBeenNthCalledWith(1, 0, 3);
    expect(context.reportProgress).toHaveBeenNthCalledWith(2, 3, 3);
    expect(context.checkpoint).not.toHaveBeenCalled();
    expect(context.throwIfAborted).toHaveBeenCalledTimes(3);
  });

  it('checkpoints and yields between large ranges', async () => {
    const context = createContext();
    const ranges: [number, number][] = [];
    const totalFrames = CODEC_FRAME_BATCH_SIZE + 2;

    await processFrameBatches(totalFrames, context, (startFrame, endFrame) => {
      ranges.push([startFrame, endFrame]);
    });

    expect(ranges).toEqual([
      [0, CODEC_FRAME_BATCH_SIZE],
      [CODEC_FRAME_BATCH_SIZE, totalFrames],
    ]);
    expect(context.checkpoint).toHaveBeenCalledWith(
      CODEC_FRAME_BATCH_SIZE,
      totalFrames,
    );
  });

  it('provides a detached cooperative context to direct codec calls', async () => {
    const processRange = vi.fn();

    await processFrameBatches(
      CODEC_FRAME_BATCH_SIZE + 1,
      undefined,
      processRange,
    );

    expect(processRange).toHaveBeenCalledTimes(2);
  });

  it('stops before processing when the context is aborted', async () => {
    const context = createContext();
    vi.mocked(context.throwIfAborted).mockImplementation(() => {
      throw new Error('stopped');
    });
    const processRange = vi.fn();

    await expect(processFrameBatches(1, context, processRange)).rejects.toThrow(
      'stopped',
    );
    expect(processRange).not.toHaveBeenCalled();
  });
});

function createContext(): AudioCodecOperationContext {
  return {
    checkpoint: vi.fn(async () => {}),
    reportProgress: vi.fn(),
    signal: undefined,
    throwIfAborted: vi.fn(),
  };
}
