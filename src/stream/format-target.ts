import type { AudioInspection } from '../engine/contracts.js';
import type {
  AudioStreamOutputProbeTarget,
  AudioStreamTarget,
} from './contracts.js';
import {
  AUDIO_TRANSCODER_STREAM_CAPABILITIES,
  type AudioStreamOutputFormatDescriptor,
  type AudioStreamOutputPresetDescriptor,
  type AudioStreamOutputSampleRateConstraints,
  type AudioTranscoderStreamCapabilities,
} from './capabilities.js';

export const AUDIO_STREAM_SOURCE_SAMPLE_RATE = 'source' as const;
export const AUDIO_STREAM_AUTOMATIC_SAMPLE_RATE = 'automatic' as const;

export type AudioStreamSampleRateSelection =
  | typeof AUDIO_STREAM_SOURCE_SAMPLE_RATE
  | number;

export type AudioStreamSourceAwareSampleRateSelection =
  | AudioStreamSampleRateSelection
  | typeof AUDIO_STREAM_AUTOMATIC_SAMPLE_RATE;

export type AudioStreamOutputParameterId =
  | 'bit-depth'
  | 'bitrate-bps'
  | 'codec'
  | 'sample-format';

export type AudioStreamOutputParameterValue = number | string;

export interface AudioStreamOutputParameterSelection {
  readonly bitDepth?: number;
  readonly bitrateBps?: number;
  readonly codec?: string;
  readonly sampleFormat?: 'float' | 'integer' | 'lossy';
}

export interface AudioStreamOutputEncodingOption {
  readonly bitDepth: number | null;
  readonly bitrateBps: number | null;
  readonly codec: string;
  readonly kind: 'lossless' | 'lossy';
  readonly presetId: string;
  readonly sampleFormat: 'float' | 'integer' | 'lossy';
}

export interface AudioStreamOutputParameterOption {
  readonly presetIds: readonly string[];
  readonly value: AudioStreamOutputParameterValue;
}

export interface AudioStreamOutputParameterDescriptor {
  readonly id: AudioStreamOutputParameterId;
  readonly options: readonly AudioStreamOutputParameterOption[];
}

export interface AudioStreamFormatTargetSelection {
  readonly formatId: string;
  readonly parameters?: AudioStreamOutputParameterSelection;
  readonly presetId?: string;
  readonly sampleRate?: AudioStreamSampleRateSelection;
}

export type AudioStreamSourceAwareFormatTargetSelection = Omit<
  AudioStreamFormatTargetSelection,
  'sampleRate'
> & {
  readonly sampleRate?: AudioStreamSourceAwareSampleRateSelection;
};

export interface AudioStreamOutputSampleRateOptionsSelection {
  /** Additional exact rates to evaluate for range-constrained presets. */
  readonly candidateSampleRates?: readonly number[];
  readonly formatId: string;
  readonly presetId: string;
}

export type AudioStreamOutputSampleRatePath = 'pass-through' | 'resampling';

export type AudioStreamOutputSampleRateUnsupportedReason =
  | 'invalid-sample-rate'
  | 'pass-through-sample-rate'
  | 'preset-sample-rate'
  | 'resampling-source-sample-rate'
  | 'resampling-target-sample-rate';

interface AudioStreamOutputSampleRateOptionBase {
  readonly path: AudioStreamOutputSampleRatePath;
  readonly sampleRate: number;
}

export interface AudioStreamSupportedOutputSampleRateOption
  extends AudioStreamOutputSampleRateOptionBase {
  readonly status: 'supported';
}

export interface AudioStreamUnsupportedOutputSampleRateOption
  extends AudioStreamOutputSampleRateOptionBase {
  readonly reason: AudioStreamOutputSampleRateUnsupportedReason;
  readonly status: 'unsupported';
}

export type AudioStreamOutputSampleRateOption =
  | AudioStreamSupportedOutputSampleRateOption
  | AudioStreamUnsupportedOutputSampleRateOption;

export type AudioStreamOutputSampleRateOptionsErrorReason =
  | 'channels'
  | 'format'
  | 'preset'
  | 'source-inspection';

export interface AudioStreamOutputSampleRateOptionsError {
  readonly message: string;
  readonly reason: AudioStreamOutputSampleRateOptionsErrorReason;
  readonly status: 'unsupported';
}

export interface AudioStreamResolvedOutputSampleRateOptions {
  readonly options: readonly AudioStreamOutputSampleRateOption[];
  readonly status: 'resolved';
}

