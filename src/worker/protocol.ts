import type {
  AudioInput,
  AudioProgress,
  DecodedAudio,
  EncodedAudio,
  PcmAudio,
} from '../engine/contracts.js';
import type {
  AudioTranscoderErrorCode,
  AudioTranscoderErrorReason,
} from '../errors.js';

export type WorkerOperation = 'decode' | 'encode' | 'transcode';

export type AudioWorkerRequest =
  | {
      readonly id: number;
      readonly input: AudioInput;
      readonly type: 'decode';
      readonly unsafeAllowLargeBuffers?: boolean;
    }
  | {
      readonly audio: PcmAudio;
      readonly id: number;
      readonly presetId: string;
      readonly type: 'encode';
      readonly unsafeAllowLargeBuffers?: boolean;
    }
  | {
      readonly id: number;
      readonly input: AudioInput;
      readonly presetId: string;
      readonly type: 'transcode';
      readonly unsafeAllowLargeBuffers?: boolean;
    }
  | {
      readonly id: number;
      readonly type: 'cancel';
    };

export interface SerializedWorkerError {
  readonly code?: AudioTranscoderErrorCode;
  readonly message: string;
  readonly name: string;
  readonly reason?: AudioTranscoderErrorReason;
  readonly stack?: string;
}

export type AudioWorkerResponse =
  | {
      readonly id: number;
      readonly progress: AudioProgress;
      readonly type: 'progress';
    }
  | {
      readonly id: number;
      readonly operation: 'decode';
      readonly type: 'result';
      readonly value: DecodedAudio;
    }
  | {
      readonly id: number;
      readonly operation: 'encode' | 'transcode';
      readonly type: 'result';
      readonly value: EncodedAudio;
    }
  | {
      readonly error: SerializedWorkerError;
      readonly id: number;
      readonly type: 'error';
    };
