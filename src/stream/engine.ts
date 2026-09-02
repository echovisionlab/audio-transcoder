import type {
  AudioDitherMode,
  AudioStreamInput,
  AudioStreamInputSupportResult,
  AudioStreamInspection,
  AudioStreamOperationOptions,
  AudioStreamOutput,
  AudioStreamOutputProbeOptions,
  AudioStreamOutputProbeTarget,
  AudioStreamOutputSupportResult,
  AudioStreamTarget,
  AudioStreamTranscodeResult,
  AudioTranscoderStreamEngine,
  WavContainerMode,
} from './contracts.js';
import type { PcmStreamSource } from './pcm-source.js';
import type {
  AudioStreamEncoder,
  AudioStreamInputAdapter,
  CreateAudioTranscoderStreamEngineOptions,
} from './runtime/contracts.js';
import type {
  AudioStreamLimits,
  AudioStreamOutputFormatDescriptor,
  AudioStreamOutputFormatId,
  AudioStreamOutputPresetDescriptor,
  AudioStreamOutputChannelConstraints,
  AudioStreamOutputSampleRateConstraints,
  AudioTranscoderStreamCapabilities,
} from './capabilities.js';
import { createDefaultAudioTranscoderStreamCodecRuntime } from './runtime/default.js';
import type {
  AudioTranscoderCodecAssetId,
  AudioTranscoderCodecAssetProvider,
} from '../assets/audio-codec-assets.js';
import { createStreamProgressReporter } from './progress.js';
import {
  createAudioStreamOutputTransaction,
  type AudioStreamOutputTransaction,
} from './output-transaction.js';
import type { AudioOutputPreset } from '../engine/contracts.js';
import { AudioTranscoderError } from '../errors.js';
import { createOperationAbortedError } from '../engine/operation-errors.js';
import { packageEngineInfo } from '../package-metadata.js';
import {
  createAudioStreamOutputProbeCoordinator,
  exerciseAudioStreamOutputRuntime,
  probeAudioStreamOutputSupport,
} from './output-support-probe.js';
import {
  cleanupOperationResultAfterAbort,
  raceWithOperationAbort,
} from './abortable-operation.js';
import { getAudioStreamInputSize } from './runtime/bounded-blob-source.js';

const MAX_UINT32 = 0xffff_ffff;
const RIFF_MAX_OUTPUT_BYTES = MAX_UINT32;
const AIFF_HEADER_BYTES = 54;
const RIFF_WAV_HEADER_BYTES = 44;
const RF64_WAV_HEADER_BYTES = 80;

interface ResolvedEncoding {
  readonly bitDepth: number | null;
  readonly format: AudioStreamOutputFormatId;
  readonly integer: boolean;
  readonly preset: AudioOutputPreset;
}