export type AudioStreamOutputSampleRateOptionsResult =
  | AudioStreamOutputSampleRateOptionsError
  | AudioStreamResolvedOutputSampleRateOptions;

export type AudioStreamFormatTargetResolutionErrorReason =
  | 'channels'
  | 'format'
  | 'parameters'
  | 'preset'
  | 'sample-rate'
  | 'source-inspection';

export interface AudioStreamFormatTargetResolutionError {
  readonly message: string;
  readonly reason: AudioStreamFormatTargetResolutionErrorReason;
  readonly status: 'unsupported';
}

export interface AudioStreamResolvedFormatTarget {
  readonly format: AudioStreamOutputFormatDescriptor;
  readonly preset: AudioStreamOutputPresetDescriptor;
  readonly probeTarget: AudioStreamOutputProbeTarget;
  readonly status: 'resolved';
  readonly target: AudioStreamTarget;
}

export type AudioStreamFormatTargetResolution =
  | AudioStreamFormatTargetResolutionError
  | AudioStreamResolvedFormatTarget;

const PARAMETER_ORDER = Object.freeze([
  'codec',
  'sample-format',
  'bit-depth',
  'bitrate-bps',
] as const satisfies readonly AudioStreamOutputParameterId[]);

/** Returns stable semantic encoding values for every installed preset. */
export function getAudioStreamOutputEncodingOptions(
  formatId: string,
  capabilities: AudioTranscoderStreamCapabilities =
    AUDIO_TRANSCODER_STREAM_CAPABILITIES,
): readonly AudioStreamOutputEncodingOption[] {
  const format = findFormat(formatId, capabilities);
  if (format === undefined) {
    return Object.freeze([]);
  }
  return Object.freeze(format.presets.map(toEncodingOption));
}

/**
 * Describes only parameters that vary within a format. Options are filtered by
 * the other partial selections, so invalid combinations never need to be
 * duplicated in a consumer.
 */
export function getAudioStreamOutputParameters(
  formatId: string,
  selection: AudioStreamOutputParameterSelection = {},
  capabilities: AudioTranscoderStreamCapabilities =
    AUDIO_TRANSCODER_STREAM_CAPABILITIES,
): readonly AudioStreamOutputParameterDescriptor[] {
  const allOptions = getAudioStreamOutputEncodingOptions(formatId, capabilities);
  return Object.freeze(
    PARAMETER_ORDER.flatMap((id) => {
      const allValues = uniqueParameterValues(allOptions, id);
      if (allValues.length <= 1) {
        return [];
      }
      const candidates = allOptions.filter((option) =>
        matchesSelection(option, selection, id),
      );
      const options = uniqueParameterValues(candidates, id).map((value) =>
        Object.freeze({
          presetIds: Object.freeze(
            candidates
              .filter((candidate) => parameterValue(candidate, id) === value)
              .map(({ presetId }) => presetId),
          ),
          value,
        }),
      );
      return [Object.freeze({ id, options: Object.freeze(options) })];
    }),
  );
}

/**
 * Resolves a semantic format selection against one inspected source. Source
 * channel layout and sample rate are preserved unless an explicit rate is
 * selected. The exact target still requires a runtime output probe.
 */
export function resolveAudioStreamFormatTarget(
  selection: AudioStreamFormatTargetSelection,
  inspection: AudioInspection,
  capabilities: AudioTranscoderStreamCapabilities =
    AUDIO_TRANSCODER_STREAM_CAPABILITIES,
): AudioStreamFormatTargetResolution {
  return resolveFormatTarget(selection, inspection, capabilities, false);
}

/**
 * Resolves a source-owned channel layout and a source-aware sample-rate
 * selection. Automatic selection preserves a valid source rate first, then
 * considers only exact discrete preset rates supported by the resampling path.
 */
export function resolveAudioStreamSourceAwareFormatTarget(
  selection: AudioStreamSourceAwareFormatTargetSelection,
  inspection: AudioInspection,
  capabilities: AudioTranscoderStreamCapabilities =
    AUDIO_TRANSCODER_STREAM_CAPABILITIES,
): AudioStreamFormatTargetResolution {
  return resolveFormatTarget(selection, inspection, capabilities, true);
}

/**
 * Validates an exact format, preset, and source before enumerating sample-rate
 * decisions without probing a codec runtime. Discrete presets contribute their
 * declared values; range presets contribute only the source rate and
 * caller-supplied candidates.
 */
