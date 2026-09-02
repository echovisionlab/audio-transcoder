import type { AudioCodecOperationContext } from './contracts.js';

export const CODEC_FRAME_BATCH_SIZE = 262_144;

const DETACHED_CONTEXT: AudioCodecOperationContext = Object.freeze({
  async checkpoint(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  },
  reportProgress(): void {},
  signal: undefined,
  throwIfAborted(): void {},
});

export async function processFrameBatches(
  totalFrames: number,
  context: AudioCodecOperationContext | undefined,
  processRange: (startFrame: number, endFrame: number) => void,
): Promise<void> {
  const activeContext = context ?? DETACHED_CONTEXT;
  activeContext.throwIfAborted();
  activeContext.reportProgress(0, totalFrames);

  for (
    let startFrame = 0;
    startFrame < totalFrames;
    startFrame += CODEC_FRAME_BATCH_SIZE
  ) {
    const endFrame = Math.min(
      totalFrames,
      startFrame + CODEC_FRAME_BATCH_SIZE,
    );
    activeContext.throwIfAborted();
    processRange(startFrame, endFrame);

    if (endFrame < totalFrames) {
      await activeContext.checkpoint(endFrame, totalFrames);
    } else {
      activeContext.reportProgress(totalFrames, totalFrames);
      activeContext.throwIfAborted();
    }
  }
}
