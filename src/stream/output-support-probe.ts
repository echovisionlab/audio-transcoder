import type { AudioOutputPreset } from '../engine/contracts.js';
import {
  createOperationAbortedError,
} from '../engine/operation-errors.js';
import { AudioTranscoderError } from '../errors.js';
import {
  cleanupOperationResultAfterAbort,
  raceWithOperationAbort,
} from './abortable-operation.js';
import type {
  AudioStreamOutputProbeTarget,
  AudioStreamOutputSupportResult,
  AudioStreamSupportedOutputResult,
  AudioStreamUnavailableOutputResult,
  AudioStreamUnsupportedOutputConfigurationResult,
} from './contracts.js';
import type {
  AudioStreamOutputFormatDescriptor,
  AudioStreamOutputPresetDescriptor,
  AudioStreamOutputSampleRateConstraints,
  AudioTranscoderStreamCapabilities,
} from './capabilities.js';
import type { AudioStreamEncoderAdapter } from './runtime/contracts.js';

const PROBE_PCM_LIMIT_BYTES = 32 * 1024;
const PROBE_FRAMES = 256;
const PROBE_OUTPUT_CHUNK_BYTES = 64 * 1024;
const PROBE_OUTPUT_LIMIT_BYTES = 512 * 1024;

/** @internal Maximum successful exact-target results retained per runtime. */
export const AUDIO_STREAM_OUTPUT_PROBE_MAX_CACHED_SUPPORTED = 32;
/** @internal Maximum waiting unique targets; the active probe is excluded. */
export const AUDIO_STREAM_OUTPUT_PROBE_MAX_QUEUED_UNIQUE = 8;

type RuntimeOutputSupportResult =
  | AudioStreamSupportedOutputResult
  | AudioStreamUnavailableOutputResult;

interface ResolvedOutputProbeTarget {
  readonly format: AudioStreamOutputFormatDescriptor;
  readonly preset: AudioOutputPreset;
  readonly target: AudioStreamOutputProbeTarget;
}

interface DiscardOutput {
  getBytesReceived(): number;
  readonly stream: WritableStream<{
    readonly data: Uint8Array<ArrayBuffer>;
    readonly position: number;
    readonly type: 'write';
  }>;
}

interface CoordinatedProbe {
  readonly controller: AbortController;
  readonly key: string;
  readonly operation: (
    signal: AbortSignal,
  ) => Promise<AudioStreamOutputSupportResult>;
  readonly promise: Promise<AudioStreamOutputSupportResult>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: AudioStreamOutputSupportResult) => void;
  settled: boolean;
  state: 'active' | 'queued';
  subscribers: number;
}

/** @internal Bounded successful-result cache and serial runtime-probe queue. */
export interface AudioStreamOutputProbeCoordinator {
  clear(reason?: unknown): void;
  run(
    target: AudioStreamOutputProbeTarget,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<AudioStreamOutputSupportResult>,
  ): Promise<AudioStreamOutputSupportResult>;
}

