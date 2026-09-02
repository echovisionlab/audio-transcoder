import {
  AudioTranscoderError,
  type AudioTranscoderErrorCode,
  type AudioTranscoderErrorReason,
} from '../errors.js';
import type { SerializedWorkerError } from './protocol.js';

const AUDIO_TRANSCODER_ERROR_CODES = new Set<string>([
  'DUPLICATE_REGISTRATION',
  'INVALID_CONFIGURATION',
  'INVALID_AUDIO_DATA',
  'INVALID_PROGRESS',
  'OPERATION_ABORTED',
  'QUEUE_CAPACITY_EXCEEDED',
  'RESOURCE_LIMIT_EXCEEDED',
  'UNSUPPORTED_INPUT',
  'UNSUPPORTED_OUTPUT',
  'WORKER_FAILURE',
  'WORKER_TERMINATED',
  'WORKER_UNAVAILABLE',
]);
const AUDIO_TRANSCODER_ERROR_REASONS = new Set<string>([
  'output-storage-limit',
  'target-size-limit',
]);

export function serializeWorkerError(error: unknown): SerializedWorkerError {
  if (error instanceof Error) {
    const diagnostic = readErrorDiagnostic(error);
    const packageError = serializePackageError(error, diagnostic);
    if (packageError !== null) {
      return packageError;
    }
    return {
      message: diagnostic.message,
      name: diagnostic.name,
      ...(diagnostic.stack === undefined ? {} : { stack: diagnostic.stack }),
    };
  }
  const stack = thrownValueStack(error);
  return {
    message: describeThrownValue(error),
    name: thrownValueName(error),
    ...(stack === undefined ? {} : { stack }),
  };
}

interface ErrorDiagnostic {
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}

function readErrorDiagnostic(error: Error): ErrorDiagnostic {
  const name = readStringProperty(error, 'name') ?? 'Error';
  const stack = readStringProperty(error, 'stack');
  const stackHeadline =
    stack === undefined ? undefined : stack.split('\n', 1)[0];
  const message =
    readStringProperty(error, 'message') ??
    (stackHeadline === undefined || stackHeadline.length === 0
      ? 'An Error was thrown, but its message could not be read.'
      : stackHeadline);
  return {
    message,
    name,
    ...(stack === undefined ? {} : { stack }),
  };
}

function serializePackageError(
  error: Error,
  diagnostic: ErrorDiagnostic,
): SerializedWorkerError | null {
  const code = readStringProperty(error, 'code');
  const reason = readStringProperty(error, 'reason');
  if (
    diagnostic.name !== 'AudioTranscoderError' ||
    !isAudioTranscoderErrorCode(code) ||
    (reason !== undefined && !isAudioTranscoderErrorReason(reason))
  ) {
    return null;
  }
  return {
    code,
    message: diagnostic.message,
    name: diagnostic.name,
    ...(reason === undefined ? {} : { reason }),
  };
}

function isAudioTranscoderErrorCode(
  value: string | undefined,
): value is AudioTranscoderErrorCode {
  return value !== undefined && AUDIO_TRANSCODER_ERROR_CODES.has(value);
}

function isAudioTranscoderErrorReason(
  value: string,
): value is AudioTranscoderErrorReason {
  return AUDIO_TRANSCODER_ERROR_REASONS.has(value);
}

export function deserializeWorkerError(error: SerializedWorkerError): Error {
  if (error.code !== undefined) {
    return new AudioTranscoderError(error.code, error.message, {
      ...(error.reason === undefined ? {} : { reason: error.reason }),
    });
  }
  const deserialized = new Error(error.message);
  deserialized.name = error.name;
  if (error.stack !== undefined) {
    deserialized.stack = error.stack;
  }
  return deserialized;
}

function describeThrownValue(value: unknown): string {
  const message = readStringProperty(value, 'message');
  if (message !== undefined) {
    return message;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to the value's string representation.
  }
  try {
    return String(value);
  } catch {
    return `Unserializable thrown ${typeof value} value.`;
  }
}

function thrownValueName(value: unknown): string {
  return readStringProperty(value, 'name') ?? 'Error';
}

function thrownValueStack(value: unknown): string | undefined {
  return readStringProperty(value, 'stack');
}

function readStringProperty(
  value: unknown,
  property: 'code' | 'message' | 'name' | 'reason' | 'stack',
): string | undefined {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null
  ) {
    return undefined;
  }
  try {
    const candidate = (value as Record<string, unknown>)[property];
    return typeof candidate === 'string' ? candidate : undefined;
  } catch {
    return undefined;
  }
}
