import {
  writeAscii,
  writeExtended80,
  writeInt24BE,
} from '../../codecs/binary.js';
import { sampleToInteger } from '../../codecs/pcm.js';
import { AudioTranscoderError } from '../../errors.js';
import { createOperationAbortedError } from '../../engine/operation-errors.js';
import type {
  AudioStreamEncoder,
  AudioStreamEncoderConfiguration,
} from './contracts.js';

const AIFF_HEADER_BYTES = 54;
const MAX_PCM_ENCODE_SLICE_BYTES = 64 * 1024;
const MAX_UINT32 = 0xffff_ffff;

/** Creates one bounded-memory, seekable AIFF PCM encoder session. */
export function createAiffStreamEncoder(
  configuration: AudioStreamEncoderConfiguration,
  bitDepth: 16 | 24,
): AudioStreamEncoder {
  const bytesPerSample = bitDepth / 8;
  const bytesPerFrame = configuration.channels * bytesPerSample;
  const framesPerChunk = Math.floor(
    Math.min(configuration.outputChunkBytes, MAX_PCM_ENCODE_SLICE_BYTES) /
      bytesPerFrame,
  );
  if (framesPerChunk < 1) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'outputChunkBytes must hold at least one complete AIFF frame.',
    );
  }

  const writer = configuration.writable.getWriter();
  let activeWrite = false;
  let bytesWritten = 0;
  let framesWritten = 0;
  let finalizeAttempt: Promise<void> | null = null;
  let settlement: Promise<void> | null = null;
  let state: 'canceled' | 'finalized' | 'pending' | 'started' | 'starting' =
    'pending';

  const releaseWriter = (): void => {
    if (configuration.writable.locked) {
      writer.releaseLock();
    }
  };

  const abortWriter = (reason: unknown): Promise<void> => {
    settlement ??= writer.abort(reason).finally(releaseWriter);
    return settlement.catch(() => undefined);
  };

  const writeChunk = async (
    data: Uint8Array<ArrayBuffer>,
    position: number,
  ): Promise<void> => {
    throwIfAborted(configuration.signal);
    if (data.byteLength > configuration.outputChunkBytes) {
      throw new AudioTranscoderError(
        'RESOURCE_LIMIT_EXCEEDED',
        'An AIFF output write exceeded outputChunkBytes.',
      );
    }
    await writer.write({ data, position, type: 'write' });
    bytesWritten = Math.max(bytesWritten, position + data.byteLength);
    throwIfAborted(configuration.signal);
  };

  const cancel = async (reason?: unknown): Promise<void> => {
    if (state === 'finalized') {
      return;
    }
    state = 'canceled';
    await abortWriter(reason);
  };

  return {
    cancel,
    finalize(): Promise<void> {
      if (finalizeAttempt !== null) {
        return finalizeAttempt;
      }
      finalizeAttempt = (async () => {
        if (state !== 'started' || activeWrite) {
          throw invalidState('finalize', state, activeWrite);
        }
        try {
          throwIfAborted(configuration.signal);
          const dataBytes = framesWritten * bytesPerFrame;
          const paddingBytes = dataBytes % 2;
          if (paddingBytes !== 0) {
            await writeChunk(
              new Uint8Array(paddingBytes),
              AIFF_HEADER_BYTES + dataBytes,
            );
          }
          await writeChunk(
            createAiffHeader(
              configuration.channels,
              configuration.sampleRate,
              bitDepth,
              framesWritten,
              dataBytes,
            ),
            0,
          );
          throwIfAborted(configuration.signal);
          settlement = writer.close().finally(releaseWriter);
          await settlement;
          state = 'finalized';
        } catch (error) {
          state = 'canceled';
          await abortWriter(error);
          throw error;
        }
      })();
      return finalizeAttempt;
    },
    getBytesWritten: () => bytesWritten,
    async start(): Promise<void> {
      if (state !== 'pending') {
        throw invalidState('start', state, activeWrite);
      }
      state = 'starting';
      try {
        await writeChunk(
          createAiffHeader(
            configuration.channels,
            configuration.sampleRate,
            bitDepth,
            0,
            0,
          ),
          0,
        );
        if (state !== 'starting') {
          throw invalidState('continue', state, activeWrite);
        }
        state = 'started';
      } catch (error) {
        state = 'canceled';
        await abortWriter(error);
        throw error;
      }
    },
    async write(samples, frameOffset): Promise<void> {
      if (state !== 'started' || activeWrite) {
        throw invalidState('write', state, activeWrite);
      }
      throwIfAborted(configuration.signal);
      if (samples.length % configuration.channels !== 0) {
        throw new AudioTranscoderError(
          'INVALID_AUDIO_DATA',
          'AIFF output samples must contain complete interleaved frames.',
        );
      }
      if (!Number.isSafeInteger(frameOffset) || frameOffset !== framesWritten) {
        throw new AudioTranscoderError(
          'INVALID_CONFIGURATION',
          `AIFF frameOffset must be the next sequential frame (${framesWritten}).`,
        );
      }

      const frameCount = samples.length / configuration.channels;
      assertRepresentableAiffSize(
        framesWritten + frameCount,
        bytesPerFrame,
      );
      activeWrite = true;
      try {
        let sourceFrame = 0;
        while (sourceFrame < frameCount) {
          throwIfAborted(configuration.signal);
          const chunkFrames = Math.min(
            framesPerChunk,
            frameCount - sourceFrame,
          );
          const firstSample = sourceFrame * configuration.channels;
          const sampleCount = chunkFrames * configuration.channels;
          const encoded = encodeIntegerPcm(
            samples,
            firstSample,
            sampleCount,
            bitDepth,
          );
          await writeChunk(
            encoded,
            AIFF_HEADER_BYTES +
              (framesWritten + sourceFrame) * bytesPerFrame,
          );
          sourceFrame += chunkFrames;
        }
        framesWritten += frameCount;
      } finally {
        activeWrite = false;
      }
    },
  };
}

