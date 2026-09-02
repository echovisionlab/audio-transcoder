/**
 * Stable rejected-operation categories. Registration, configuration, data, and
 * progress codes identify caller or adapter contract violations. Unsupported
 * codes mean no installed path can perform the requested operation. Abort,
 * queue, and resource codes are control-flow or limit failures, not support
 * verdicts. Worker codes describe availability or terminal Worker lifecycle
 * failures. Output-support verdicts are returned values and are not this type.
 */
export type AudioTranscoderErrorCode =
  | 'DUPLICATE_REGISTRATION'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_AUDIO_DATA'
  | 'INVALID_PROGRESS'
  | 'OPERATION_ABORTED'
  | 'QUEUE_CAPACITY_EXCEEDED'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'UNSUPPORTED_INPUT'
  | 'UNSUPPORTED_OUTPUT'
  | 'WORKER_FAILURE'
  | 'WORKER_TERMINATED'
  | 'WORKER_UNAVAILABLE';

/** Stable machine-readable context for errors that share the same `code`. */
export type AudioTranscoderErrorReason =
  | 'output-storage-limit'
  | 'target-size-limit';

export interface AudioTranscoderErrorOptions {
  readonly reason?: AudioTranscoderErrorReason;
}

/**
 * Package-defined error. Branch on `code` and, when needed, optional `reason`;
 * never branch on the human-readable message.
 */
export class AudioTranscoderError extends Error {
  readonly code: AudioTranscoderErrorCode;
  readonly reason?: AudioTranscoderErrorReason;

  constructor(
    code: AudioTranscoderErrorCode,
    message: string,
    options: AudioTranscoderErrorOptions = {},
  ) {
    super(message);
    this.name = 'AudioTranscoderError';
    this.code = code;
    if (options.reason !== undefined) {
      this.reason = options.reason;
    }
  }
}