/** Creates the bounded-memory implementation used inside the stream Worker. */
export function createAudioTranscoderStreamEngine(
  options: CreateAudioTranscoderStreamEngineOptions = {},
): AudioTranscoderStreamEngine {
  if (options.codecRuntime !== undefined && options.codecAssets !== undefined) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Choose either codecAssets for the package runtime or a custom codecRuntime, not both.',
    );
  }
  const codecRuntime =
    options.codecRuntime ??
    createDefaultAudioTranscoderStreamCodecRuntime(
      options.codecAssets ?? UNCONFIGURED_CODEC_ASSETS,
    );
  const {
    buffers: bufferLimits,
    channels: channelLimits,
    sampleRate: sampleRateLimits,
  } = codecRuntime.capabilities.limits;
  const outputProbeCoordinator = createAudioStreamOutputProbeCoordinator();

  return {
    getCapabilities: () => codecRuntime.capabilities,
    getInfo: () => packageEngineInfo,
    getVersion: () => packageEngineInfo.version,
    async inspect(input, options = {}): Promise<AudioStreamInspection> {
      validateInput(input);
      const { inputReadBytes, pcmChunkBytes } = resolveInspectionOptions(
        options,
        bufferLimits,
      );
      const inspection = await inspectWithAdapters(
        codecRuntime.inputs,
        input,
        inputReadBytes,
        pcmChunkBytes,
        options.signal,
      );
      if (inspection !== null) {
        return freezeInspection(inspection);
      }
      return unknownInspection(getAudioStreamInputSize(input));
    },
    async probeInputSupport(
      input,
      options = {},
    ): Promise<AudioStreamInputSupportResult> {
      validateInput(input);
      const { inputReadBytes, pcmChunkBytes } = resolveInspectionOptions(
        options,
        bufferLimits,
      );
      throwIfOperationAborted(options.signal);
      try {
        const inspection = await probeWithAdapters(
          codecRuntime.inputs,
          input,
          inputReadBytes,
          pcmChunkBytes,
          options.signal,
        );
        throwIfOperationAborted(options.signal);
        return inputSupportResult(inspection);
      } catch (error) {
        if (options.signal?.aborted) {
          throw createOperationAbortedError(options.signal);
        }
        throw error;
      }
    },
    async probeOutputSupport(
      target: AudioStreamOutputProbeTarget,
      options: AudioStreamOutputProbeOptions = {},
    ): Promise<AudioStreamOutputSupportResult> {
      return probeAudioStreamOutputSupport(
        codecRuntime.capabilities,
        outputProbeCoordinator,
        target,
        options.signal,
        (resolvedTarget, signal) =>
          exerciseAudioStreamOutputRuntime(
            codecRuntime.capabilities,
            codecRuntime.encoder,
            resolvedTarget,
            signal,
          ),
      );
    },
    async transcode(
      input,
      target,
      writable,
      options = {},
    ): Promise<AudioStreamTranscodeResult> {
      let source: PcmStreamSource | null = null;
      let encoder: AudioStreamEncoder | null = null;
      let outputTransaction: AudioStreamOutputTransaction | null = null;
      let outputCommitStarted = false;
      let resampler: Awaited<
        ReturnType<typeof codecRuntime.resampler.create>
      > = null;

      try {
        validateInput(input);
        validateOutput(writable);
        const operation = resolveOperationOptions(options, bufferLimits);
        const reporter = createStreamProgressReporter(options);
        reporter.report('prepare');

        source = await openWithAdapters(
          codecRuntime.inputs,
          input,
          operation.inputReadBytes,
          operation.pcmChunkBytes,
          options.signal,
        );
        if (source === null) {
          throw new AudioTranscoderError(
            'UNSUPPORTED_INPUT',
            'The selected audio container is unsupported.',
          );
        }
        validateSource(source, channelLimits, sampleRateLimits);

        const resolvedTarget = resolveTarget(
          target,
          source,
          codecRuntime.capabilities,
        );
        assertPredictedOutputWithinLimit(
          resolvedTarget.estimatedOutputBytes,
          operation.maxOutputBytes,
        );
        if (source.sampleRate === resolvedTarget.sampleRate) {
          resampler = null;
        } else {
          const resamplerCreation = codecRuntime.resampler.create(
            resolvedTarget.channels,
            source.sampleRate,
            resolvedTarget.sampleRate,
            resolvedTarget.resampleQuality,
            options.signal,
          );
          cleanupOperationResultAfterAbort(
            resamplerCreation,
            options.signal,
            (lateResampler) => lateResampler?.close(),
          );
          resampler = await raceWithOperationAbort(
            resamplerCreation,
            options.signal,
          );
        }
        reporter.throwIfAborted();

        outputTransaction = createAudioStreamOutputTransaction(
          writable,
          operation.maxOutputBytes,
          resolvedTarget.maxRepresentableOutputBytes ?? undefined,
        );
        const encoderCreation = codecRuntime.encoder.create({
          channels: resolvedTarget.channels,
          outputChunkBytes: operation.outputChunkBytes,
          preset: resolvedTarget.encoding.preset,
          rf64: resolvedTarget.rf64 ?? false,
          sampleRate: resolvedTarget.sampleRate,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          writable: outputTransaction.stream,
        });
        cleanupOperationResultAfterAbort(
          encoderCreation,
          options.signal,
          (lateEncoder, reason) => lateEncoder.cancel(reason),
        );
        encoder = await raceWithOperationAbort(
          encoderCreation,
          options.signal,
        );
        await raceWithOperationAbort(encoder.start(), options.signal);

        const dither = createDither(
          resolvedTarget.dither,
          resolvedTarget.encoding,
          source.inspection.bitDepth,
          input,
        );
        let inputFrames = 0;
        let outputFrames = 0;

        for await (const inputSamples of source.chunks(options.signal)) {
          reporter.throwIfAborted();
          if (inputSamples.length % source.channels !== 0) {
            throw new AudioTranscoderError(
              'INVALID_AUDIO_DATA',
              'Decoded audio chunks must contain complete interleaved frames.',
            );
          }
          const frames = inputSamples.length / source.channels;
          inputFrames += frames;
          const mixed = mixChannels(
            inputSamples,
            source.channels,
            resolvedTarget.channels,
          );
          const convertedChunks = resampler?.process(mixed) ?? [mixed];
          for (const converted of convertedChunks) {
            outputFrames += await writeSamples(
              encoder,
              converted,
              resolvedTarget,
              outputFrames,
              dither,
              options.signal,
            );
          }
          reporter.report(
            'decode',
            inputFrames / source.sampleRate,
            source.durationSeconds,
          );
        }

        if (resampler !== null) {
          for (const tail of resampler.flush(inputFrames)) {
            outputFrames += await writeSamples(
              encoder,
              tail,
              resolvedTarget,
              outputFrames,
              dither,
              options.signal,
            );
          }
        }
        if (outputFrames === 0) {
          throw new AudioTranscoderError(
            'INVALID_AUDIO_DATA',
            'The source did not produce any output audio frames.',
          );
        }

        reporter.report(
          'finalize',
          inputFrames / source.sampleRate,
          source.durationSeconds,
        );
        resampler?.close();
        resampler = null;
        source.close();
        source = null;
        await raceWithOperationAbort(encoder.finalize(), options.signal);
        const bytesWritten = encoder.getBytesWritten();
        validateEncoderBytesWritten(bytesWritten);
        const result: AudioStreamTranscodeResult =
          resolvedTarget.encoding.format === 'wav'
            ? Object.freeze({
                bytesWritten,
                channels: resolvedTarget.channels,
                details: Object.freeze({
                  format: 'wav' as const,
                  rf64: resolvedTarget.rf64!,
                }),
                durationSeconds: outputFrames / resolvedTarget.sampleRate,
                format: 'wav' as const,
                preset: resolvedTarget.encoding.preset,
                rf64: resolvedTarget.rf64!,
                sampleRate: resolvedTarget.sampleRate,
              })
            : Object.freeze({
                bytesWritten,
                channels: resolvedTarget.channels,
                details: Object.freeze({
                  format: resolvedTarget.encoding.format,
                }),
                durationSeconds: outputFrames / resolvedTarget.sampleRate,
                format: resolvedTarget.encoding.format,
                preset: resolvedTarget.encoding.preset,
                sampleRate: resolvedTarget.sampleRate,
              });
        reporter.complete();
        // This synchronous call begins the irreversible destination close.
        // Cancellation was checked by reporter.complete() immediately before
        // it; after this point success (or a close failure) wins.
        outputCommitStarted = true;
        await outputTransaction.commit();
        return result;
      } catch (error) {
        if (outputTransaction === null) {
          await abortWritable(writable, error, options.signal);
        } else {
          await raceWithOperationAbort(
            outputTransaction.abort(error),
            options.signal,
          ).catch(() => undefined);
        }
        if (encoder !== null) {
          await raceWithOperationAbort(
            encoder.cancel(error),
            options.signal,
          ).catch(() => undefined);
        }
        if (options.signal?.aborted && !outputCommitStarted) {
          throw createOperationAbortedError(options.signal);
        }
        throw error;
      } finally {
        resampler?.close();
        source?.close();
      }
    },
  };
}

