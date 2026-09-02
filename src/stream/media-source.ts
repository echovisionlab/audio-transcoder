import {
  ALL_FORMATS,
  type AudioSample,
  AudioSampleSink,
  Input,
  type InputAudioTrack,
} from 'mediabunny';
import type {
  AudioStreamInput,
  AudioStreamInspection,
} from './contracts.js';
import type { AudioSourceEncoding } from '../engine/contracts.js';
import type { PcmStreamSource } from './pcm-source.js';
import { AudioTranscoderError } from '../errors.js';
import { createOperationAbortedError } from '../engine/operation-errors.js';
import {
  createBoundedInputSource,
  getAudioStreamInputSize,
} from './runtime/bounded-blob-source.js';

interface MediaProbe {
  readonly canDecode: boolean;
  readonly dispose: () => void;
  readonly input: Input<ReturnType<typeof createBoundedInputSource>>;
  readonly inspection: AudioStreamInspection;
  readonly track: InputAudioTrack;
}

type DecoderValidation = 'decoded' | 'empty' | 'failed';

export async function inspectMediaBlob(
  streamInput: AudioStreamInput,
  inputReadBytes: number,
  signal?: AbortSignal,
): Promise<AudioStreamInspection | null> {
  const probe = await probeMediaBlob(streamInput, inputReadBytes, signal);
  if (probe === null) {
    return null;
  }
  probe.dispose();
  return probe.inspection;
}

export async function probeMediaBlobSupport(
  streamInput: AudioStreamInput,
  inputReadBytes: number,
  signal?: AbortSignal,
): Promise<AudioStreamInspection | null> {
  const probe = await probeMediaBlob(
    streamInput,
    inputReadBytes,
    signal,
    inputReadBytes,
  );
  if (probe === null) {
    return null;
  }

  try {
    if (!probe.canDecode) {
      return probe.inspection;
    }
    const validation = await validateFirstDecodedSample(probe, signal);
    if (validation === 'decoded') {
      return probe.inspection;
    }
    return withUnsupportedDecoder(
      probe.inspection,
      validation === 'empty'
        ? 'The audio track did not produce a decodable sample.'
        : 'The browser decoder could not decode the first audio sample.',
    );
  } finally {
    probe.dispose();
  }
}

export async function openMediaBlobSource(
  streamInput: AudioStreamInput,
  inputReadBytes: number,
  pcmChunkBytes: number,
  signal?: AbortSignal,
): Promise<PcmStreamSource | null> {
  assertPcmChunkBytes(pcmChunkBytes);
  const probe = await probeMediaBlob(streamInput, inputReadBytes, signal);
  if (probe === null) {
    return null;
  }
  if (!probe.canDecode) {
    probe.dispose();
    throw new AudioTranscoderError(
      'UNSUPPORTED_INPUT',
      `${probe.inspection.container} ${probe.inspection.codec} cannot be decoded in this browser.`,
    );
  }

  const { inspection, track } = probe;

  return {
    channels: inspection.channels!,
    chunks: (chunkSignal?: AbortSignal) =>
      decodeChunks(
        track,
        inspection,
        pcmChunkBytes,
        probe.dispose,
        chunkSignal,
      ),
    close: probe.dispose,
    durationSeconds: inspection.durationSeconds,
    inspection,
    sampleRate: inspection.sampleRate!,
    totalFrames: null,
  };
}