export function getAudioStreamOutputSampleRateOptions(
  selection: AudioStreamOutputSampleRateOptionsSelection,
  inspection: AudioInspection,
  capabilities: AudioTranscoderStreamCapabilities =
    AUDIO_TRANSCODER_STREAM_CAPABILITIES,
): AudioStreamOutputSampleRateOptionsResult {
  const format = findFormat(selection.formatId, capabilities);
  if (format === undefined) {
    return unsupportedSampleRateOptions(
      'format',
      `Output format "${selection.formatId}" is not installed.`,
    );
  }

  const preset = format.presets.find(
    ({ preset: candidate }) => candidate.id === selection.presetId,
  );
  if (preset === undefined) {
    return unsupportedSampleRateOptions(
      'preset',
      `Preset "${selection.presetId}" is not installed for format "${format.id}".`,
    );
  }
  if (inspection.channels === null || inspection.sampleRate === null) {
    return unsupportedSampleRateOptions(
      'source-inspection',
      'The source channel count and sample rate must be known.',
    );
  }
  if (
    !Number.isSafeInteger(inspection.sampleRate) ||
    inspection.sampleRate <= 0
  ) {
    return unsupportedSampleRateOptions(
      'source-inspection',
      'The source sample rate must be a positive integer.',
    );
  }

  const channels = inspection.channels;
  if (
    !Number.isSafeInteger(channels) ||
    channels < capabilities.limits.channels.minimum ||
    channels > capabilities.limits.channels.maximum ||
    channels < preset.target.channels.minimum ||
    channels > preset.target.channels.maximum
  ) {
    return unsupportedSampleRateOptions(
      'channels',
      `Preset "${preset.preset.id}" does not support ${channels} source channels.`,
    );
  }

  const sourceSampleRate = inspection.sampleRate;
  const candidates =
    preset.target.sampleRate.kind === 'discrete'
      ? [sourceSampleRate, ...preset.target.sampleRate.values]
      : [sourceSampleRate, ...(selection.candidateSampleRates ?? [])];
  const options = Object.freeze(
    [...new Set(candidates)].map((sampleRate) =>
      sampleRateOption(
        preset.target.sampleRate,
        sourceSampleRate,
        sampleRate,
        capabilities,
      ),
    ),
  );
  return Object.freeze({ options, status: 'resolved' as const });
}

function resolveFormatTarget(
  selection: AudioStreamSourceAwareFormatTargetSelection,
  inspection: AudioInspection,
  capabilities: AudioTranscoderStreamCapabilities,
  sourceAware: boolean,
): AudioStreamFormatTargetResolution {
  const format = findFormat(selection.formatId, capabilities);
  if (format === undefined) {
    return unsupported('format', `Output format "${selection.formatId}" is not installed.`);
  }

  const preset = resolvePreset(format, selection);
  if ('reason' in preset) {
    return preset;
  }

  if (inspection.channels === null || inspection.sampleRate === null) {
    return unsupported(
      'source-inspection',
      'The source channel count and sample rate must be known.',
    );
  }
  if (
    !Number.isSafeInteger(inspection.sampleRate) ||
    inspection.sampleRate <= 0
  ) {
    return unsupported(
      'source-inspection',
      'The source sample rate must be a positive integer.',
    );
  }

  const channels = inspection.channels;
  if (
    !Number.isSafeInteger(channels) ||
    channels < capabilities.limits.channels.minimum ||
    channels > capabilities.limits.channels.maximum ||
    channels < preset.target.channels.minimum ||
    channels > preset.target.channels.maximum
  ) {
    return unsupported(
      'channels',
      `Preset "${preset.preset.id}" does not support ${channels} source channels.`,
    );
  }

  const sampleRateSelection =
    selection.sampleRate ?? AUDIO_STREAM_SOURCE_SAMPLE_RATE;
  if (
    sampleRateSelection === AUDIO_STREAM_AUTOMATIC_SAMPLE_RATE &&
    !sourceAware
  ) {
    return unsupported(
      'sample-rate',
      `Preset "${preset.preset.id}" does not support automatic Hz for this source.`,
    );
  }
  const sampleRate =
    sampleRateSelection === AUDIO_STREAM_AUTOMATIC_SAMPLE_RATE
      ? resolveAutomaticSampleRate(
          preset.target.sampleRate,
          inspection.sampleRate,
          capabilities,
        )
      : sampleRateSelection === AUDIO_STREAM_SOURCE_SAMPLE_RATE
        ? inspection.sampleRate
        : sampleRateSelection;
  if (
    sampleRate === null ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    !supportsSampleRate(preset.target.sampleRate, sampleRate) ||
    !supportsSampleRatePath(
      capabilities,
      inspection.sampleRate,
      sampleRate,
    )
  ) {
    return unsupported(
      'sample-rate',
      sampleRate === null
        ? `Preset "${preset.preset.id}" has no automatic sample rate for this source.`
        : `Preset "${preset.preset.id}" does not support ${sampleRate} Hz for this source.`,
    );
  }

  const probeTarget = Object.freeze({
    channels,
    presetId: preset.preset.id,
    sampleRate,
  }) as AudioStreamOutputProbeTarget;
  const preservesSourceSampleRate =
    sampleRateSelection === AUDIO_STREAM_SOURCE_SAMPLE_RATE ||
    (sampleRateSelection === AUDIO_STREAM_AUTOMATIC_SAMPLE_RATE &&
      sampleRate === inspection.sampleRate);
  const target = Object.freeze({
    presetId: preset.preset.id,
    ...(preservesSourceSampleRate ? {} : { sampleRate }),
  }) as AudioStreamTarget;

  return Object.freeze({
    format,
    preset,
    probeTarget,
    status: 'resolved' as const,
    target,
  });
}

