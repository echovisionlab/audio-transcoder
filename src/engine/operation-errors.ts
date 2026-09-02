import { AudioTranscoderError } from '../errors.js';

export function createOperationAbortedError(
  signal: AbortSignal,
): AudioTranscoderError {
  const reason = signal.reason;
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'Audio operation was aborted.';
  return new AudioTranscoderError('OPERATION_ABORTED', message);
}

export function createWorkerTerminatedError(): AudioTranscoderError {
  return new AudioTranscoderError(
    'WORKER_TERMINATED',
    'Audio transcoder worker was terminated.',
  );
}
