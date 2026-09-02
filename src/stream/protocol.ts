import type {
  AudioStreamInput,
  AudioStreamInputSupportResult,
  AudioStreamInspection,
  AudioStreamOperationOptions,
  AudioStreamOutput,
  AudioStreamOutputProbeTarget,
  AudioStreamOutputSupportResult,
  AudioStreamProgress,
  AudioStreamTarget,
  AudioStreamTranscodeResult,
} from './contracts.js';
import type { SerializedWorkerError } from '../worker/protocol.js';
import type {
  RuntimeAssetErrorCode,
  RuntimeAssetSource,
} from '../assets/runtime-asset-provider.js';

export interface AudioStreamWorkerCodecAssetConfiguration {
  readonly fallbackSources?: readonly RuntimeAssetSource[];
  readonly source: RuntimeAssetSource;
}

export interface AudioStreamWorkerAssetLoadState {
  readonly assetName: string;
  readonly error: {
    readonly code: RuntimeAssetErrorCode;
    readonly message: string;
  } | null;
  readonly loadedBytes: number;
  readonly phase: import('../assets/runtime-asset-provider.js').RuntimeAssetLoadingPhase;
  readonly totalBytes: number | null;
}

export type AudioStreamWorkerRequest =
  | {
      readonly codecAssets: AudioStreamWorkerCodecAssetConfiguration;
      readonly type: 'configure';
    }
  | {
      readonly id: number;
      readonly input: AudioStreamInput;
      readonly options: StreamWorkerOperationOptions;
      readonly type: 'inspect';
    }
  | {
      readonly id: number;
      readonly input: AudioStreamInput;
      readonly options: StreamWorkerOperationOptions;
      readonly type: 'probeInputSupport';
    }
  | {
      readonly id: number;
      readonly target: AudioStreamOutputProbeTarget;
      readonly type: 'probeOutputSupport';
    }
  | {
      readonly id: number;
      readonly input: AudioStreamInput;
      readonly options: StreamWorkerOperationOptions;
      readonly output: AudioStreamOutput;
      readonly target: AudioStreamTarget;
      readonly type: 'transcode';
    }
  | {
      readonly id: number;
      readonly type: 'cancel';
    };

export type StreamWorkerOperationOptions = Pick<
  AudioStreamOperationOptions,
  'inputReadBytes' | 'maxOutputBytes' | 'outputChunkBytes' | 'pcmChunkBytes'
>;

export type AudioStreamWorkerResponse =
  | {
      readonly type: 'configured';
    }
  | {
      readonly error: SerializedWorkerError;
      readonly type: 'configuration-error';
    }
  | {
      readonly state: AudioStreamWorkerAssetLoadState;
      readonly type: 'asset-state';
    }
  | {
      readonly id: number;
      readonly progress: AudioStreamProgress;
      readonly type: 'progress';
    }
  | {
      readonly id: number;
      readonly operation: 'inspect';
      readonly type: 'result';
      readonly value: AudioStreamInspection;
    }
  | {
      readonly id: number;
      readonly operation: 'probeInputSupport';
      readonly type: 'result';
      readonly value: AudioStreamInputSupportResult;
    }
  | {
      readonly id: number;
      readonly operation: 'probeOutputSupport';
      readonly type: 'result';
      readonly value: AudioStreamOutputSupportResult;
    }
  | {
      readonly id: number;
      readonly operation: 'transcode';
      readonly type: 'result';
      readonly value: AudioStreamTranscodeResult;
    }
  | {
      readonly error: SerializedWorkerError;
      readonly id: number;
      readonly type: 'error';
    };