function validateEncoderBytesWritten(bytesWritten: number): void {
  if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 0) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Audio stream encoder getBytesWritten() must return a non-negative safe integer.',
    );
  }
}

const UNCONFIGURED_CODEC_ASSETS = Object.freeze({
  load(assetName: AudioTranscoderCodecAssetId): Promise<never> {
    return Promise.reject(
      new AudioTranscoderError(
        'INVALID_CONFIGURATION',
        `Codec asset ${assetName} requires an explicit codecAssets provider.`,
      ),
    );
  },
}) as Pick<AudioTranscoderCodecAssetProvider, 'load'>;

function resolveInspectionOptions(
  options: AudioStreamOperationOptions,
  bufferLimits: AudioStreamLimits['buffers'],
): {
  readonly inputReadBytes: number;
  readonly pcmChunkBytes: number;
} {
  return {
    inputReadBytes: validateBufferSize(
      options.inputReadBytes,
      bufferLimits.defaultInputReadBytes,
      'inputReadBytes',
      bufferLimits,
    ),
    pcmChunkBytes: validateBufferSize(
      options.pcmChunkBytes,
      bufferLimits.defaultPcmChunkBytes,
      'pcmChunkBytes',
      bufferLimits,
    ),
  };
}

function inputSupportResult(
  inspection: AudioStreamInspection | null,
): AudioStreamInputSupportResult {
  if (inspection === null) {
    return Object.freeze({ inspection: null, status: 'unsupported' });
  }
  const immutableInspection = freezeInspection(inspection);
  return Object.freeze({
    inspection: immutableInspection,
    status:
      inspection.decodeSupport === 'built-in' ||
      inspection.decodeSupport === 'likely-browser'
        ? 'supported'
        : 'recognized-unsupported',
  });
}

function throwIfOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createOperationAbortedError(signal);
  }
}

interface ResolvedTarget {
  readonly channels: number;
  readonly dither: AudioDitherMode;
  readonly encoding: ResolvedEncoding;
  readonly estimatedOutputBytes: number | null;
  readonly maxRepresentableOutputBytes: number | null;
  readonly resampleQuality: 'balanced' | 'best' | 'fast';
  readonly rf64: boolean | null;
  readonly sampleRate: number;
}

function resolveTarget(
  target: AudioStreamTarget,
  source: PcmStreamSource,
  capabilities: AudioTranscoderStreamCapabilities,
): ResolvedTarget {
  if (target === null || typeof target !== 'object') {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'A streaming output target is required.',
    );
  }
  const selected = findOutputPreset(capabilities, target.presetId);
  if (selected === undefined) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_OUTPUT',
      `Unsupported streaming preset "${String(target.presetId)}".`,
    );
  }
  const encoding = toResolvedEncoding(selected.format, selected.preset);
  const sampleRateLimits = capabilities.limits.sampleRate;
  const sampleRate = target.sampleRate ?? source.sampleRate;
  if (!Number.isSafeInteger(sampleRate)) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Output sampleRate must be a safe integer.',
    );
  }
  validatePresetSampleRate(
    target.presetId,
    sampleRate,
    selected.preset.target.sampleRate,
  );
  if (
    sampleRate !== source.sampleRate &&
    (!isWithinRange(source.sampleRate, sampleRateLimits.resampling) ||
      !isWithinRange(sampleRate, sampleRateLimits.resampling))
  ) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_OUTPUT',
      `Sample-rate conversion supports source and target rates from ${sampleRateLimits.resampling.minimum} to ${sampleRateLimits.resampling.maximum}.`,
    );
  }
  const channels = target.channels ?? source.channels;
  if (!Number.isSafeInteger(channels)) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Output channels must be a safe integer.',
    );
  }
  validatePresetChannels(
    target.presetId,
    channels,
    selected.preset.target.channels,
  );
  if (
    channels !== source.channels &&
    (channels > 2 || source.channels > 2)
  ) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_OUTPUT',
      'Channel conversion currently supports mono and stereo sources only.',
    );
  }

  const estimatedInputFrames =
    source.totalFrames ??
    (source.durationSeconds === null
      ? null
      : Math.ceil(source.durationSeconds * source.sampleRate));
  const estimatedOutputFrames =
    estimatedInputFrames === null
      ? null
      : Math.floor(
          (estimatedInputFrames * sampleRate) / source.sampleRate,
        );
  const estimatedPcmBytes =
    encoding.bitDepth === null || estimatedOutputFrames === null
      ? null
      : estimatedOutputFrames *
          channels *
          (encoding.bitDepth / 8);
  if (encoding.format !== 'wav' && target.wavContainer !== undefined) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_OUTPUT',
      `wavContainer is only valid for WAV presets; "${String(target.presetId)}" outputs ${encoding.format}.`,
    );
  }
  const wavContainer = encoding.format === 'wav'
    ? target.wavContainer ?? 'auto'
    : null;
  if (
    wavContainer !== null &&
    !['auto', 'rf64', 'riff'].includes(wavContainer)
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'wavContainer must be auto, rf64, or riff.',
    );
  }
  const dither = target.dither ?? 'auto';
  if (!['auto', 'none', 'tpdf'].includes(dither)) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'dither must be auto, none, or tpdf.',
    );
  }
  if (
    dither === 'tpdf' &&
    (!encoding.integer || encoding.bitDepth === null)
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      `tpdf dither requires an integer lossless output; "${String(target.presetId)}" is not integer lossless.`,
    );
  }
  const resampleQuality = target.resampleQuality ?? 'balanced';
  if (!['balanced', 'best', 'fast'].includes(resampleQuality)) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'resampleQuality must be balanced, best, or fast.',
    );
  }
  const rf64 = wavContainer === null
    ? null
    : resolveRf64(wavContainer, estimatedPcmBytes);
  const estimatedOutputBytes = estimateOutputBytes(
    encoding.format,
    estimatedPcmBytes,
    rf64,
  );
  assertRepresentableTargetSize(
    encoding.format,
    estimatedOutputFrames,
    estimatedPcmBytes,
    estimatedOutputBytes,
    wavContainer,
  );

  return {
    channels,
    dither,
    encoding,
    estimatedOutputBytes,
    maxRepresentableOutputBytes:
      encoding.format === 'wav' && rf64 === false
        ? RIFF_MAX_OUTPUT_BYTES
        : null,
    resampleQuality,
    rf64,
    sampleRate,
  };
}