/** @internal */
export function createAudioStreamOutputProbeCoordinator(): AudioStreamOutputProbeCoordinator {
  const pendingByKey = new Map<string, CoordinatedProbe>();
  let queued: CoordinatedProbe[] = [];
  const supported = new Map<string, AudioStreamSupportedOutputResult>();
  let active: CoordinatedProbe | undefined;

  const startNext = (): void => {
    const entry = queued.shift();
    if (entry === undefined) {
      return;
    }
    start(entry);
  };

  const settle = (
    entry: CoordinatedProbe,
    result: AudioStreamOutputSupportResult,
  ): void => {
    entry.settled = true;
    active = undefined;
    if (pendingByKey.get(entry.key) === entry) {
      pendingByKey.delete(entry.key);
    }
    if (result.status === 'supported' && !entry.controller.signal.aborted) {
      rememberSupported(supported, entry.key, result);
    }
    entry.resolve(result);
    startNext();
  };

  const fail = (entry: CoordinatedProbe, error: unknown): void => {
    entry.settled = true;
    active = undefined;
    if (pendingByKey.get(entry.key) === entry) {
      pendingByKey.delete(entry.key);
    }
    entry.reject(error);
    startNext();
  };

  const start = (entry: CoordinatedProbe): void => {
    active = entry;
    entry.state = 'active';
    void Promise.resolve()
      .then(() => entry.operation(entry.controller.signal))
      .then(
        (result) => settle(entry, result),
        (error: unknown) => fail(entry, error),
      );
  };

  const abandon = (entry: CoordinatedProbe, reason: unknown): void => {
    pendingByKey.delete(entry.key);
    entry.controller.abort(reason);
    if (entry.state === 'queued') {
      queued = queued.filter((candidate) => candidate !== entry);
      entry.settled = true;
      entry.reject(createOperationAbortedError(entry.controller.signal));
    }
  };

  return {
    clear(reason): void {
      supported.clear();
      const failure = reason ?? new AudioTranscoderError(
        'OPERATION_ABORTED',
        'The output probe coordinator was cleared.',
      );
      const running = active;
      const waiting = [...queued];
      queued = [];
      pendingByKey.clear();
      if (running !== undefined) {
        running.controller.abort(failure);
        running.reject(failure);
      }
      for (const entry of waiting) {
        entry.settled = true;
        entry.controller.abort(failure);
        entry.reject(failure);
      }
    },
    run(target, signal, operation): Promise<AudioStreamOutputSupportResult> {
      throwIfAborted(signal);
      const key = probeCacheKey(target);
      const cached = supported.get(key);
      if (cached !== undefined) {
        supported.delete(key);
        supported.set(key, cached);
        return Promise.resolve(cached);
      }
      const existing = pendingByKey.get(key);
      if (existing !== undefined) {
        return subscribeToProbe(existing, signal, (reason) =>
          abandon(existing, reason),
        );
      }
      if (
        active !== undefined &&
        queued.length >= AUDIO_STREAM_OUTPUT_PROBE_MAX_QUEUED_UNIQUE
      ) {
        return Promise.reject(
          new AudioTranscoderError(
            'QUEUE_CAPACITY_EXCEEDED',
            `Audio output probe queue is full (maxQueued: ${AUDIO_STREAM_OUTPUT_PROBE_MAX_QUEUED_UNIQUE}; active probe excluded).`,
          ),
        );
      }

      let resolve!: (result: AudioStreamOutputSupportResult) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<AudioStreamOutputSupportResult>(
        (promiseResolve, promiseReject) => {
          resolve = promiseResolve;
          reject = promiseReject;
        },
      );
      const entry: CoordinatedProbe = {
        controller: new AbortController(),
        key,
        operation,
        promise,
        reject,
        resolve,
        settled: false,
        state: active === undefined ? 'active' : 'queued',
        subscribers: 0,
      };
      void promise.catch(() => undefined);
      pendingByKey.set(key, entry);
      if (active === undefined) {
        start(entry);
      } else {
        queued.push(entry);
      }
      return subscribeToProbe(entry, signal, (reason) =>
        abandon(entry, reason),
      );
    },
  };
}

/**
 * Validates one exact target before entering the cache or codec runtime, then
 * coalesces identical runtime probes. Static mismatches are never encoded.
 *
 * @internal
 */
export function probeAudioStreamOutputSupport(
  capabilities: AudioTranscoderStreamCapabilities,
  coordinator: AudioStreamOutputProbeCoordinator,
  target: AudioStreamOutputProbeTarget,
  signal: AbortSignal | undefined,
  operation: (
    target: AudioStreamOutputProbeTarget,
    signal: AbortSignal,
  ) => Promise<AudioStreamOutputSupportResult>,
): Promise<AudioStreamOutputSupportResult> {
  const resolution = resolveOutputProbeTarget(capabilities, target);
  throwIfAborted(signal);
  if ('result' in resolution) {
    return Promise.resolve(resolution.result);
  }
  return coordinator.run(resolution.target, signal, (sharedSignal) =>
    operation(resolution.target, sharedSignal),
  );
}

