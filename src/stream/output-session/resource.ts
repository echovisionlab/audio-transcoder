import type { AudioStreamOutput } from '../contracts.js';
import type {
  AudioTranscoderOutputArtifact,
  AudioTranscoderOutputMetadata,
  AudioTranscoderOutputStorage,
  AudioTranscoderPendingOutput,
} from '../output-session.js';
import {
  collectFailures,
  invalidConfiguration,
  sessionDisposedError,
  throwCollectedFailures,
  type OutputDestination,
} from './internal.js';

export class ManagedPendingOutput implements AudioTranscoderPendingOutput {
  private artifact: ManagedOutputArtifact | undefined;
  private completion: Promise<AudioTranscoderOutputArtifact> | undefined;
  private completionStarted = false;
  private disposalInFlight: Promise<void> | undefined;
  private disposalSucceeded: Promise<void> | undefined;
  private disposeRequested = false;
  private released = false;

  readonly maxOutputBytes?: number;
  readonly storage: AudioTranscoderOutputStorage;
  readonly stream: AudioStreamOutput;

  constructor(
    private readonly destination: OutputDestination,
    private readonly release: () => void,
  ) {
    if (destination.maxOutputBytes !== undefined) {
      this.maxOutputBytes = destination.maxOutputBytes;
    }
    this.storage = destination.storage;
    this.stream = destination.stream;
  }

  complete(
    metadata: AudioTranscoderOutputMetadata,
  ): Promise<AudioTranscoderOutputArtifact> {
    validateMetadata(metadata);
    if (this.completionStarted || this.disposeRequested) {
      return Promise.reject(
        invalidConfiguration('Output destination is already settled.'),
      );
    }
    this.completionStarted = true;
    this.completion = this.completeOnce(metadata);
    return this.completion;
  }

  discard(): Promise<void> {
    this.disposeRequested = true;
    this.completionStarted = true;
    if (this.disposalSucceeded !== undefined) {
      return this.disposalSucceeded;
    }
    if (this.disposalInFlight !== undefined) {
      return this.disposalInFlight;
    }

    const attempt = this.discardOnce();
    this.disposalInFlight = attempt;
    void attempt.then(
      () => {
        this.disposalSucceeded = attempt;
        this.disposalInFlight = undefined;
      },
      () => {
        this.disposalInFlight = undefined;
      },
    );
    return attempt;
  }

  private async completeOnce(
    metadata: AudioTranscoderOutputMetadata,
  ): Promise<AudioTranscoderOutputArtifact> {
    try {
      const blob = await this.destination.complete(metadata.mimeType);
      const artifact = new ManagedOutputArtifact(
        blob,
        metadata,
        this.destination.storage,
        () => this.destination.discard(),
        () => this.releaseTracking(),
      );
      this.artifact = artifact;
      if (this.disposeRequested) {
        throw sessionDisposedError();
      }
      return artifact;
    } catch (error) {
      if (this.artifact === undefined) {
        try {
          await this.destination.discard();
          this.releaseTracking();
        } catch {
          // Keep the resource tracked so a later discard can retry cleanup.
        }
      }
      throw error;
    }
  }

  private async discardOnce(): Promise<void> {
    if (this.artifact !== undefined) {
      await this.artifact.dispose();
      return;
    }

    const cleanup = this.destination.discard();
    const completionCleanup = this.completion?.catch(() => undefined);
    const settlements = await Promise.allSettled([
      cleanup,
      ...(completionCleanup === undefined ? [] : [completionCleanup]),
    ]);
    const failures: unknown[] = [];
    collectFailures(settlements, failures);
    throwCollectedFailures(failures, 'Failed to discard output destination.');
    this.releaseTracking();
  }

  private releaseTracking(): void {
    if (!this.released) {
      this.release();
      this.released = true;
    }
  }
}

class ManagedOutputArtifact implements AudioTranscoderOutputArtifact {
  private disposalInFlight: Promise<void> | undefined;
  private disposalSucceeded: Promise<void> | undefined;

  readonly mimeType: string;
  readonly name: string;
  readonly size: number;

  constructor(
    readonly blob: Blob,
    metadata: AudioTranscoderOutputMetadata,
    readonly storage: AudioTranscoderOutputStorage,
    private readonly disposeBacking: () => Promise<void>,
    private readonly release: () => void,
  ) {
    this.mimeType = metadata.mimeType;
    this.name = metadata.name;
    this.size = blob.size;
  }

  dispose(): Promise<void> {
    if (this.disposalSucceeded !== undefined) {
      return this.disposalSucceeded;
    }
    if (this.disposalInFlight !== undefined) {
      return this.disposalInFlight;
    }

    const attempt = Promise.resolve()
      .then(() => this.disposeBacking())
      .then(() => this.release());
    this.disposalInFlight = attempt;
    void attempt.then(
      () => {
        this.disposalSucceeded = attempt;
        this.disposalInFlight = undefined;
      },
      () => {
        this.disposalInFlight = undefined;
      },
    );
    return attempt;
  }
}

function validateMetadata(metadata: AudioTranscoderOutputMetadata): void {
  if (typeof metadata.name !== 'string' || metadata.name.length === 0) {
    throw invalidConfiguration('Output name must be a non-empty string.');
  }
  if (
    typeof metadata.mimeType !== 'string' ||
    metadata.mimeType.length === 0
  ) {
    throw invalidConfiguration('Output mimeType must be a non-empty string.');
  }
}
