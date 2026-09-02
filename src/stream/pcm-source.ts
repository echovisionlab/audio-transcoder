import type { AudioStreamInspection } from './contracts.js';

export interface PcmStreamSource {
  readonly channels: number;
  readonly durationSeconds: number | null;
  readonly inspection: AudioStreamInspection;
  readonly sampleRate: number;
  readonly totalFrames: number | null;
  /**
   * Yields interleaved Float32 PCM. Consumers must finish using each chunk
   * before requesting the next one because adapters may reuse its storage.
   */
  chunks(signal?: AbortSignal): AsyncGenerator<Float32Array, void, unknown>;
  /** Idempotently releases decoder, input, and WASM resources. */
  close(): void;
}
