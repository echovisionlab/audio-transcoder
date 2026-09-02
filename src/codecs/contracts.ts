import type {
  AudioInput,
  AudioInspection,
  AudioOutputPreset,
  DecodedAudio,
  EncodedAudio,
  PcmAudio,
} from '../engine/contracts.js';

export type MaybePromise<T> = Promise<T> | T;

export interface AudioCodecOperationContext {
  /**
   * Long-running adapters must observe this through checkpoints or explicit
   * checks.
   */
  readonly signal: AbortSignal | undefined;

  /**
   * Long-running adapters must call this at bounded intervals. It reports
   * progress, yields to the event loop, then checks cancellation.
   */
  checkpoint(completedFrames: number, totalFrames: number): Promise<void>;

  /**
   * Reports monotonic integer frame counts without yielding or checking
   * cancellation.
   */
  reportProgress(completedFrames: number, totalFrames: number): void;

  /** Throws `OPERATION_ABORTED` when the operation signal is aborted. */
  throwIfAborted(): void;
}

export interface AudioInspectorAdapter {
  readonly formats: readonly string[];
  /** Globally unique among registered inspector adapters. */
  readonly id: string;
  /** Returns `null` to decline the input and continue adapter fallthrough. */
  inspect(input: AudioInput): AudioInspection | null;
}

/**
 * Exact decoded shape: positive safe-integer channels and non-negative frames.
 */
export interface AudioDecodeEstimate {
  readonly channels: number;
  readonly frames: number;
}

export interface AudioDecoderAdapter {
  readonly formats: readonly string[];
  /** Globally unique among registered decoder adapters. */
  readonly id: string;
  /** Returns `null` to decline the input and continue adapter fallthrough. */
  decode(
    input: AudioInput,
    context?: AudioCodecOperationContext,
  ): MaybePromise<DecodedAudio | null>;

  /**
   * Returns the exact decoded Float32 layout. `null` declines this decoder and
   * continues fallthrough without calling `decode()`. Without this hook, memory
   * limits can only be checked after decoding.
   */
  estimateDecodedPcm?(
    input: AudioInput,
    context?: AudioCodecOperationContext,
  ): MaybePromise<AudioDecodeEstimate | null>;
}

export interface AudioEncoderAdapter {
  /** Globally unique among registered encoder adapters. */
  readonly id: string;
  readonly presets: readonly AudioOutputPreset[];
  encode(
    audio: PcmAudio,
    preset: AudioOutputPreset,
    context?: AudioCodecOperationContext,
  ): MaybePromise<EncodedAudio>;
}

export interface AudioTranscoderPlugin {
  /** Optional decode strategies checked before built-in decoders. */
  readonly decoders?: readonly AudioDecoderAdapter[];
  /** Optional encode strategies with globally unique preset IDs. */
  readonly encoders?: readonly AudioEncoderAdapter[];
  /** Globally unique among plugins supplied to one engine. */
  readonly id: string;
  /** Optional header inspectors checked before built-in inspectors. */
  readonly inspectors?: readonly AudioInspectorAdapter[];
}
