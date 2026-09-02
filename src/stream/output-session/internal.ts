import { AudioTranscoderError } from '../../errors.js';
import type { AudioStreamOutput } from '../contracts.js';
import type { AudioTranscoderOutputStorage } from '../output-session.js';

export interface OutputDestination {
  readonly maxOutputBytes?: number;
  readonly storage: AudioTranscoderOutputStorage;
  readonly stream: AudioStreamOutput;
  complete(mimeType: string): Promise<Blob>;
  discard(): Promise<void>;
}

export function collectFailures(
  settlements: readonly PromiseSettledResult<unknown>[],
  failures: unknown[],
): void {
  for (const settlement of settlements) {
    if (settlement.status === 'rejected') {
      failures.push(settlement.reason);
    }
  }
}

export function throwCollectedFailures(
  failures: readonly unknown[],
  message: string,
): void {
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, message);
  }
}

export function sessionDisposedError(): AudioTranscoderError {
  return invalidConfiguration('Output session is disposing or disposed.');
}

export function invalidConfiguration(message: string): AudioTranscoderError {
  return new AudioTranscoderError('INVALID_CONFIGURATION', message);
}