function assertPredictedOutputWithinLimit(
  estimatedOutputBytes: number | null,
  maxOutputBytes: number | undefined,
): void {
  if (
    maxOutputBytes === undefined ||
    estimatedOutputBytes === null ||
    estimatedOutputBytes <= maxOutputBytes
  ) {
    return;
  }
  throw new AudioTranscoderError(
    'RESOURCE_LIMIT_EXCEEDED',
    `Predicted uncompressed audio output exceeds maxOutputBytes (${maxOutputBytes} bytes; predicted: ${
      Number.isSafeInteger(estimatedOutputBytes)
        ? `${estimatedOutputBytes} bytes`
        : 'an unsafe size'
    }).`,
    { reason: 'output-storage-limit' },
  );
}

function estimateOutputBytes(
  format: AudioStreamOutputFormatId,
  pcmBytes: number | null,
  rf64: boolean | null,
): number | null {
  if (pcmBytes === null || (format !== 'aiff' && format !== 'wav')) {
    return null;
  }
  if (!Number.isSafeInteger(pcmBytes)) {
    return Number.POSITIVE_INFINITY;
  }
  const overhead =
    format === 'aiff'
      ? AIFF_HEADER_BYTES + (pcmBytes % 2)
      : rf64 === true
        ? RF64_WAV_HEADER_BYTES
        : RIFF_WAV_HEADER_BYTES;
  const outputBytes = pcmBytes + overhead;
  return Number.isSafeInteger(outputBytes)
    ? outputBytes
    : Number.POSITIVE_INFINITY;
}