/** Performs the bounded discard-only encode used by direct runtime probes. */
export async function exerciseAudioStreamOutputRuntime(
  capabilities: AudioTranscoderStreamCapabilities,
  encoderAdapter: AudioStreamEncoderAdapter,
  target: AudioStreamOutputProbeTarget,
  signal: AbortSignal,
): Promise<RuntimeOutputSupportResult> {
  const resolution = resolveOutputProbeTarget(capabilities, target);
  if ('result' in resolution) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'A runtime output probe requires a statically supported target.',
    );
  }

  const output = createDiscardOutput();
  let encoder: Awaited<ReturnType<AudioStreamEncoderAdapter['create']>> | null =
    null;
  let phase: AudioStreamUnavailableOutputResult['reason'] = 'encoder-create';

  try {
    throwIfAborted(signal);
    const encoderCreation = encoderAdapter.create({
      channels: resolution.target.channels,
      outputChunkBytes: PROBE_OUTPUT_CHUNK_BYTES,
      preset: resolution.preset,
      rf64: resolution.format.id === 'wav' ? false : null,
      sampleRate: resolution.target.sampleRate,
      signal,
      writable: output.stream,
    });
    cleanupOperationResultAfterAbort(
      encoderCreation,
      signal,
      (lateEncoder, reason) => lateEncoder.cancel(reason),
    );
    encoder = await raceWithOperationAbort(
      encoderCreation,
      signal,
    );
    throwIfAborted(signal);

    phase = 'encoder-start';
    await raceWithOperationAbort(encoder.start(), signal);
    throwIfAborted(signal);

    phase = 'encoder-write';
    await raceWithOperationAbort(
      encoder.write(createProbeSamples(resolution.target.channels), 0),
      signal,
    );
    throwIfAborted(signal);

    phase = 'encoder-finalize';
    await raceWithOperationAbort(encoder.finalize(), signal);
    throwIfAborted(signal);
    if (
      output.getBytesReceived() === 0 ||
      !(encoder.getBytesWritten() > 0)
    ) {
      return runtimeUnavailableResult(
        'encoder-no-output',
        'The encoder finalized without producing output bytes.',
      );
    }
    return SUPPORTED_OUTPUT_RESULT;
  } catch (error) {
    if (encoder !== null) {
      await raceWithOperationAbort(encoder.cancel(error), signal).catch(
        () => undefined,
      );
    }
    await raceWithOperationAbort(
      abortDiscardOutput(output.stream, error),
      signal,
    ).catch(() => undefined);
    if (signal.aborted) {
      throw createOperationAbortedError(signal);
    }
    if (isRejectedControlFlow(error)) {
      throw error;
    }
    return runtimeUnavailableResult(phase, error);
  }
}

const SUPPORTED_OUTPUT_RESULT = Object.freeze({
  code: 'SUPPORTED',
  message: 'The output runtime probe succeeded.',
  reason: 'runtime-verified',
  status: 'supported',
} satisfies AudioStreamSupportedOutputResult);

function resolveOutputProbeTarget(
  capabilities: AudioTranscoderStreamCapabilities,
  target: AudioStreamOutputProbeTarget,
):
  | ResolvedOutputProbeTarget
  | { readonly result: AudioStreamUnsupportedOutputConfigurationResult } {
  validateOutputProbeTargetShape(target);
  const selected = findOutputPreset(capabilities, target.presetId);
  if (selected === undefined) {
    return {
      result: staticUnsupportedResult(
        'preset',
        `Preset "${target.presetId}" is not installed.`,
      ),
    };
  }
  if (
    target.channels < selected.preset.target.channels.minimum ||
    target.channels > selected.preset.target.channels.maximum
  ) {
    return {
      result: staticUnsupportedResult(
        'channels',
        `Preset "${target.presetId}" does not support ${target.channels} channels.`,
      ),
    };
  }
  if (!supportsSampleRate(selected.preset.target.sampleRate, target.sampleRate)) {
    return {
      result: staticUnsupportedResult(
        'sample-rate',
        `Preset "${target.presetId}" does not support ${target.sampleRate} Hz.`,
      ),
    };
  }
  return {
    format: selected.format,
    preset: selected.preset.preset,
    target: Object.freeze({
      channels: target.channels,
      presetId: target.presetId,
      sampleRate: target.sampleRate,
    }),
  };
}

function findOutputPreset(
  capabilities: AudioTranscoderStreamCapabilities,
  presetId: string,
):
  | {
      readonly format: AudioStreamOutputFormatDescriptor;
      readonly preset: AudioStreamOutputPresetDescriptor;
    }
  | undefined {
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

function validateOutputProbeTargetShape(
  target: AudioStreamOutputProbeTarget,
): void {
  if (target === null || typeof target !== 'object') {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'An output support probe target is required.',
    );
  }
  if (typeof target.presetId !== 'string' || target.presetId.length === 0) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Output probe presetId must be a non-empty string.',
    );
  }
  if (!Number.isSafeInteger(target.channels)) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Output probe channels must be a safe integer.',
    );
  }
  if (!Number.isSafeInteger(target.sampleRate)) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Output probe sampleRate must be a safe integer.',
    );
  }
}

