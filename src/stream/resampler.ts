import { AudioTranscoderError } from '../errors.js';
import { createOperationAbortedError } from '../engine/operation-errors.js';
import {
  cleanupOperationResultAfterAbort,
  raceWithOperationAbort,
} from './abortable-operation.js';

const MAX_INPUT_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_CHANNELS = 32;
const MAX_PASS_THROUGH_RATE = 384_000;
const MAX_RESAMPLE_RATE = 192_000;
const MIN_RESAMPLE_RATE = 8_000;
const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;

export interface StreamingResampler {
  /** Idempotently releases converter and WASM memory. */
  close(): void;
  /** Produces the final expected frames; yielded views must not be retained. */
  flush(totalInputFrames: number): Iterable<Float32Array>;
  /** Converts interleaved PCM; yielded views may be reused by the next call. */
  process(input: Float32Array): Iterable<Float32Array>;
}

export type StreamingResamplerFactory = (
  channels: number,
  inputSampleRate: number,
  outputSampleRate: number,
  signal?: AbortSignal,
) => Promise<StreamingResampler | null>;

/** Creates a resampler factory backed by one explicit quality-specific asset. */
export function createStreamingResamplerFactory(
  loadWasm: import('./resampler-wasm-runtime.js').ResamplerWasmLoader,
): StreamingResamplerFactory {
  let sessionFactory:
    | Promise<import('./resampler-wasm-runtime.js').ResamplerWasmSessionFactory>
    | undefined;
  return async (channels, inputSampleRate, outputSampleRate, signal) => {
    return createStreamingResamplerWithSessionFactory(
      channels,
      inputSampleRate,
      outputSampleRate,
      async (sessionChannels, ratio, sessionSignal) => {
        sessionFactory ??= import('./resampler-wasm-runtime.js').then(
          ({ createResamplerWasmSessionFactory }) =>
            createResamplerWasmSessionFactory(loadWasm),
        );
        return (await sessionFactory)(
          sessionChannels,
          ratio,
          sessionSignal,
        );
      },
      signal,
    );
  };
}