function resolveRf64(
  mode: WavContainerMode,
  estimatedBytes: number | null,
): boolean {
  if (mode === 'rf64') {
    return true;
  }
  if (mode === 'riff') {
    return false;
  }
  const estimatedRiffBytes = estimateOutputBytes(
    'wav',
    estimatedBytes,
    false,
  );
  return (
    estimatedRiffBytes === null ||
    estimatedRiffBytes > RIFF_MAX_OUTPUT_BYTES
  );
}

function assertRepresentableTargetSize(
  format: AudioStreamOutputFormatId,
  estimatedFrames: number | null,
  estimatedPcmBytes: number | null,
  estimatedOutputBytes: number | null,
  wavContainer: WavContainerMode | null,
): void {
  if (
    format === 'wav' &&
    wavContainer === 'riff' &&
    estimatedOutputBytes !== null &&
    estimatedOutputBytes > RIFF_MAX_OUTPUT_BYTES
  ) {
    throw targetSizeLimit(
      'The predicted WAV exceeds the RIFF 4 GiB limit; use RF64 or auto.',
    );
  }
  if (
    format === 'aiff' &&
    estimatedFrames !== null &&
    estimatedPcmBytes !== null &&
    estimatedOutputBytes !== null &&
    (!Number.isSafeInteger(estimatedFrames) ||
      estimatedFrames > MAX_UINT32 ||
      !Number.isSafeInteger(estimatedPcmBytes) ||
      estimatedPcmBytes > MAX_UINT32 - 8 ||
      !Number.isSafeInteger(estimatedOutputBytes) ||
      estimatedOutputBytes - 8 > MAX_UINT32)
  ) {
    throw targetSizeLimit(
      'The predicted AIFF exceeds the format\'s 32-bit frame or chunk-size limit.',
    );
  }
  if (
    format === 'ogg' &&
    estimatedFrames !== null &&
    !Number.isSafeInteger(estimatedFrames)
  ) {
    throw targetSizeLimit(
      'The predicted Ogg Opus output exceeds the safe JavaScript frame-count limit.',
    );
  }
}

function targetSizeLimit(message: string): AudioTranscoderError {
  return new AudioTranscoderError('UNSUPPORTED_OUTPUT', message, {
    reason: 'target-size-limit',
  });
}

async function writeSamples(
  encoder: AudioStreamEncoder,
  samples: Float32Array,
  target: ResolvedTarget,
  outputFrames: number,
  dither: ((samples: Float32Array) => void) | null,
  signal?: AbortSignal,
): Promise<number> {
  if (samples.length === 0) {
    return 0;
  }
  dither?.(samples);
  const frames = samples.length / target.channels;
  await raceWithOperationAbort(
    encoder.write(samples, outputFrames),
    signal,
  );
  return frames;
}

function mixChannels(
  input: Float32Array,
  sourceChannels: number,
  targetChannels: number,
): Float32Array {
  if (sourceChannels === targetChannels) {
    return input;
  }
  const frames = input.length / sourceChannels;
  const output = new Float32Array(frames * targetChannels);
  if (sourceChannels === 1 && targetChannels === 2) {
    for (let frame = 0; frame < frames; frame += 1) {
      const sample = input[frame]!;
      output[frame * 2] = sample;
      output[frame * 2 + 1] = sample;
    }
    return output;
  }
  for (let frame = 0; frame < frames; frame += 1) {
    output[frame] =
      0.5 * (input[frame * 2]! + input[frame * 2 + 1]!);
  }
  return output;
}

function createDither(
  mode: AudioDitherMode,
  encoding: ResolvedEncoding,
  sourceBitDepth: number | null,
  input: AudioStreamInput,
): ((samples: Float32Array) => void) | null {
  if (!encoding.integer || encoding.bitDepth === null) {
    return null;
  }
  const enabled =
    mode === 'tpdf' ||
    (mode === 'auto' &&
      (sourceBitDepth === null || sourceBitDepth > encoding.bitDepth));
  if (!enabled) {
    return null;
  }

  let state = hashSeed(
    `${input.name ?? ''}:${getAudioStreamInputSize(input)}`,
  );
  const scale = 1 / 2 ** (encoding.bitDepth - 1);
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  return (samples): void => {
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = samples[index]! + (random() - random()) * scale;
    }
  };
}