async function probeMediaBlob(
  streamInput: AudioStreamInput,
  inputReadBytes: number,
  signal?: AbortSignal,
  maxTotalReadBytes?: number,
): Promise<MediaProbe | null> {
  throwIfAborted(signal);
  const input = new Input({
    formats: ALL_FORMATS,
    source: createBoundedInputSource(
      streamInput,
      inputReadBytes,
      maxTotalReadBytes,
      signal,
    ),
  });
  let disposed = false;
  const dispose = (): void => {
    if (!disposed) {
      disposed = true;
      input.dispose();
    }
  };

  try {
    if (!(await raceWithAbort(input.canRead(), signal))) {
      dispose();
      return null;
    }
    const track = await raceWithAbort(input.getPrimaryAudioTrack(), signal);
    if (track === null) {
      throw new AudioTranscoderError(
        'UNSUPPORTED_INPUT',
        'The selected file does not contain an audio track.',
      );
    }
    const [format, codec, channels, sampleRate, rawDurationSeconds, canDecode] =
      await raceWithAbort(
        Promise.all([
          input.getFormat(),
          track.getCodec(),
          track.getNumberOfChannels(),
          track.getSampleRate(),
          track.getDurationFromMetadata(),
          track.canDecode(),
        ]),
        signal,
      );
    throwIfAborted(signal);
    assertAudioParameters(channels, sampleRate);
    const durationSeconds =
      rawDurationSeconds !== null &&
      Number.isFinite(rawDurationSeconds) &&
      rawDurationSeconds >= 0
        ? rawDurationSeconds
        : null;

    const codecName = codec ?? 'Unknown';
    const sourceEncoding = getMediaSourceEncoding(codecName);
    const bitDepth =
      sourceEncoding.kind === 'pcm' ? sourceEncoding.bitDepth : null;
    const inspection: AudioStreamInspection = Object.freeze({
      bitDepth,
      channels,
      codec: codecName,
      container: format.name,
      decodeSupport: canDecode
        ? bitDepth === null
          ? 'likely-browser'
          : 'built-in'
        : 'browser-dependent',
      durationSeconds,
      notes: canDecode ? [] : ['A browser decoder or codec plugin is required.'],
      sampleRate,
      size: getAudioStreamInputSize(streamInput),
      sourceEncoding,
    });
    return { canDecode, dispose, input, inspection, track };
  } catch (error) {
    dispose();
    if (signal?.aborted) {
      throw createOperationAbortedError(signal);
    }
    throw error;
  }
}

async function validateFirstDecodedSample(
  probe: MediaProbe,
  signal?: AbortSignal,
): Promise<DecoderValidation> {
  let iterator: AsyncIterator<AudioSample> | undefined;
  let sample: AudioSample | undefined;
  let validation: DecoderValidation = 'failed';
  const failures: unknown[] = [];
  const abort = (): void => probe.dispose();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    throwIfAborted(signal);
    iterator = new AudioSampleSink(probe.track)
      .samples()
      [Symbol.asyncIterator]();
    const result = await raceWithAbort(iterator.next(), signal);
    throwIfAborted(signal);
    if (result.done) {
      validation = 'empty';
    } else {
      sample = result.value;
      assertDecodedSample(sample, probe.inspection);
      validation = 'decoded';
    }
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      sample?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      const cleanup = iterator?.return?.();
      if (cleanup !== undefined) {
        await raceWithAbort(cleanup, signal);
      }
    } catch (error) {
      failures.push(error);
    }
    signal?.removeEventListener('abort', abort);
  }

  throwIfAborted(signal);
  const resourceFailure = failures.find(isResourceLimitError);
  if (resourceFailure !== undefined) {
    throw resourceFailure;
  }
  if (failures.length > 0) {
    return 'failed';
  }
  return validation;
}

function isResourceLimitError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'RESOURCE_LIMIT_EXCEEDED'
  );
}

function withUnsupportedDecoder(
  inspection: AudioStreamInspection,
  note: string,
): AudioStreamInspection {
  return Object.freeze({
    ...inspection,
    decodeSupport: 'browser-dependent',
    notes: Object.freeze([...inspection.notes, note]),
  });
}

async function* decodeChunks(
  track: InputAudioTrack,
  inspection: AudioStreamInspection,
  pcmChunkBytes: number,
  closeInput: () => void,
  signal?: AbortSignal,
): AsyncGenerator<Float32Array, void, unknown> {
  const abort = (): void => closeInput();
  let iterator: AsyncIterator<AudioSample> | undefined;
  let decodedSamples = 0;
  signal?.addEventListener('abort', abort, { once: true });
  try {
    iterator = new AudioSampleSink(track)
      .samples()
      [Symbol.asyncIterator]();
    while (true) {
      const result = await raceWithAbort(iterator.next(), signal);
      if (result.done) {
        break;
      }
      const sample = result.value;
      decodedSamples += 1;
      try {
        throwIfAborted(signal);
        assertDecodedSample(sample, inspection);

        const frameBytes =
          sample.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
        if (frameBytes > pcmChunkBytes) {
          throw new AudioTranscoderError(
            'INVALID_CONFIGURATION',
            `pcmChunkBytes must be at least ${frameBytes} bytes for ${sample.numberOfChannels} channels.`,
          );
        }

        const maxFramesPerChunk = Math.floor(pcmChunkBytes / frameBytes);
        for (
          let frameOffset = 0;
          frameOffset < sample.numberOfFrames;
          frameOffset += maxFramesPerChunk
        ) {
          throwIfAborted(signal);
          const frameCount = Math.min(
            maxFramesPerChunk,
            sample.numberOfFrames - frameOffset,
          );
          const samples = new Float32Array(
            frameCount * sample.numberOfChannels,
          );
          sample.copyTo(samples, {
            format: 'f32',
            frameCount,
            frameOffset,
            planeIndex: 0,
          });
          yield samples;
        }
      } finally {
        sample.close();
      }
    }
    if (decodedSamples === 0) {
      throw new AudioTranscoderError(
        'UNSUPPORTED_INPUT',
        `${inspection.container} ${inspection.codec} did not produce a decoded audio sample in this browser.`,
      );
    }
  } catch (error) {
    if (signal?.aborted) {
      throw createOperationAbortedError(signal);
    }
    if (decodedSamples === 0 && isEncodingError(error)) {
      throw new AudioTranscoderError(
        'UNSUPPORTED_INPUT',
        `${inspection.container} ${inspection.codec} could not decode its first audio sample in this browser.`,
      );
    }
    throw error;
  } finally {
    try {
      const cleanup = iterator?.return?.();
      if (cleanup !== undefined) {
        await raceWithAbort(cleanup, signal);
      }
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
}

function isEncodingError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'name' in error &&
    error.name === 'EncodingError'
  );
}