async function createStreamingResamplerWithSessionFactory(
  channels: number,
  inputSampleRate: number,
  outputSampleRate: number,
  createSession: import('./resampler-wasm-runtime.js').ResamplerWasmSessionFactory,
  signal?: AbortSignal,
): Promise<StreamingResampler | null> {
  validateChannels(channels);
  if (inputSampleRate === outputSampleRate) {
    validatePassThroughRate(inputSampleRate);
    return null;
  }
  validateResampleRate(inputSampleRate, 'inputSampleRate');
  validateResampleRate(outputSampleRate, 'outputSampleRate');

  const ratio = outputSampleRate / inputSampleRate;
  let converter:
    | import('./resampler-wasm-runtime.js').ResamplerWasmSession
    | null;
  try {
    const sessionCreation = createSession(channels, ratio, signal);
    cleanupOperationResultAfterAbort(
      sessionCreation,
      signal,
      (lateSession) => lateSession.close(),
    );
    converter = await raceWithOperationAbort(
      sessionCreation,
      signal,
    );
  } catch (error: unknown) {
    if (signal?.aborted) {
      throw createOperationAbortedError(signal);
    }
    throw createResamplerInitializationError(error);
  }
  let closed = false;
  let finalized = false;
  let producedFrames = 0;
  let outputBuffer = new Float32Array(0);
  const maxInputFramesByInput = Math.max(
    1,
    Math.floor(MAX_INPUT_BUFFER_BYTES / FLOAT_BYTES / channels),
  );
  const maxOutputSamples = Math.floor(MAX_OUTPUT_BUFFER_BYTES / FLOAT_BYTES);
  const maxOutputFrames = Math.floor(maxOutputSamples / channels);
  const maxInputFramesByOutput = Math.max(
    1,
    Math.floor((maxOutputFrames - 1) / ratio),
  );
  const maxInputFrames = Math.min(
    maxInputFramesByInput,
    maxInputFramesByOutput,
  );

  const processChunk = (
    input: Float32Array,
    requiredSamples: number,
    endOfInput: boolean,
  ): Float32Array => {
    const activeConverter = converter;
    if (activeConverter === null) {
      throw new AudioTranscoderError(
        'INVALID_CONFIGURATION',
        'The streaming resampler is already closed.',
      );
    }
    if (outputBuffer.length < requiredSamples) {
      outputBuffer = new Float32Array(requiredSamples);
    }
    const { inputFramesUsed, outputFramesGenerated } = activeConverter.process(
      input,
      outputBuffer.subarray(0, requiredSamples),
      endOfInput,
    );
    const inputFrames = input.length / channels;
    if (inputFramesUsed !== inputFrames) {
      throw new AudioTranscoderError(
        'INVALID_AUDIO_DATA',
        `The sample-rate converter consumed ${inputFramesUsed} of ${inputFrames} input frames.`,
      );
    }
    producedFrames += outputFramesGenerated;
    return outputBuffer.subarray(0, outputFramesGenerated * channels);
  };

  const process = function* (input: Float32Array): Iterable<Float32Array> {
    if (closed) {
      throw new AudioTranscoderError(
        'INVALID_CONFIGURATION',
        'The streaming resampler is already closed.',
      );
    }
    if (finalized) {
      throw new AudioTranscoderError(
        'INVALID_CONFIGURATION',
        'The streaming resampler is already flushed.',
      );
    }
    if (input.length % channels !== 0) {
      throw new AudioTranscoderError(
        'INVALID_AUDIO_DATA',
        'Interleaved resampler input must contain complete frames.',
      );
    }

    const inputFrames = input.length / channels;
    for (
      let startFrame = 0;
      startFrame < inputFrames;
      startFrame += maxInputFrames
    ) {
      const frames = Math.min(maxInputFrames, inputFrames - startFrame);
      const chunk = input.subarray(
        startFrame * channels,
        (startFrame + frames) * channels,
      );
      const converted = processChunk(
        chunk,
        (Math.ceil(frames * ratio) + 1) * channels,
        false,
      );
      if (converted.length > 0) {
        yield converted;
      }
    }
  };

  return {
    close(): void {
      if (!closed) {
        converter?.close();
        converter = null;
        closed = true;
        outputBuffer = new Float32Array(0);
      }
    },
    *flush(totalInputFrames: number): Iterable<Float32Array> {
      if (closed) {
        throw new AudioTranscoderError(
          'INVALID_CONFIGURATION',
          'The streaming resampler is already closed.',
        );
      }
      if (!Number.isSafeInteger(totalInputFrames) || totalInputFrames < 0) {
        throw new AudioTranscoderError(
          'INVALID_AUDIO_DATA',
          'totalInputFrames must be a non-negative safe integer.',
        );
      }
      if (finalized) return;
      finalized = true;
      const expectedFrames = Math.floor(totalInputFrames * ratio);
      const requiredFrames = expectedFrames - producedFrames;
      if (requiredFrames <= 0) {
        return;
      }
      let flushedFrames = 0;
      while (flushedFrames < requiredFrames) {
        const requestedFrames = Math.min(
          maxOutputFrames,
          requiredFrames - flushedFrames,
        );
        const flushed = processChunk(
          new Float32Array(0),
          requestedFrames * channels,
          true,
        );
        const availableFrames = flushed.length / channels;
        if (availableFrames === 0) break;
        flushedFrames += availableFrames;
        yield flushed;
      }
      if (flushedFrames < requiredFrames) {
        throw new AudioTranscoderError(
          'INVALID_AUDIO_DATA',
          'The sample-rate converter did not flush the expected audio tail.',
        );
      }
      producedFrames = expectedFrames;
    },
    process,
  };
}

function createResamplerInitializationError(
  error: unknown,
): AudioTranscoderError {
  if (error instanceof AudioTranscoderError) {
    return error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new AudioTranscoderError(
    'WORKER_FAILURE',
    `Failed to initialize the runtime-asset sample-rate converter: ${reason}`,
  );
}

function validateChannels(channels: number): void {
  if (
    !Number.isSafeInteger(channels) ||
    channels < 1 ||
    channels > MAX_CHANNELS
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      `channels must be an integer from 1 to ${MAX_CHANNELS}.`,
    );
  }
}

function validatePassThroughRate(sampleRate: number): void {
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < MIN_RESAMPLE_RATE ||
    sampleRate > MAX_PASS_THROUGH_RATE
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      `Equal sample rates must be an integer from ${MIN_RESAMPLE_RATE} to ${MAX_PASS_THROUGH_RATE}.`,
    );
  }
}

function validateResampleRate(sampleRate: number, name: string): void {
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < MIN_RESAMPLE_RATE ||
    sampleRate > MAX_RESAMPLE_RATE
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      `${name} must be an integer from ${MIN_RESAMPLE_RATE} to ${MAX_RESAMPLE_RATE} when resampling.`,
    );
  }
}
