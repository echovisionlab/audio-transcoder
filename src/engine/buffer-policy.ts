import type {
  AudioInput,
  AudioOperationOptions,
  PcmAudio,
} from './contracts.js';
import type { AudioDecodeEstimate } from '../codecs/contracts.js';
import { AudioTranscoderError } from '../errors.js';

export const AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES = 64 * 1024 * 1024;

export type WorkerPcmChannelPreparation =
  | {
      readonly channel: Float32Array;
      readonly copyLength: number;
      readonly mode: 'copy';
    }
  | {
      readonly channel: Float32Array;
      readonly mode: 'transfer';
    };

export interface WorkerPcmPayloadPlan {
  readonly byteLength: number;
  readonly channels: readonly WorkerPcmChannelPreparation[];
  readonly transferBuffers: readonly ArrayBuffer[];
}

const STREAMING_API_GUIDANCE =
  'Use createAudioTranscoderStreamWorkerEngine() or ' +
  'createAudioTranscoderStreamWorkerPool() for large files.';

export function assertWholeBufferInputWithinLimit(
  input: AudioInput,
  options: AudioOperationOptions,
): void {
  assertWholeBufferBytesWithinLimit(
    input.data.byteLength,
    'audio input',
    options,
  );
}

export function assertWholeBufferDecodeEstimateWithinLimit(
  estimate: AudioDecodeEstimate,
  options: AudioOperationOptions,
): void {
  assertWholeBufferBytesWithinLimit(
    estimatePlanarFloat32ByteLength(estimate.frames, estimate.channels),
    'estimated decoded PCM',
    options,
  );
}

export function assertWholeBufferPcmWithinLimit(
  audio: PcmAudio,
  options: AudioOperationOptions,
): void {
  if (options.unsafeAllowLargeBuffers === true) {
    return;
  }

  assertWholeBufferBytesWithinLimit(
    getUniquePcmBufferByteLength(audio.channelData),
    'PCM input',
    options,
  );
}

export function assertWorkerPcmPayloadWithinLimit(
  plan: WorkerPcmPayloadPlan,
  options: AudioOperationOptions,
): void {
  assertWholeBufferBytesWithinLimit(
    plan.byteLength,
    'prepared Worker PCM payload',
    options,
  );
}

export function createWorkerPcmPayloadPlan(
  channelData: readonly Float32Array[],
  transferInput: boolean | undefined,
): WorkerPcmPayloadPlan {
  const channels: WorkerPcmChannelPreparation[] = [];
  const seenTransferBuffers = new Set<ArrayBuffer>();
  const transferBuffers: ArrayBuffer[] = [];
  let byteLength = 0;

  for (const channel of channelData) {
    const buffer = channel.buffer;
    if (transferInput === true && buffer instanceof ArrayBuffer) {
      channels.push({ channel, mode: 'transfer' });
      if (!seenTransferBuffers.has(buffer)) {
        seenTransferBuffers.add(buffer);
        transferBuffers.push(buffer);
        byteLength = addByteLengths(byteLength, buffer.byteLength);
      }
      continue;
    }

    const copyByteLength = channel.byteLength;
    channels.push({
      channel,
      copyLength: copyByteLength / Float32Array.BYTES_PER_ELEMENT,
      mode: 'copy',
    });
    byteLength = addByteLengths(byteLength, copyByteLength);
  }

  return { byteLength, channels, transferBuffers };
}

export function getUniquePcmBufferByteLength(
  channelData: readonly Float32Array[],
): number {
  const buffers = new Set<ArrayBufferLike>();
  let totalBytes = 0;

  for (const channel of channelData) {
    const buffer = channel.buffer;
    if (buffers.has(buffer)) {
      continue;
    }
    buffers.add(buffer);
    totalBytes = addByteLengths(totalBytes, buffer.byteLength);
  }

  return totalBytes;
}

export function estimatePlanarFloat32ByteLength(
  frames: number,
  channels: number,
): number {
  return multiplySafeByteLengths(
    frames,
    channels,
    Float32Array.BYTES_PER_ELEMENT,
  );
}

function addByteLengths(totalBytes: number, byteLength: number): number {
  const nextTotal = totalBytes + byteLength;
  return Number.isSafeInteger(nextTotal)
    ? nextTotal
    : Number.POSITIVE_INFINITY;
}

function multiplySafeByteLengths(...factors: readonly number[]): number {
  if (factors.some((factor) => !Number.isSafeInteger(factor) || factor < 0)) {
    return Number.POSITIVE_INFINITY;
  }

  let product = 1;
  for (const factor of factors) {
    if (factor !== 0 && product > Number.MAX_SAFE_INTEGER / factor) {
      return Number.POSITIVE_INFINITY;
    }
    product *= factor;
  }
  return product;
}

function assertWholeBufferBytesWithinLimit(
  byteLength: number,
  label: string,
  options: AudioOperationOptions,
): void {
  if (
    options.unsafeAllowLargeBuffers === true ||
    (Number.isSafeInteger(byteLength) &&
      byteLength >= 0 &&
      byteLength <= AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES)
  ) {
    return;
  }

  throw new AudioTranscoderError(
    'RESOURCE_LIMIT_EXCEEDED',
    `Whole-buffer ${label} exceeds the ${formatMiB(
      AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES,
    )} safety limit (${formatByteLength(byteLength)}). ${STREAMING_API_GUIDANCE} ` +
      'unsafeAllowLargeBuffers cannot prevent an out-of-memory failure.',
  );
}

function formatMiB(byteLength: number): string {
  return `${byteLength / (1024 * 1024)} MiB`;
}

function formatByteLength(byteLength: number): string {
  return Number.isFinite(byteLength) ? `${byteLength} bytes` : 'an unsafe size';
}