function resolveAutomaticSampleRate(
  constraint: AudioStreamOutputSampleRateConstraints,
  sourceSampleRate: number,
  capabilities: AudioTranscoderStreamCapabilities,
): number | null {
  if (
    supportsSampleRate(constraint, sourceSampleRate) &&
    supportsSampleRatePath(capabilities, sourceSampleRate, sourceSampleRate)
  ) {
    return sourceSampleRate;
  }
  if (constraint.kind !== 'discrete') {
    return null;
  }

  const candidates = constraint.values.filter((sampleRate) =>
    supportsSampleRatePath(capabilities, sourceSampleRate, sampleRate),
  );
  candidates.sort((left, right) => {
    const distance =
      Math.abs(left - sourceSampleRate) - Math.abs(right - sourceSampleRate);
    return distance === 0 ? right - left : distance;
  });
  return candidates[0] ?? null;
}

function findFormat(
  formatId: string,
  capabilities: AudioTranscoderStreamCapabilities,
): AudioStreamOutputFormatDescriptor | undefined {
  return capabilities.outputFormats.find(({ id }) => id === formatId);
}

function resolvePreset(
  format: AudioStreamOutputFormatDescriptor,
  selection: AudioStreamSourceAwareFormatTargetSelection,
): AudioStreamOutputPresetDescriptor | AudioStreamFormatTargetResolutionError {
  if (selection.presetId !== undefined) {
    const preset = format.presets.find(
      ({ preset: candidate }) => candidate.id === selection.presetId,
    );
    if (preset === undefined) {
      return unsupported(
        'preset',
        `Preset "${selection.presetId}" is not installed for format "${format.id}".`,
      );
    }
    if (!matchesSelection(toEncodingOption(preset), selection.parameters ?? {})) {
      return unsupported(
        'parameters',
        `Preset "${selection.presetId}" does not match the selected encoding parameters.`,
      );
    }
    return preset;
  }

  const candidates = format.presets.filter((candidate) =>
    matchesSelection(toEncodingOption(candidate), selection.parameters ?? {}),
  );
  if (candidates.length !== 1) {
    return unsupported(
      'parameters',
      candidates.length === 0
        ? `No preset for format "${format.id}" matches the selected encoding parameters.`
        : `The encoding parameters for format "${format.id}" do not select one exact preset.`,
    );
  }
  return candidates[0]!;
}

function toEncodingOption(
  descriptor: AudioStreamOutputPresetDescriptor,
): Readonly<AudioStreamOutputEncodingOption> {
  return Object.freeze({
    bitDepth: descriptor.kind === 'lossless' ? descriptor.bitDepth : null,
    bitrateBps: descriptor.kind === 'lossy' ? descriptor.bitrate : null,
    codec: descriptor.codec.startsWith('pcm-') ? 'pcm' : descriptor.codec,
    kind: descriptor.kind,
    presetId: descriptor.preset.id,
    sampleFormat: descriptor.preset.sampleFormat,
  });
}

