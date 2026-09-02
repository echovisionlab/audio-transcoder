import { AudioTranscoderError } from '../../errors.js';
import type { AudioStreamOutput, AudioStreamOutputChunk } from '../contracts.js';
import {
  invalidConfiguration,
  type OutputDestination,
} from './internal.js';

export async function createOpfsDestination(
  directory: FileSystemDirectoryHandle,
): Promise<OutputDestination> {
  const tempName = `output-${crypto.randomUUID()}.tmp`;
  const remove = createRemoval(directory, tempName);
  try {
    const handle = await directory.getFileHandle(tempName, { create: true });
    const writable = await handle.createWritable();
    return new OpfsDestination(handle, writable, remove);
  } catch (error) {
    await remove().catch(() => undefined);
    throw error;
  }
}

export async function removeEntryIfPresent(
  directory: FileSystemDirectoryHandle,
  name: string,
  recursive: boolean,
): Promise<void> {
  try {
    await directory.removeEntry(name, { recursive });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

class OpfsDestination implements OutputDestination {
  private closed = false;
  private nativeSettlement: Promise<void> | undefined;
  private readonly writer: WritableStreamDefaultWriter<FileSystemWriteChunkType>;
  readonly storage = 'opfs' as const;
  readonly stream: AudioStreamOutput;

  constructor(
    private readonly handle: FileSystemFileHandle,
    writable: FileSystemWritableFileStream,
    private readonly remove: () => Promise<void>,
  ) {
    this.writer = writable.getWriter();
    this.stream = new WritableStream<AudioStreamOutputChunk>({
      abort: (reason) => this.abortNative(reason),
      close: () => this.closeNative(),
      write: async (chunk) => {
        try {
          await this.writer.write(chunk);
        } catch (error) {
          throw normalizeOpfsQuotaError(error, 'write');
        }
      },
    });
  }

  async complete(mimeType: string): Promise<Blob> {
    if (!this.closed) {
      throw invalidConfiguration(
        'Output stream must be closed before it is completed.',
      );
    }
    const file = await this.handle.getFile();
    return file.type === mimeType
      ? file
      : file.slice(0, file.size, mimeType);
  }

  async discard(): Promise<void> {
    // A failed native close remains cached by the platform writer. Once the
    // backing file is removed, that stale rejection no longer represents a
    // live resource and must not prevent cleanup from converging.
    await this.abortNative(undefined).catch(() => undefined);
    await this.remove();
  }

  private abortNative(reason: unknown): Promise<void> {
    return this.settleNative(() => this.writer.abort(reason));
  }

  private closeNative(): Promise<void> {
    return this.settleNative(async () => {
      try {
        await this.writer.close();
      } catch (error) {
        throw normalizeOpfsQuotaError(error, 'close');
      }
      this.closed = true;
    });
  }

  private settleNative(operation: () => Promise<void>): Promise<void> {
    this.nativeSettlement ??= operation().finally(() =>
      this.writer.releaseLock(),
    );
    return this.nativeSettlement;
  }
}

function createRemoval(
  directory: FileSystemDirectoryHandle,
  name: string,
): () => Promise<void> {
  let removed = false;
  let removalInFlight: Promise<void> | undefined;
  return () => {
    if (removed) {
      return Promise.resolve();
    }
    if (removalInFlight !== undefined) {
      return removalInFlight;
    }

    const attempt = removeEntryIfPresent(directory, name, false)
      .then(() => {
        removed = true;
      })
      .finally(() => {
        removalInFlight = undefined;
      });
    removalInFlight = attempt;
    return attempt;
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'NotFoundError'
  );
}

function normalizeOpfsQuotaError(
  error: unknown,
  operation: 'close' | 'write',
): unknown {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('name' in error) ||
    error.name !== 'QuotaExceededError'
  ) {
    return error;
  }
  return new AudioTranscoderError(
    'RESOURCE_LIMIT_EXCEEDED',
    `OPFS output storage quota was exceeded during destination ${operation}.`,
    { reason: 'output-storage-limit' },
  );
}