function assertDecodedSample(
  sample: Pick<
    AudioSample,
    'numberOfChannels' | 'numberOfFrames' | 'sampleRate'
  >,
  inspection: AudioStreamInspection,
): void {
  if (
    sample.numberOfChannels !== inspection.channels ||
    sample.sampleRate !== inspection.sampleRate
  ) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'Audio parameters changed during decoding.',
    );
  }
  if (
    !Number.isSafeInteger(sample.numberOfFrames) ||
    sample.numberOfFrames < 0
  ) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'The decoded audio sample has an invalid frame count.',
    );
  }
}

function assertPcmChunkBytes(pcmChunkBytes: number): void {
  if (!Number.isSafeInteger(pcmChunkBytes) || pcmChunkBytes < 1) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'pcmChunkBytes must be a positive safe integer.',
    );
  }
}

function assertAudioParameters(channels: number, sampleRate: number): void {
  if (
    !Number.isSafeInteger(channels) ||
    channels < 1 ||
    channels > 32 ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 1
  ) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'Decoded audio parameters are invalid.',
    );
  }
}

function getMediaSourceEncoding(codec: string): AudioSourceEncoding {
  const normalizedCodec = codec.toLowerCase();
  const pcm = /^pcm-([suf])(8|16|24|32|64)(be)?$/.exec(normalizedCodec);
  if (pcm !== null) {
    const sampleFormat = pcm[1] === 'f' ? 'float' : 'integer';
    const bitDepth = Number(pcm[2]);
    return Object.freeze({
      bitDepth,
      endianness:
        bitDepth <= 8 ? 'not-applicable' : pcm[3] === 'be' ? 'big' : 'little',
      kind: 'pcm',
      sampleFormat,
      signedness:
        sampleFormat === 'float'
          ? 'not-applicable'
          : pcm[1] === 'u'
            ? 'unsigned'
            : 'signed',
    });
  }

  if (normalizedCodec === 'flac' || normalizedCodec === 'alac') {
    return Object.freeze({
      bitDepth: null,
      codec: normalizedCodec,
      kind: 'lossless-compressed',
    });
  }
  if (
    normalizedCodec === 'aac' ||
    normalizedCodec === 'ac3' ||
    normalizedCodec === 'alaw' ||
    normalizedCodec === 'eac3' ||
    normalizedCodec === 'mp3' ||
    normalizedCodec === 'opus' ||
    normalizedCodec === 'ulaw' ||
    normalizedCodec === 'vorbis'
  ) {
    return Object.freeze({
      estimatedBitrateBps: null,
      codec: normalizedCodec,
      kind: 'lossy-compressed',
    });
  }
  return Object.freeze({ kind: 'unknown' });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createOperationAbortedError(signal);
  }
}

function raceWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) {
    return operation;
  }
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(createOperationAbortedError(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let activeSignal: AbortSignal | undefined = signal;
    const cleanup = (): void => {
      activeSignal?.removeEventListener('abort', abort);
      activeSignal = undefined;
    };
    const abort = (): void => {
      const abortedSignal = activeSignal!;
      cleanup();
      reject(createOperationAbortedError(abortedSignal));
    };
    activeSignal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
