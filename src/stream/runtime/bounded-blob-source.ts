import { CustomSource } from 'mediabunny';
import { AudioTranscoderError } from '../../errors.js';
import { createOperationAbortedError } from '../../engine/operation-errors.js';
import type {
  AudioStreamBlobInput,
  AudioStreamHttpInput,
  AudioStreamInput,
} from '../contracts.js';

/**
 * Creates a non-prefetching MediaBunny source with hard per-read and optional
 * cumulative read bounds.
 */
export function createBoundedBlobSource(
  blob: Blob,
  inputReadBytes: number,
  maxTotalReadBytes?: number,
): CustomSource {
  return createBoundedInputSource(
    { blob },
    inputReadBytes,
    maxTotalReadBytes,
  );
}

/** Creates a bounded MediaBunny source for Blob/File or HTTP range input. */
export function createBoundedInputSource(
  input: AudioStreamInput,
  inputReadBytes: number,
  maxTotalReadBytes?: number,
  signal?: AbortSignal,
): CustomSource {
  const size = getAudioStreamInputSize(input);
  if (!Number.isSafeInteger(inputReadBytes) || inputReadBytes < 1) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'inputReadBytes must be a positive safe integer.',
    );
  }
  if (
    maxTotalReadBytes !== undefined &&
    (!Number.isSafeInteger(maxTotalReadBytes) || maxTotalReadBytes < 1)
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'maxTotalReadBytes must be a positive safe integer when provided.',
    );
  }

  let totalReadBytes = 0;

  return new CustomSource({
    getSize: () => size,
    maxCacheSize: inputReadBytes,
    prefetchProfile: 'none',
    read: async (start, end) => {
      assertReadRange(start, end, size);
      const length = end - start;
      if (length > inputReadBytes) {
        throw new AudioTranscoderError(
          'INVALID_AUDIO_DATA',
          `Media input requested ${length} bytes; the per-read limit is ${inputReadBytes} bytes.`,
        );
      }
      if (
        maxTotalReadBytes !== undefined &&
        totalReadBytes > maxTotalReadBytes - length
      ) {
        throw new AudioTranscoderError(
          'RESOURCE_LIMIT_EXCEEDED',
          `Media input exceeded the ${maxTotalReadBytes}-byte cumulative read limit.`,
        );
      }
      totalReadBytes += length;

      const bytes = await readAudioStreamInputRange(input, start, end, signal);
      if (bytes.byteLength !== length) {
        throw new AudioTranscoderError(
          'INVALID_AUDIO_DATA',
          'Media input returned an incomplete byte range.',
        );
      }
      return bytes;
    },
  });
}

export function getAudioStreamInputSize(input: AudioStreamInput): number {
  if (isBlobInput(input)) {
    if (!(input.blob instanceof Blob)) {
      throw invalidConfiguration('A Blob is required for local media input.');
    }
    return input.blob.size;
  }
  validateHttpInput(input);
  return input.http.size;
}

export async function readAudioStreamInputRange(
  input: AudioStreamInput,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const size = getAudioStreamInputSize(input);
  assertReadRange(start, end, size);
  throwIfAborted(signal);

  if (isBlobInput(input)) {
    const buffer = await input.blob.slice(start, end).arrayBuffer();
    throwIfAborted(signal);
    return new Uint8Array(buffer);
  }

  const headers = createHttpHeaders(input);
  headers.set('Range', `bytes=${start}-${end - 1}`);
  let response: Response;
  try {
    response = await fetch(input.http.url, {
      cache: 'no-store',
      credentials: input.http.credentials ?? 'same-origin',
      headers,
      method: 'GET',
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    if (signal?.aborted) {
      throw createOperationAbortedError(signal);
    }
    throw invalidAudio('The HTTP media range request failed.');
  }
  throwIfAborted(signal);
  if (!response.ok) {
    throw invalidAudio(
      `The HTTP media range request returned status ${response.status}.`,
    );
  }
  validateHttpRangeResponse(response, start, end, size);
  const buffer = await response.arrayBuffer();
  throwIfAborted(signal);
  return new Uint8Array(buffer);
}

function isBlobInput(input: AudioStreamInput): input is AudioStreamBlobInput {
  return input !== null && typeof input === 'object' && 'blob' in input;
}

function validateHttpInput(
  input: AudioStreamInput,
): asserts input is AudioStreamHttpInput {
  if (
    input === null ||
    typeof input !== 'object' ||
    !('http' in input) ||
    input.http === null ||
    typeof input.http !== 'object'
  ) {
    throw invalidConfiguration(
      'Streaming input must contain a Blob or HTTP range source.',
    );
  }
  const { credentials, headers, size, url } = input.http;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw invalidConfiguration(
      'HTTP media input size must be a non-negative safe integer.',
    );
  }
  if (
    credentials !== undefined &&
    credentials !== 'include' &&
    credentials !== 'omit' &&
    credentials !== 'same-origin'
  ) {
    throw invalidConfiguration('HTTP media input credentials are invalid.');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidConfiguration('HTTP media input URL must be absolute.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw invalidConfiguration(
      'HTTP media input URL must use HTTP(S) without embedded credentials.',
    );
  }
  if (
    headers !== undefined &&
    (headers === null || typeof headers !== 'object' || Array.isArray(headers))
  ) {
    throw invalidConfiguration('HTTP media input headers must be a record.');
  }
}

function createHttpHeaders(input: AudioStreamHttpInput): Headers {
  let headers: Headers;
  try {
    headers = new Headers(input.http.headers);
  } catch {
    throw invalidConfiguration('HTTP media input headers are invalid.');
  }
  if (headers.has('range')) {
    throw invalidConfiguration(
      'HTTP media input headers must not override the Range header.',
    );
  }
  return headers;
}

function validateHttpRangeResponse(
  response: Response,
  start: number,
  end: number,
  size: number,
): void {
  if (response.status === 200) {
    if (start === 0 && end === size) {
      return;
    }
    throw invalidAudio('The HTTP media source ignored a partial range request.');
  }
  if (response.status !== 206) {
    throw invalidAudio(
      `The HTTP media range request returned unexpected status ${response.status}.`,
    );
  }
  const contentRange = response.headers.get('content-range');
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '');
  if (
    match === null ||
    Number(match[1]) !== start ||
    Number(match[2]) !== end - 1 ||
    Number(match[3]) !== size
  ) {
    throw invalidAudio('The HTTP media source returned an invalid Content-Range.');
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createOperationAbortedError(signal);
  }
}

function invalidAudio(message: string): AudioTranscoderError {
  return new AudioTranscoderError('INVALID_AUDIO_DATA', message);
}

function invalidConfiguration(message: string): AudioTranscoderError {
  return new AudioTranscoderError('INVALID_CONFIGURATION', message);
}

function assertReadRange(start: number, end: number, size: number): void {
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(end) ||
    end <= start ||
    end > size
  ) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'Media input requested an invalid byte range.',
    );
  }
}