function supportsSampleRate(
  constraint: AudioStreamOutputSampleRateConstraints,
  sampleRate: number,
): boolean {
  return constraint.kind === 'range'
    ? sampleRate >= constraint.minimum && sampleRate <= constraint.maximum
    : constraint.values.includes(sampleRate);
}

function staticUnsupportedResult(
  reason: AudioStreamUnsupportedOutputConfigurationResult['reason'],
  message: string,
): AudioStreamUnsupportedOutputConfigurationResult {
  return Object.freeze({
    code: 'UNSUPPORTED_OUTPUT',
    message,
    reason,
    status: 'unsupported-configuration',
  });
}

function runtimeUnavailableResult(
  reason: AudioStreamUnavailableOutputResult['reason'],
  error: unknown,
): AudioStreamUnavailableOutputResult {
  const detail = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'The encoder runtime failed.';
  return Object.freeze({
    code: 'OUTPUT_RUNTIME_UNAVAILABLE',
    message: detail,
    reason,
    status: 'runtime-unavailable',
  });
}

function createProbeSamples(channels: number): Float32Array {
  const maximumFrames = Math.floor(PROBE_PCM_LIMIT_BYTES / (channels * 4));
  if (maximumFrames < 1) {
    throw new AudioTranscoderError(
      'RESOURCE_LIMIT_EXCEEDED',
      'The output probe channel count exceeds its PCM safety bound.',
    );
  }
  const frames = Math.min(PROBE_FRAMES, maximumFrames);
  const samples = new Float32Array(frames * channels);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = ((frame % 17) - 8) / 64;
    for (let channel = 0; channel < channels; channel += 1) {
      samples[frame * channels + channel] = value;
    }
  }
  return samples;
}

function createDiscardOutput(): DiscardOutput {
  let transferredBytes = 0;
  return {
    getBytesReceived: () => transferredBytes,
    stream: new WritableStream({
      write(chunk): void {
        transferredBytes += chunk.data.byteLength;
        const end = chunk.position + chunk.data.byteLength;
        if (
          end > PROBE_OUTPUT_LIMIT_BYTES ||
          transferredBytes > PROBE_OUTPUT_LIMIT_BYTES
        ) {
          throw new AudioTranscoderError(
            'RESOURCE_LIMIT_EXCEEDED',
            'The output encoder exceeded the runtime probe byte limit.',
          );
        }
      },
    }),
  };
}

async function abortDiscardOutput(
  output: WritableStream,
  reason: unknown,
): Promise<void> {
  await output.abort(reason).catch(() => undefined);
}

const REJECTED_CONTROL_FLOW_CODES = new Set([
  'INVALID_CONFIGURATION',
  'OPERATION_ABORTED',
  'QUEUE_CAPACITY_EXCEEDED',
  'RESOURCE_LIMIT_EXCEEDED',
  'WORKER_TERMINATED',
]);

function isRejectedControlFlow(error: unknown): boolean {
  return (
    error instanceof AudioTranscoderError &&
    REJECTED_CONTROL_FLOW_CODES.has(error.code)
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createOperationAbortedError(signal);
  }
}

function probeCacheKey(target: AudioStreamOutputProbeTarget): string {
  return `${target.presetId}\u0000${target.channels}\u0000${target.sampleRate}`;
}

function rememberSupported(
  cache: Map<string, AudioStreamSupportedOutputResult>,
  key: string,
  result: AudioStreamSupportedOutputResult,
): void {
  cache.delete(key);
  cache.set(key, result);
  if (cache.size > AUDIO_STREAM_OUTPUT_PROBE_MAX_CACHED_SUPPORTED) {
    cache.delete(cache.keys().next().value!);
  }
}

function subscribeToProbe(
  entry: CoordinatedProbe,
  signal: AbortSignal | undefined,
  onEmpty: (reason: unknown) => void,
): Promise<AudioStreamOutputSupportResult> {
  entry.subscribers += 1;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      settle: (value: AudioStreamOutputSupportResult) => void,
      value: AudioStreamOutputSupportResult,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', abort);
      entry.subscribers -= 1;
      settle(value);
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', abort);
      entry.subscribers -= 1;
      reject(error);
    };
    const abort = (): void => {
      fail(createOperationAbortedError(signal!));
      if (!entry.settled && entry.subscribers === 0) {
        onEmpty(signal?.reason);
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    entry.promise.then(
      (result) => finish(resolve, result),
      (error: unknown) => fail(error),
    );
  });
}