function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash === 0 ? 1 : hash;
}

function resolveOperationOptions(
  options: AudioStreamOperationOptions,
  bufferLimits: AudioStreamLimits['buffers'],
): {
  readonly inputReadBytes: number;
  readonly maxOutputBytes: number | undefined;
  readonly outputChunkBytes: number;
  readonly pcmChunkBytes: number;
} {
  return {
    inputReadBytes: validateBufferSize(
      options.inputReadBytes,
      bufferLimits.defaultInputReadBytes,
      'inputReadBytes',
      bufferLimits,
    ),
    maxOutputBytes: validateMaxOutputBytes(options.maxOutputBytes),
    outputChunkBytes: validateBufferSize(
      options.outputChunkBytes,
      bufferLimits.defaultOutputChunkBytes,
      'outputChunkBytes',
      bufferLimits,
    ),
    pcmChunkBytes: validateBufferSize(
      options.pcmChunkBytes,
      bufferLimits.defaultPcmChunkBytes,
      'pcmChunkBytes',
      bufferLimits,
    ),
  };
}

function validateMaxOutputBytes(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'maxOutputBytes must be a non-negative safe integer.',
    );
  }
  return value;
}

function validateBufferSize(
  value: number | undefined,
  fallback: number,
  name: string,
  bufferLimits: AudioStreamLimits['buffers'],
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < bufferLimits.minimumBytes ||
    resolved > bufferLimits.maximumBytes
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      `${name} must be an integer from ${bufferLimits.minimumBytes} to ${bufferLimits.maximumBytes}.`,
    );
  }
  return resolved;
}

function validateInput(input: AudioStreamInput): void {
  if (
    input === null ||
    typeof input !== 'object' ||
    (!('blob' in input) && !('http' in input))
  ) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'Streaming input must contain a non-empty Blob or HTTP range source.',
    );
  }
  if ('blob' in input && !(input.blob instanceof Blob)) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'Streaming input must contain a non-empty Blob or HTTP range source.',
    );
  }
  if (getAudioStreamInputSize(input) === 0) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'Streaming input must contain a non-empty Blob or HTTP range source.',
    );
  }
}

function validateSource(
  source: PcmStreamSource,
  channelLimits: AudioStreamLimits['channels'],
  sampleRateLimits: AudioStreamLimits['sampleRate'],
): void {
  const passThroughLimits = sampleRateLimits.passThrough;
  if (
    !Number.isSafeInteger(source.channels) ||
    source.channels < channelLimits.minimum ||
    source.channels > channelLimits.maximum ||
    !Number.isSafeInteger(source.sampleRate) ||
    source.sampleRate < passThroughLimits.minimum ||
    source.sampleRate > passThroughLimits.maximum ||
    (source.totalFrames !== null &&
      (!Number.isSafeInteger(source.totalFrames) || source.totalFrames < 0)) ||
    (source.durationSeconds !== null &&
      (!Number.isFinite(source.durationSeconds) || source.durationSeconds < 0))
  ) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'The decoded audio stream parameters are invalid.',
    );
  }
}

function isWithinRange(
  value: number,
  range: { readonly maximum: number; readonly minimum: number },
): boolean {
  return value >= range.minimum && value <= range.maximum;
}

function validateOutput(output: AudioStreamOutput): void {
  if (!(output instanceof WritableStream) || output.locked) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Streaming output must be an unlocked WritableStream.',
    );
  }
}

function unknownInspection(size: number): AudioStreamInspection {
  return freezeInspection({
    bitDepth: null,
    channels: null,
    codec: 'Unknown',
    container: 'Unknown',
    decodeSupport: 'unknown',
    durationSeconds: null,
    notes: ['No registered inspector recognized this file.'],
    sampleRate: null,
    size,
    sourceEncoding: Object.freeze({ kind: 'unknown' }),
  });
}

function freezeInspection(
  inspection: AudioStreamInspection,
): AudioStreamInspection {
  return Object.freeze({
    ...inspection,
    notes: Object.freeze([...inspection.notes]),
    sourceEncoding: Object.freeze(
      inspection.sourceEncoding ?? { kind: 'unknown' as const },
    ),
  });
}

