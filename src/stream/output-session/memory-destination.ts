import { AudioTranscoderError } from '../../errors.js';
import type { AudioStreamOutput, AudioStreamOutputChunk } from '../contracts.js';
import type { AudioTranscoderOutputMemoryReservation } from '../output-session.js';
import {
  invalidConfiguration,
  sessionDisposedError,
  type OutputDestination,
} from './internal.js';

const MEMORY_MAX_PAGE_BYTES = 1024 * 1024;
const MEMORY_TARGET_PAGE_COUNT = 512;

export function createMemoryDestination(
  budget: SessionMemoryBudget,
  maxOutputBytes?: number,
): OutputDestination {
  return new PagedMemoryDestination(budget, maxOutputBytes);
}

export class SessionMemoryBudget {
  private reservedBytes = 0;

  constructor(readonly limitBytes: number) {}

  acquireArtifactLease(
    pageBytes: number,
    requestedMaxOutputBytes?: number,
  ): SessionMemoryArtifactLease {
    const availableBytes = this.limitBytes - this.reservedBytes;
    const maxOutputBytes =
      requestedMaxOutputBytes ??
      maximumArtifactBytes(availableBytes, pageBytes);
    const reservationBytes =
      maxOutputBytes + roundedPageBytes(maxOutputBytes, pageBytes);
    this.reserve(reservationBytes);
    return new SessionMemoryArtifactLease(
      this,
      maxOutputBytes,
      reservationBytes,
    );
  }

  reserve(bytes: number): void {
    if (bytes > this.limitBytes - this.reservedBytes) {
      throw memoryBudgetExceeded(this, bytes);
    }
    this.reservedBytes += bytes;
  }

  release(bytes: number): void {
    this.reservedBytes -= bytes;
  }

  snapshot(): AudioTranscoderOutputMemoryReservation {
    return Object.freeze({
      limitBytes: this.limitBytes,
      reservedBytes: this.reservedBytes,
    });
  }
}

class SessionMemoryArtifactLease {
  private reservedBytes: number;
  private state: 'active' | 'committed' | 'released' = 'active';

  constructor(
    private readonly budget: SessionMemoryBudget,
    readonly maxOutputBytes: number,
    reservationBytes: number,
  ) {
    this.reservedBytes = reservationBytes;
  }

  commit(artifactBytes: number): void {
    if (this.state !== 'active') {
      throw invalidConfiguration('Memory artifact lease is already settled.');
    }
    if (
      !Number.isSafeInteger(artifactBytes) ||
      artifactBytes < 0 ||
      artifactBytes > this.maxOutputBytes ||
      artifactBytes > this.reservedBytes
    ) {
      this.release();
      throw invalidMemoryArtifactSize(this.maxOutputBytes, artifactBytes);
    }
    this.budget.release(this.reservedBytes - artifactBytes);
    this.reservedBytes = artifactBytes;
    this.state = 'committed';
  }

  release(): void {
    if (this.state === 'released') {
      return;
    }
    this.budget.release(this.reservedBytes);
    this.reservedBytes = 0;
    this.state = 'released';
  }
}

class PagedMemoryDestination implements OutputDestination {
  private blobController:
    | ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>
    | undefined;
  private closed = false;
  private completion: Promise<Blob> | undefined;
  private disposal: Promise<void> | undefined;
  private discarded = false;
  private length = 0;
  private readonly pageBytes: number;
  private readonly pages = new Map<number, Uint8Array<ArrayBuffer>>();
  private readonly lease: SessionMemoryArtifactLease;
  readonly maxOutputBytes: number;
  readonly storage = 'memory' as const;
  readonly stream: AudioStreamOutput;

  constructor(
    budget: SessionMemoryBudget,
    requestedMaxOutputBytes: number | undefined,
  ) {
    this.pageBytes = Math.max(
      1,
      Math.min(
        MEMORY_MAX_PAGE_BYTES,
        Math.ceil(budget.limitBytes / MEMORY_TARGET_PAGE_COUNT),
      ),
    );
    this.lease = budget.acquireArtifactLease(
      this.pageBytes,
      requestedMaxOutputBytes,
    );
    this.maxOutputBytes = this.lease.maxOutputBytes;
    this.stream = new WritableStream<AudioStreamOutputChunk>({
      abort: () => this.discard(),
      close: () => {
        this.closed = true;
      },
      write: (chunk) => this.write(chunk),
    });
  }

  complete(mimeType: string): Promise<Blob> {
    if (!this.closed || this.discarded) {
      return Promise.reject(
        invalidConfiguration(
          'In-memory output must be closed before it is completed.',
        ),
      );
    }
    this.completion ??= this.createBlob(mimeType);
    return this.completion;
  }

  discard(): Promise<void> {
    this.discarded = true;
    this.blobController?.error(sessionDisposedError());
    this.pages.clear();
    this.disposal ??= (async () => {
      await this.completion?.catch(() => undefined);
      this.releaseReservation();
    })();
    return this.disposal;
  }

