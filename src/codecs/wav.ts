import { AudioTranscoderError } from '../errors.js';
import type {
  AudioInput,
  AudioInspection,
  AudioOutputPreset,
  AudioSourceEncoding,
  DecodedAudio,
  EncodedAudio,
  PcmAudio,
} from '../engine/contracts.js';
import { readAscii, writeAscii, writeInt24LE } from './binary.js';
import type {
  AudioCodecOperationContext,
  AudioDecodeEstimate,
  AudioDecoderAdapter,
  AudioEncoderAdapter,
  AudioInspectorAdapter,
} from './contracts.js';
import {
  readPcmSample,
  sampleToInteger,
  validatePcmAudio,
} from './pcm.js';
import { processFrameBatches } from './frame-batches.js';
import {
  WAV_OUTPUT_PRESET_DESCRIPTORS,
  WAV_OUTPUT_PRESETS,
} from './wav-presets.js';

export { WAV_OUTPUT_PRESETS } from './wav-presets.js';

interface WavFormat {
  readonly bitDepth: number;
  readonly blockAlign: number;
  readonly byteRate: number;
  readonly channels: number;
  readonly formatTag: number;
  readonly sampleRate: number;
}

interface WavData {
  readonly offset: number;
  readonly size: number;
}

interface ParsedWav {
  readonly data: WavData | null;
  readonly format: WavFormat | null;
}

interface PreparedWavDecode {
  readonly bytesPerSample: number;
  readonly data: WavData;
  readonly format: WavFormat;
  readonly frames: number;
  readonly view: DataView;
}

export const wavInspector: AudioInspectorAdapter = Object.freeze({
  formats: Object.freeze(['wav']),
  id: 'builtin.wav.inspector',
  inspect(input: AudioInput): AudioInspection | null {
    const view = new DataView(input.data);
    if (!isWav(view)) {
      return null;
    }

    const parsed = parseWav(view);
    const format = parsed.format;
    const builtIn =
      format !== null &&
      hasValidWavPcmFormat(format) &&
      isSupportedWavSampleRepresentation(format);
    const codec =
      format?.formatTag === 1
        ? 'PCM integer'
        : format?.formatTag === 3
          ? 'PCM float'
          : format === null
            ? 'Unknown'
            : `WAVE format ${format.formatTag}`;

    return {
      bitDepth: format?.bitDepth ?? null,
      channels: format?.channels ?? null,
      codec,
      container: 'WAV',
      decodeSupport: builtIn ? 'built-in' : 'browser-dependent',
      durationSeconds: calculateDuration(parsed, input),
      notes: format === null ? ['WAV fmt chunk was not found.'] : [],
      sampleRate: format?.sampleRate ?? null,
      sourceEncoding: getWavSourceEncoding(format),
    };
  },
});

export const wavDecoder: AudioDecoderAdapter = Object.freeze({
  formats: Object.freeze(['wav']),
  id: 'builtin.wav.decoder',
  estimateDecodedPcm(input: AudioInput): AudioDecodeEstimate | null {
    const prepared = prepareWavDecode(input);
    return prepared === null
      ? null
      : { channels: prepared.format.channels, frames: prepared.frames };
  },
  async decode(
    input: AudioInput,
    context?: AudioCodecOperationContext,
  ): Promise<DecodedAudio | null> {
    const prepared = prepareWavDecode(input);
    if (prepared === null) {
      return null;
    }

    const { bytesPerSample, data, format, frames, view } = prepared;

    const channelData = Array.from(
      { length: format.channels },
      () => new Float32Array(frames),
    );

    await processFrameBatches(frames, context, (startFrame, endFrame) => {
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        const frameOffset = data.offset + frame * format.blockAlign;
        for (let channel = 0; channel < format.channels; channel += 1) {
          const target = channelData[channel]!;
          target[frame] = readPcmSample(
            view,
            frameOffset + channel * bytesPerSample,
            format.bitDepth,
            {
              float: format.formatTag === 3,
              littleEndian: true,
              signed: format.bitDepth !== 8,
            },
          );
        }
      }
    });

    return {
      channelData,
      durationSeconds: frames / format.sampleRate,
      sampleRate: format.sampleRate,
      source: 'WAV PCM decoder',
    };
  },
});

export const wavEncoder: AudioEncoderAdapter = Object.freeze({
  id: 'builtin.wav.encoder',
  presets: WAV_OUTPUT_PRESETS,
  async encode(
    audio: PcmAudio,
    preset: AudioOutputPreset,
    context?: AudioCodecOperationContext,
  ): Promise<EncodedAudio> {
    const encoding = WAV_OUTPUT_PRESET_DESCRIPTORS.find(
      ({ preset: candidate }) => candidate.id === preset.id,
    );
    if (encoding === undefined) {
      throw new AudioTranscoderError(
        'UNSUPPORTED_OUTPUT',
        `WAV encoder does not support preset "${preset.id}".`,
      );
    }

    const { channels, frames, sampleRate } = validatePcmAudio(audio);
    const bytesPerSample = encoding.bitDepth / 8;
    const dataBytes = frames * channels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);

    const float = !encoding.integer;
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, float ? 3 : 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * bytesPerSample, true);
    view.setUint16(32, channels * bytesPerSample, true);
    view.setUint16(34, encoding.bitDepth, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataBytes, true);

    await processFrameBatches(frames, context, (startFrame, endFrame) => {
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        for (let channel = 0; channel < channels; channel += 1) {
          const sample = audio.channelData[channel]![frame]!;
          const offset =
            44 + (frame * channels + channel) * bytesPerSample;
          if (float) {
            view.setFloat32(offset, Math.min(1, Math.max(-1, sample)), true);
          } else if (encoding.bitDepth === 16) {
            view.setInt16(offset, sampleToInteger(sample, 16), true);
          } else if (encoding.bitDepth === 24) {
            writeInt24LE(view, offset, sampleToInteger(sample, 24));
          } else {
            view.setInt32(offset, sampleToInteger(sample, 32), true);
          }
        }
      }
    });

    return Object.freeze({ data: buffer, preset });
  },
});

