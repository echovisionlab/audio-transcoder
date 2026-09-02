import { AudioTranscoderError } from '../errors.js';
import type { PcmAudio } from '../engine/contracts.js';
import { readInt24BE, readInt24LE } from './binary.js';

interface PcmReadOptions {
  readonly float: boolean;
  readonly littleEndian: boolean;
  readonly signed: boolean;
}

export interface ValidatedPcmAudio {
  readonly channels: number;
  readonly frames: number;
  readonly sampleRate: number;
}

export function validatePcmAudio(audio: PcmAudio): ValidatedPcmAudio {
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'PCM sample rate must be a positive finite number.',
    );
  }

  const firstChannel = audio.channelData[0];
  if (firstChannel === undefined || firstChannel.length === 0) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'PCM audio must contain at least one non-empty channel.',
    );
  }

  if (audio.channelData.some((channel) => channel.length !== firstChannel.length)) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'Every PCM channel must contain the same number of frames.',
    );
  }

  return Object.freeze({
    channels: audio.channelData.length,
    frames: firstChannel.length,
    sampleRate: audio.sampleRate,
  });
}

export function readPcmSample(
  view: DataView,
  offset: number,
  bitDepth: number,
  options: PcmReadOptions,
): number {
  if (options.float) {
    if (bitDepth === 32) {
      return view.getFloat32(offset, options.littleEndian);
    }
    if (bitDepth === 64) {
      return view.getFloat64(offset, options.littleEndian);
    }
    throw unsupportedBitDepth(bitDepth, 'floating-point');
  }

  if (bitDepth === 8) {
    const value = options.signed
      ? view.getInt8(offset)
      : view.getUint8(offset) - 128;
    return value / 128;
  }
  if (!options.signed) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_INPUT',
      `Unsupported unsigned ${bitDepth}-bit integer PCM audio.`,
    );
  }
  if (bitDepth === 16) {
    return view.getInt16(offset, options.littleEndian) / 32_768;
  }
  if (bitDepth === 24) {
    const value = options.littleEndian
      ? readInt24LE(view, offset)
      : readInt24BE(view, offset);
    return value / 8_388_608;
  }
  if (bitDepth === 32) {
    return view.getInt32(offset, options.littleEndian) / 2_147_483_648;
  }

  throw unsupportedBitDepth(bitDepth, 'integer');
}

export function sampleToInteger(sample: number, bitDepth: number): number {
  const clipped = Math.min(1, Math.max(-1, sample));
  const maximum = 2 ** (bitDepth - 1) - 1;
  const minimum = -(2 ** (bitDepth - 1));
  return Math.max(
    minimum,
    Math.min(
      maximum,
      Math.round(clipped < 0 ? clipped * -minimum : clipped * maximum),
    ),
  );
}

function unsupportedBitDepth(
  bitDepth: number,
  sampleFormat: string,
): AudioTranscoderError {
  return new AudioTranscoderError(
    'UNSUPPORTED_INPUT',
    `Unsupported ${bitDepth}-bit ${sampleFormat} PCM audio.`,
  );
}