async function abortWritable(
  writable: AudioStreamOutput,
  reason: unknown,
  signal?: AbortSignal,
): Promise<void> {
  if (writable instanceof WritableStream && !writable.locked) {
    await raceWithOperationAbort(writable.abort(reason), signal).catch(
      () => undefined,
    );
  }
}

function toResolvedEncoding(
  format: AudioStreamOutputFormatDescriptor,
  descriptor: AudioStreamOutputPresetDescriptor,
): ResolvedEncoding {
  return {
    bitDepth: descriptor.kind === 'lossless' ? descriptor.bitDepth : null,
    format: format.id,
    integer:
      descriptor.kind === 'lossless' &&
      descriptor.preset.sampleFormat === 'integer',
    preset: descriptor.preset,
  };
}

function findOutputPreset(
  capabilities: AudioTranscoderStreamCapabilities,
  presetId: string,
): Readonly<{
  readonly format: AudioStreamOutputFormatDescriptor;
  readonly preset: AudioStreamOutputPresetDescriptor;
}> | undefined {
  for (const format of capabilities.outputFormats) {
    const preset = format.presets.find(
      ({ preset: candidate }) => candidate.id === presetId,
    );
    if (preset !== undefined) {
      return { format, preset };
    }
  }
  return undefined;
}

function validatePresetChannels(
  presetId: string,
  value: number,
  constraint: AudioStreamOutputChannelConstraints,
): void {
  if (value >= constraint.minimum && value <= constraint.maximum) {
    return;
  }
  throw new AudioTranscoderError(
    'UNSUPPORTED_OUTPUT',
    `Preset "${presetId}" supports output channels from ${constraint.minimum} to ${constraint.maximum}.`,
  );
}

function validatePresetSampleRate(
  presetId: string,
  value: number,
  constraint: AudioStreamOutputSampleRateConstraints,
): void {
  const supported = constraint.kind === 'range'
    ? value >= constraint.minimum && value <= constraint.maximum
    : constraint.values.includes(value);
  if (supported) {
    return;
  }
  const allowed = constraint.kind === 'range'
    ? `from ${constraint.minimum} to ${constraint.maximum}`
    : `one of ${constraint.values.join(', ')}`;
  throw new AudioTranscoderError(
    'UNSUPPORTED_OUTPUT',
    `Preset "${presetId}" supports output sampleRate ${allowed}.`,
  );
}

async function inspectWithAdapters(
  adapters: readonly AudioStreamInputAdapter[],
  input: AudioStreamInput,
  inputReadBytes: number,
  pcmChunkBytes: number,
  signal?: AbortSignal,
): Promise<AudioStreamInspection | null> {
  const context = { inputReadBytes, pcmChunkBytes, signal };
  for (const adapter of adapters) {
    const inspection = await adapter.inspect(input, context);
    if (inspection !== null) {
      return inspection;
    }
  }
  return null;
}

async function probeWithAdapters(
  adapters: readonly AudioStreamInputAdapter[],
  input: AudioStreamInput,
  inputReadBytes: number,
  pcmChunkBytes: number,
  signal?: AbortSignal,
): Promise<AudioStreamInspection | null> {
  const context = { inputReadBytes, pcmChunkBytes, signal };
  for (const adapter of adapters) {
    const inspection = await (adapter.probe ?? adapter.inspect)(input, context);
    if (inspection !== null) {
      return inspection;
    }
  }
  return null;
}

async function openWithAdapters(
  adapters: readonly AudioStreamInputAdapter[],
  input: AudioStreamInput,
  inputReadBytes: number,
  pcmChunkBytes: number,
  signal?: AbortSignal,
): Promise<PcmStreamSource | null> {
  const context = { inputReadBytes, pcmChunkBytes, signal };
  for (const adapter of adapters) {
    const source = await adapter.open(input, context);
    if (source !== null) {
      return source;
    }
  }
  return null;
}