function isWav(view: DataView): boolean {
  return readAscii(view, 0, 4) === 'RIFF' && readAscii(view, 8, 4) === 'WAVE';
}

function getWavSourceEncoding(format: WavFormat | null): AudioSourceEncoding {
  if (format === null || (format.formatTag !== 1 && format.formatTag !== 3)) {
    return Object.freeze({ kind: 'unknown' });
  }
  const float = format.formatTag === 3;
  return Object.freeze({
    bitDepth: format.bitDepth > 0 ? format.bitDepth : null,
    endianness: format.bitDepth <= 8 ? 'not-applicable' : 'little',
    kind: 'pcm',
    sampleFormat: float ? 'float' : 'integer',
    signedness:
      float ? 'not-applicable' : format.bitDepth === 8 ? 'unsigned' : 'signed',
  });
}

function parseWav(view: DataView): ParsedWav {
  let offset = 12;
  let format: WavFormat | null = null;
  let data: WavData | null = null;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;

    if (chunkId === 'fmt ' && chunkSize >= 16 && dataOffset + 16 <= view.byteLength) {
      const bitDepth = view.getUint16(dataOffset + 14, true);
      let formatTag = view.getUint16(dataOffset, true);
      if (
        formatTag === 0xfffe &&
        chunkSize >= 40 &&
        dataOffset + 40 <= view.byteLength &&
        view.getUint16(dataOffset + 16, true) >= 22 &&
        view.getUint16(dataOffset + 18, true) === bitDepth
      ) {
        formatTag =
          readWaveExtensibleFormatTag(view, dataOffset + 24) ?? formatTag;
      }
      format = {
        bitDepth,
        blockAlign: view.getUint16(dataOffset + 12, true),
        byteRate: view.getUint32(dataOffset + 8, true),
        channels: view.getUint16(dataOffset + 2, true),
        formatTag,
        sampleRate: view.getUint32(dataOffset + 4, true),
      };
    }

    if (chunkId === 'data') {
      data = { offset: dataOffset, size: chunkSize };
      break;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  return { data, format };
}

function prepareWavDecode(input: AudioInput): PreparedWavDecode | null {
  const view = new DataView(input.data);
  if (!isWav(view)) {
    return null;
  }

  const { data, format } = parseWav(view);
  if (format === null || data === null) {
    throw invalidWav('WAV requires both fmt and data chunks.');
  }
  if (format.formatTag !== 1 && format.formatTag !== 3) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_INPUT',
      `WAVE format ${format.formatTag} is not built-in PCM.`,
    );
  }
  if (!hasValidWavPcmFields(format)) {
    throw invalidWav('WAV PCM format fields are invalid.');
  }
  if (!isSupportedWavSampleRepresentation(format)) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_INPUT',
      `Unsupported ${format.bitDepth}-bit WAVE PCM representation.`,
    );
  }

  const bytesPerSample = format.bitDepth / 8;
  if (bytesPerSample * format.channels > format.blockAlign) {
    throw invalidWav('WAV block alignment is smaller than one PCM frame.');
  }

  const availableBytes = Math.min(
    data.size,
    Math.max(0, view.byteLength - data.offset),
  );
  const frames = Math.floor(availableBytes / format.blockAlign);
  if (frames === 0) {
    throw invalidWav('WAV data chunk does not contain a complete frame.');
  }

  return { bytesPerSample, data, format, frames, view };
}

function isSupportedWavSampleRepresentation(format: WavFormat): boolean {
  return format.formatTag === 1
    ? [8, 16, 24, 32].includes(format.bitDepth)
    : format.formatTag === 3 &&
        (format.bitDepth === 32 || format.bitDepth === 64);
}

function hasValidWavPcmFields(format: WavFormat): boolean {
  return (
    format.channels > 0 &&
    format.sampleRate > 0 &&
    format.blockAlign > 0 &&
    format.bitDepth > 0 &&
    format.bitDepth % 8 === 0
  );
}

function hasValidWavPcmFormat(format: WavFormat): boolean {
  return (
    hasValidWavPcmFields(format) &&
    (format.bitDepth / 8) * format.channels <= format.blockAlign
  );
}

function readWaveExtensibleFormatTag(
  view: DataView,
  offset: number,
): number | null {
  if (
    view.getUint16(offset + 4, true) !== 0 ||
    view.getUint16(offset + 6, true) !== 0x10 ||
    view.getUint32(offset + 8, false) !== 0x800000aa ||
    view.getUint32(offset + 12, false) !== 0x00389b71
  ) {
    return null;
  }

  const formatTag = view.getUint32(offset, true);
  return formatTag === 1 || formatTag === 3 ? formatTag : null;
}

function calculateDuration(parsed: ParsedWav, input: AudioInput): number | null {
  const format = parsed.format;
  if (
    format !== null &&
    parsed.data !== null &&
    format.sampleRate > 0 &&
    format.blockAlign > 0
  ) {
    return parsed.data.size / format.blockAlign / format.sampleRate;
  }
  if (format !== null && format.byteRate > 0) {
    return (input.size ?? input.data.byteLength) / format.byteRate;
  }
  return null;
}

function invalidWav(message: string): AudioTranscoderError {
  return new AudioTranscoderError('INVALID_AUDIO_DATA', message);
}