function matchesSelection(
  option: AudioStreamOutputEncodingOption,
  selection: AudioStreamOutputParameterSelection,
  ignored?: AudioStreamOutputParameterId,
): boolean {
  return (
    (ignored === 'bit-depth' ||
      selection.bitDepth === undefined ||
      option.bitDepth === selection.bitDepth) &&
    (ignored === 'bitrate-bps' ||
      selection.bitrateBps === undefined ||
      option.bitrateBps === selection.bitrateBps) &&
    (ignored === 'codec' ||
      selection.codec === undefined ||
      option.codec === selection.codec) &&
    (ignored === 'sample-format' ||
      selection.sampleFormat === undefined ||
      option.sampleFormat === selection.sampleFormat)
  );
}

function uniqueParameterValues(
  options: readonly AudioStreamOutputEncodingOption[],
  id: AudioStreamOutputParameterId,
): readonly AudioStreamOutputParameterValue[] {
  const values = new Set<AudioStreamOutputParameterValue>();
  for (const option of options) {
    const value = parameterValue(option, id);
    if (value !== null) {
      values.add(value);
    }
  }
  return Object.freeze([...values]);
}

function parameterValue(
  option: AudioStreamOutputEncodingOption,
  id: AudioStreamOutputParameterId,
): AudioStreamOutputParameterValue | null {
  switch (id) {
    case 'bit-depth':
      return option.bitDepth;
    case 'bitrate-bps':
      return option.bitrateBps;
    case 'codec':
      return option.codec;
    case 'sample-format':
      return option.sampleFormat;
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

function supportsSampleRatePath(
  capabilities: AudioTranscoderStreamCapabilities,
  sourceSampleRate: number,
  targetSampleRate: number,
): boolean {
  const constraint =
    sourceSampleRate === targetSampleRate
      ? capabilities.limits.sampleRate.passThrough
      : capabilities.limits.sampleRate.resampling;
  return (
    sourceSampleRate >= constraint.minimum &&
    sourceSampleRate <= constraint.maximum &&
    targetSampleRate >= constraint.minimum &&
    targetSampleRate <= constraint.maximum
  );
}

function sampleRateOption(
  presetConstraint: AudioStreamOutputSampleRateConstraints,
  sourceSampleRate: number,
  sampleRate: number,
  capabilities: AudioTranscoderStreamCapabilities,
): Readonly<AudioStreamOutputSampleRateOption> {
  const path = sourceSampleRate === sampleRate
    ? 'pass-through' as const
    : 'resampling' as const;
  const reason = sampleRateUnsupportedReason(
    presetConstraint,
    sourceSampleRate,
    sampleRate,
    capabilities,
  );
  return reason === null
    ? Object.freeze({ path, sampleRate, status: 'supported' as const })
    : Object.freeze({
        path,
        reason,
        sampleRate,
        status: 'unsupported' as const,
      });
}

function sampleRateUnsupportedReason(
  presetConstraint: AudioStreamOutputSampleRateConstraints,
  sourceSampleRate: number,
  sampleRate: number,
  capabilities: AudioTranscoderStreamCapabilities,
): AudioStreamOutputSampleRateUnsupportedReason | null {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    return 'invalid-sample-rate';
  }
  if (!supportsSampleRate(presetConstraint, sampleRate)) {
    return 'preset-sample-rate';
  }
  if (sourceSampleRate === sampleRate) {
    return isWithinSampleRateRange(
      sampleRate,
      capabilities.limits.sampleRate.passThrough,
    )
      ? null
      : 'pass-through-sample-rate';
  }
  if (
    !isWithinSampleRateRange(
      sourceSampleRate,
      capabilities.limits.sampleRate.resampling,
    )
  ) {
    return 'resampling-source-sample-rate';
  }
  return isWithinSampleRateRange(
    sampleRate,
    capabilities.limits.sampleRate.resampling,
  )
    ? null
    : 'resampling-target-sample-rate';
}

function isWithinSampleRateRange(
  sampleRate: number,
  range: { readonly maximum: number; readonly minimum: number },
): boolean {
  return sampleRate >= range.minimum && sampleRate <= range.maximum;
}

function unsupportedSampleRateOptions(
  reason: AudioStreamOutputSampleRateOptionsErrorReason,
  message: string,
): Readonly<AudioStreamOutputSampleRateOptionsError> {
  return Object.freeze({ message, reason, status: 'unsupported' as const });
}

function unsupported(
  reason: AudioStreamFormatTargetResolutionErrorReason,
  message: string,
): Readonly<AudioStreamFormatTargetResolutionError> {
  return Object.freeze({ message, reason, status: 'unsupported' as const });
}
