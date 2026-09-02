import {
  AUDIO_TRANSCODER_OUTPUT_MEMORY_LIMIT_BYTES,
  createAudioTranscoderOutputSession,
  type AudioStreamOutput,
  type AudioTranscoderOutputArtifact,
  type AudioTranscoderOutputStorage,
} from '@echovisionlab/audio-transcoder';

export const MEMORY_OUTPUT_LIMIT_BYTES =
  AUDIO_TRANSCODER_OUTPUT_MEMORY_LIMIT_BYTES;

export type OutputStorageMode = AudioTranscoderOutputStorage;

export interface OutputArtifact {
  readonly downloadName: string;
  readonly size: number;
  readonly storage: OutputStorageMode;
  readonly url: string;
  cleanup(): Promise<void>;
}

export interface PendingOutput {
  readonly maxOutputBytes?: number;
  readonly storage: OutputStorageMode;
  readonly stream: AudioStreamOutput;
  complete(downloadName: string, mimeType: string): Promise<OutputArtifact>;
  discard(): Promise<void>;
}

export async function discardPendingOutputAfterFailure(
  pending: PendingOutput | undefined,
  primaryError: unknown,
): Promise<void> {
  if (pending === undefined) {
    return;
  }
  await observeCleanupFailure(
    () => pending.discard(),
    primaryError,
  );
}

export class OutputStore {
  private readonly session = createAudioTranscoderOutputSession({
    memoryLimitBytes: MEMORY_OUTPUT_LIMIT_BYTES,
    namespace: 'audio-transcoder-demo',
  });

  async create(): Promise<PendingOutput> {
    const pending = await this.session.create();
    return {
      ...(pending.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: pending.maxOutputBytes }),
      storage: pending.storage,
      stream: pending.stream,
      complete: async (downloadName, mimeType) =>
        createDownloadArtifact(
          await pending.complete({ mimeType, name: downloadName }),
        ),
      discard: () => pending.discard(),
    };
  }

  getMode(): Promise<OutputStorageMode> {
    return this.session.getStorageMode();
  }

  dispose(): Promise<void> {
    return this.session.dispose();
  }
}

async function createDownloadArtifact(
  artifact: AudioTranscoderOutputArtifact,
): Promise<OutputArtifact> {
  let url: string;
  try {
    url = URL.createObjectURL(artifact.blob);
  } catch (error) {
    await observeCleanupFailure(() => artifact.dispose(), error);
    throw error;
  }

  let cleanupInFlight: Promise<void> | undefined;
  let cleanupSucceeded: Promise<void> | undefined;
  let urlRevoked = false;
  return {
    downloadName: artifact.name,
    size: artifact.size,
    storage: artifact.storage,
    url,
    cleanup() {
      if (cleanupSucceeded !== undefined) return cleanupSucceeded;
      if (cleanupInFlight !== undefined) return cleanupInFlight;

      if (!urlRevoked) {
        URL.revokeObjectURL(url);
        urlRevoked = true;
      }

      const attempt = Promise.resolve().then(() => artifact.dispose());
      cleanupInFlight = attempt;
      void attempt.then(
        () => {
          cleanupSucceeded = attempt;
          cleanupInFlight = undefined;
        },
        () => {
          cleanupInFlight = undefined;
        },
      );
      return attempt;
    },
  };
}

async function observeCleanupFailure(
  cleanup: () => Promise<void>,
  primaryError: unknown,
): Promise<void> {
  try {
    await cleanup();
  } catch (cleanupError) {
    try {
      console.error(
        'Output cleanup failed; output-session disposal will retry it.',
        { cleanupError, primaryError },
      );
    } catch {
      // Cleanup reporting must not replace the primary operation error.
    }
  }
}