function createAiffHeader(
  channels: number,
  sampleRate: number,
  bitDepth: 16 | 24,
  frames: number,
  dataBytes: number,
): Uint8Array<ArrayBuffer> {
  assertRepresentableAiffSize(frames, channels * (bitDepth / 8));
  const paddingBytes = dataBytes % 2;
  const bytes = new Uint8Array(AIFF_HEADER_BYTES);
  const view = new DataView(bytes.buffer);

  writeAscii(view, 0, 'FORM');
  view.setUint32(4, AIFF_HEADER_BYTES + dataBytes + paddingBytes - 8, false);
  writeAscii(view, 8, 'AIFF');

  writeAscii(view, 12, 'COMM');
  view.setUint32(16, 18, false);
  view.setUint16(20, channels, false);
  view.setUint32(22, frames, false);
  view.setUint16(26, bitDepth, false);
  writeExtended80(view, 28, sampleRate);

  writeAscii(view, 38, 'SSND');
  view.setUint32(42, 8 + dataBytes, false);
  view.setUint32(46, 0, false);
  view.setUint32(50, 0, false);
  return bytes;
}

function encodeIntegerPcm(
  samples: Float32Array,
  firstSample: number,
  sampleCount: number,
  bitDepth: 16 | 24,
): Uint8Array<ArrayBuffer> {
  const bytesPerSample = bitDepth / 8;
  const bytes = new Uint8Array(sampleCount * bytesPerSample);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = sampleToInteger(samples[firstSample + index]!, bitDepth);
    const offset = index * bytesPerSample;
    if (bitDepth === 16) {
      view.setInt16(offset, value, false);
    } else {
      writeInt24BE(view, offset, value);
    }
  }
  return bytes;
}

function assertRepresentableAiffSize(
  frames: number,
  bytesPerFrame: number,
): void {
  const dataBytes = frames * bytesPerFrame;
  const formSize = AIFF_HEADER_BYTES + dataBytes + (dataBytes % 2) - 8;
  if (
    !Number.isSafeInteger(frames) ||
    frames < 0 ||
    frames > MAX_UINT32 ||
    !Number.isSafeInteger(dataBytes) ||
    dataBytes > MAX_UINT32 - 8 ||
    formSize > MAX_UINT32
  ) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_OUTPUT',
      'AIFF output exceeds the format\'s 32-bit frame or chunk-size limit.',
      { reason: 'target-size-limit' },
    );
  }
}

function invalidState(
  operation: string,
  state: string,
  activeWrite: boolean,
): AudioTranscoderError {
  return new AudioTranscoderError(
    'INVALID_CONFIGURATION',
    `Cannot ${operation} AIFF output while the encoder is ${
      activeWrite ? 'writing' : state
    }.`,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createOperationAbortedError(signal);
  }
}
