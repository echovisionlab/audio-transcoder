import type { AudioStreamOutput } from './contracts.js';
import { invalidConfiguration } from './output-session/internal.js';
import { DefaultOutputSession } from './output-session/session.js';

export const AUDIO_TRANSCODER_OUTPUT_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;

const DEFAULT_NAMESPACE = 'audio-transcoder';
const NAMESPACE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export type AudioTranscoderOutputStorage = 'memory' | 'opfs';

export interface CreateAudioTranscoderOutputSessionOptions {
  /**
   * Starts best-effort disposal on `pagehide`. Browsers do not wait for async
   * handlers, so callers must use `dispose()` when completion must be observed.
   * BFCache transitions (`event.persisted`) keep the session active.
   */
  readonly disposeOnPageHide?: boolean;
  /**
   * Aggregate reservation limit for all memory-backed outputs in this session.
   * Pending and completed artifacts share the limit; Blob completion reserves
   * output-sized copy headroom. Defaults to 128 MiB.
   */
  readonly memoryLimitBytes?: number;
  /** Origin-private parent directory. Use a stable, application-owned name. */
  readonly namespace?: string;
}

export interface AudioTranscoderOutputMetadata {
  readonly mimeType: string;
  readonly name: string;
}

export interface AudioTranscoderOutputArtifact
  extends AudioTranscoderOutputMetadata {
  /**
   * Blob or File suitable for `URL.createObjectURL()` while this artifact is
   * active. An OPFS-backed value is guaranteed readable only until `dispose()`
   * starts because cleanup removes its backing file. Memory-backed references
   * may remain readable, but this API makes no post-disposal guarantee.
   */
  readonly blob: Blob;
  readonly size: number;
  readonly storage: AudioTranscoderOutputStorage;
  /**
   * Releases owned storage or its session memory reservation. Concurrent calls
   * share one attempt; a rejected attempt may be retried, and success is
   * idempotent. Treat `blob` as unusable as soon as disposal starts.
   */
  dispose(): Promise<void>;
}

export interface AudioTranscoderOutputMemoryReservation {
  readonly limitBytes: number;
  /**
   * Bytes reserved for pending pages, Blob copy headroom, and completed Blobs.
   * Browser overhead and Blob references retained after disposal are excluded.
   */
  readonly reservedBytes: number;
}

export interface CreateAudioTranscoderPendingOutputOptions {
  /**
   * Exact final-artifact capacity to reserve if this destination uses the
   * memory fallback. The lease also covers page rounding and Blob
   * materialization headroom. Omit to reserve the largest currently safe
   * capacity; OPFS destinations do not consume this memory reservation.
   */
  readonly maxMemoryArtifactBytes?: number;
}

export interface AudioTranscoderPendingOutput {
  /**
   * Guaranteed maximum final artifact size for this destination. Present for
   * the bounded-memory fallback and absent for browser-quota-managed OPFS.
   * Pass this value to `transcode()` as `maxOutputBytes`.
   */
  readonly maxOutputBytes?: number;
  readonly storage: AudioTranscoderOutputStorage;
  /** Seekable destination passed directly to a streaming transcoder. */
  readonly stream: AudioStreamOutput;
  /** Call only after the transcoder has successfully closed `stream`. */
  complete(
    metadata: AudioTranscoderOutputMetadata,
  ): Promise<AudioTranscoderOutputArtifact>;
  /**
   * Aborts and removes an incomplete destination. Concurrent calls share one
   * attempt; a rejected attempt may be retried, and success is idempotent.
   */
  discard(): Promise<void>;
}

export interface AudioTranscoderOutputSession {
  /** Creates a tracked output destination. This session owns it until disposal. */
  create(
    options?: CreateAudioTranscoderPendingOutputOptions,
  ): Promise<AudioTranscoderPendingOutput>;
  /**
   * Idempotently settles every tracked output and artifact before resolving.
   * A resource whose earlier cleanup failed remains tracked and is retried by
   * this call; cleanup failures are reported by the returned rejection.
   */
  dispose(): Promise<void>;
  /** Resolves after lazy storage selection. */
  getStorageMode(): Promise<AudioTranscoderOutputStorage>;
  /** Returns the current session-wide memory reservation. */
  getMemoryReservation(): AudioTranscoderOutputMemoryReservation;
}

/**
 * Creates a browser-local output session. OPFS is preferred when available;
 * otherwise all outputs share one hard-limited paged-memory budget.
 */
export function createAudioTranscoderOutputSession(
  options: CreateAudioTranscoderOutputSessionOptions = {},
): AudioTranscoderOutputSession {
  const namespace = validateNamespace(options.namespace ?? DEFAULT_NAMESPACE);
  const memoryLimitBytes = validateMemoryLimit(
    options.memoryLimitBytes ?? AUDIO_TRANSCODER_OUTPUT_MEMORY_LIMIT_BYTES,
  );
  if (
    options.disposeOnPageHide !== undefined &&
    typeof options.disposeOnPageHide !== 'boolean'
  ) {
    throw invalidConfiguration('disposeOnPageHide must be a boolean.');
  }
  return new DefaultOutputSession(
    namespace,
    memoryLimitBytes,
    options.disposeOnPageHide ?? false,
  );
}

function validateNamespace(namespace: string): string {
  if (
    namespace === '.' ||
    namespace === '..' ||
    !NAMESPACE_PATTERN.test(namespace)
  ) {
    throw invalidConfiguration(
      'namespace must be a 1-64 character application-owned directory name.',
    );
  }
  return namespace;
}

function validateMemoryLimit(memoryLimitBytes: number): number {
  if (!Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes <= 0) {
    throw invalidConfiguration(
      'memoryLimitBytes must be a positive safe integer.',
    );
  }
  return memoryLimitBytes;
}