  private async createBlob(mimeType: string): Promise<Blob> {
    let committed = false;
    const pageCount = Math.ceil(this.length / this.pageBytes);
    let pageIndex = 0;
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start: (controller) => {
        this.blobController = controller;
      },
      pull: (controller) => {
        if (pageIndex >= pageCount) {
          controller.close();
          return;
        }
        const page =
          this.pages.get(pageIndex) ?? new Uint8Array(this.pageBytes);
        this.pages.delete(pageIndex);
        const remaining = this.length - pageIndex * this.pageBytes;
        controller.enqueue(
          page.subarray(0, Math.min(remaining, this.pageBytes)),
        );
        pageIndex += 1;
      },
    });

    try {
      // Consume and release source pages incrementally during Blob materialization.
      const rawBlob = await new Response(stream).blob();
      const blob = rawBlob.slice(0, rawBlob.size, mimeType);
      this.lease.commit(blob.size);
      committed = true;
      return blob;
    } finally {
      if (!committed) {
        this.lease.release();
      }
      this.blobController = undefined;
      this.pages.clear();
    }
  }

  private write({ data, position }: AudioStreamOutputChunk): void {
    if (this.closed || this.discarded) {
      throw invalidConfiguration('In-memory output is closed.');
    }
    if (!Number.isSafeInteger(position) || position < 0) {
      throw invalidConfiguration('Output write position is invalid.');
    }
    if (data.byteLength === 0) {
      return;
    }
    const end = position + data.byteLength;
    if (!Number.isSafeInteger(end)) {
      throw memoryOutputLimitExceeded(this.maxOutputBytes, end);
    }

    const nextLength = Math.max(this.length, end);
    if (nextLength > this.maxOutputBytes) {
      throw memoryOutputLimitExceeded(this.maxOutputBytes, nextLength);
    }
    let sourceOffset = 0;
    let writePosition = position;
    while (sourceOffset < data.byteLength) {
      const pageIndex = Math.floor(writePosition / this.pageBytes);
      const pageOffset = writePosition % this.pageBytes;
      const writableBytes = Math.min(
        this.pageBytes - pageOffset,
        data.byteLength - sourceOffset,
      );
      const page = this.getPage(pageIndex);
      page.set(
        data.subarray(sourceOffset, sourceOffset + writableBytes),
        pageOffset,
      );
      sourceOffset += writableBytes;
      writePosition += writableBytes;
    }
    this.length = nextLength;
  }

  private getPage(index: number): Uint8Array<ArrayBuffer> {
    const current = this.pages.get(index);
    if (current !== undefined) {
      return current;
    }
    const page = new Uint8Array(this.pageBytes);
    this.pages.set(index, page);
    return page;
  }

  private releaseReservation(): void {
    this.lease.release();
    this.length = 0;
  }
}

function maximumArtifactBytes(
  availableBytes: number,
  pageBytes: number,
): number {
  let low = 0;
  let high = Math.floor(availableBytes / 2);
  while (low < high) {
    const candidate = low + Math.ceil((high - low) / 2);
    const sourcePageCount = Math.ceil(candidate / pageBytes);
    if (sourcePageCount <= Math.floor((availableBytes - candidate) / pageBytes)) {
      low = candidate;
    } else {
      high = candidate - 1;
    }
  }
  return low;
}

function roundedPageBytes(bytes: number, pageBytes: number): number {
  return Math.ceil(bytes / pageBytes) * pageBytes;
}

function memoryBudgetExceeded(
  budget: SessionMemoryBudget,
  requestedBytes: number,
): AudioTranscoderError {
  return new AudioTranscoderError(
    'RESOURCE_LIMIT_EXCEEDED',
    `Session memory budget exceeded: ${budget.snapshot().reservedBytes} bytes reserved, ` +
      `${requestedBytes} requested, ${budget.limitBytes} limit.`,
    { reason: 'output-storage-limit' },
  );
}

function memoryOutputLimitExceeded(
  maxOutputBytes: number,
  attemptedBytes: number,
): AudioTranscoderError {
  return new AudioTranscoderError(
    'RESOURCE_LIMIT_EXCEEDED',
    `Memory output exceeds its reserved artifact capacity (${maxOutputBytes} bytes; attempted end: ${
      Number.isSafeInteger(attemptedBytes)
        ? `${attemptedBytes} bytes`
        : 'an unsafe size'
    }).`,
    { reason: 'output-storage-limit' },
  );
}

function invalidMemoryArtifactSize(
  maxOutputBytes: number,
  artifactBytes: number,
): AudioTranscoderError {
  return new AudioTranscoderError(
    'RESOURCE_LIMIT_EXCEEDED',
    `Materialized memory artifact size is inconsistent with its reserved capacity (${maxOutputBytes} bytes; reported: ${
      Number.isSafeInteger(artifactBytes) && artifactBytes >= 0
        ? `${artifactBytes} bytes`
        : 'an invalid size'
    }).`,
    { reason: 'output-storage-limit' },
  );
}
