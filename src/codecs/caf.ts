import { AudioTranscoderError } from '../errors.js';
import type {
  AudioInput,
  AudioInspection,
  AudioSourceEncoding,
  DecodedAudio,
} from '../engine/contracts.js';
import { readAscii, readInt64BE } from './binary.js';
import type {
  AudioCodecOperationContext,
  AudioDecodeEstimate,
  AudioDecoderAdapter,
  AudioInspectorAdapter,
} from './contracts.js';
import { readPcmSample } from './pcm.js';
import { processFrameBatches } from './frame-batches.js';

interface CafDescription {
  readonly bitDepth: number;
  readonly bytesPerPacket: number;
  readonly channels: number;
  readonly flags: number;
  readonly formatId: string;
  readonly framesPerPacket: number;
  readonly sampleRate: number;
}

interface CafData {
  readonly offset: number;
  readonly size: number;
}

interface CafFlags {
  readonly bigEndian: boolean;
  readonly float: boolean;
  readonly label: string;
  readonly signed: boolean;
}

interface ParsedCaf {
  readonly data: CafData | null;
  readonly description: CafDescription | null;
}

interface PreparedCafDecode {
  readonly bytesPerFrame: number;
  readonly bytesPerSample: number;
  readonly data: CafData;
  readonly description: CafDescription;
  readonly flags: CafFlags;
  readonly frames: number;
  readonly view: DataView;
}

export const cafInspector: AudioInspectorAdapter = Object.freeze({
  formats: Object.freeze(['caf']),
  id: 'builtin.caf.inspector',
  inspect(input: AudioInput): AudioInspection | null {
    const view = new DataView(input.data);
    if (!isCaf(view)) {
      return null;
    }

    const parsed = parseCaf(view);
    const description = parsed.description;
    const bytesPerFrame =
      description === null ? null : getCafBytesPerFrame(description);
    const durationSeconds =
      description !== null &&
      parsed.data !== null &&
      bytesPerFrame !== null &&
      bytesPerFrame > 0 &&
      Number.isFinite(description.sampleRate) &&
      description.sampleRate > 0
        ? parsed.data.size / bytesPerFrame / description.sampleRate
        : null;
    const isLpcm = description !== null && description.formatId === 'lpcm';
    const validLpcm = isLpcm && isValidCafLpcmDescription(description);
    const builtIn =
      validLpcm &&
      !hasUnsupportedLpcmLayout(description, bytesPerFrame!) &&
      !hasUnsupportedLpcmSampleRepresentation(description);

    return {
      bitDepth:
        description !== null && description.bitDepth > 0
          ? description.bitDepth
          : null,
      channels: description?.channels ?? null,
      codec:
        description === null
          ? 'Unknown'
          : description.formatId === 'lpcm'
            ? `${description.formatId} ${decodeCafFlags(description.flags).label}`
            : normalizeCafCodec(description.formatId),
      container: 'CAF',
      decodeSupport: builtIn ? 'built-in' : 'browser-dependent',
      durationSeconds,
      notes:
        description === null
          ? ['CAF desc chunk was not found.']
          : builtIn
            ? []
            : isLpcm
              ? [getUnsupportedCafLpcmNote(description, bytesPerFrame)]
              : ['Compressed CAF requires a browser decoder or codec plugin.'],
      sampleRate: description?.sampleRate ?? null,
      sourceEncoding: getCafSourceEncoding(description),
    };
  },
});

export const cafDecoder: AudioDecoderAdapter = Object.freeze({
  formats: Object.freeze(['caf']),
  id: 'builtin.caf.decoder',
  estimateDecodedPcm(input: AudioInput): AudioDecodeEstimate | null {
    const prepared = prepareCafDecode(input);
    return prepared === null
      ? null
      : { channels: prepared.description.channels, frames: prepared.frames };
  },
  async decode(
    input: AudioInput,
    context?: AudioCodecOperationContext,
  ): Promise<DecodedAudio | null> {
    const prepared = prepareCafDecode(input);
    if (prepared === null) {
      return null;
    }

    const {
      bytesPerFrame,
      bytesPerSample,
      data,
      description,
      flags,
      frames,
      view,
    } = prepared;
    const channelData = Array.from(
      { length: description.channels },
      () => new Float32Array(frames),
    );

    await processFrameBatches(frames, context, (startFrame, endFrame) => {
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        const frameOffset = data.offset + frame * bytesPerFrame;
        for (let channel = 0; channel < description.channels; channel += 1) {
          const target = channelData[channel]!;
          target[frame] = readPcmSample(
            view,
            frameOffset + channel * bytesPerSample,
            description.bitDepth,
            {
              float: flags.float,
              littleEndian: !flags.bigEndian,
              signed: flags.signed,
            },
          );
        }
      }
    });

    return {
      channelData,
      durationSeconds: frames / description.sampleRate,
      sampleRate: description.sampleRate,
      source: 'CAF LPCM decoder',
    };
  },
});

function isCaf(view: DataView): boolean {
  return readAscii(view, 0, 4) === 'caff';
}

function parseCaf(view: DataView): ParsedCaf {
  let offset = 8;
  let description: CafDescription | null = null;
  let data: CafData | null = null;

  while (offset + 12 <= view.byteLength) {
    const chunkType = readAscii(view, offset, 4);
    const chunkSize = readInt64BE(view, offset + 4);
    const dataOffset = offset + 12;
    if (chunkSize < -1n) {
      break;
    }
    const logicalSize =
      chunkSize === -1n
        ? BigInt(Math.max(0, view.byteLength - dataOffset))
        : chunkSize;

    if (chunkType === 'desc' && logicalSize >= 32n && dataOffset + 32 <= view.byteLength) {
      description = {
        bitDepth: view.getUint32(dataOffset + 28, false),
        bytesPerPacket: view.getUint32(dataOffset + 16, false),
        channels: view.getUint32(dataOffset + 24, false),
        flags: view.getUint32(dataOffset + 12, false),
        formatId: readAscii(view, dataOffset + 8, 4),
        framesPerPacket: view.getUint32(dataOffset + 20, false),
        sampleRate: view.getFloat64(dataOffset, false),
      };
    }

    if (chunkType === 'data') {
      const availableBytes = Math.max(0, view.byteLength - dataOffset);
      const storedBytes =
        logicalSize > BigInt(availableBytes)
          ? availableBytes
          : Number(logicalSize);
      data = {
        offset: dataOffset + 4,
        size: Math.max(0, storedBytes - 4),
      };
      break;
    }

    const nextOffset = Number(BigInt(dataOffset) + logicalSize);
    if (!Number.isSafeInteger(nextOffset)) {
      break;
    }
    offset = nextOffset;
  }

  return { data, description };
}

function prepareCafDecode(input: AudioInput): PreparedCafDecode | null {
  const view = new DataView(input.data);
  if (!isCaf(view)) {
    return null;
  }

  const { data, description } = parseCaf(view);
  if (description === null || data === null) {
    throw invalidCaf('CAF requires both desc and data chunks.');
  }
  if (description.formatId !== 'lpcm') {
    throw new AudioTranscoderError(
      'UNSUPPORTED_INPUT',
      `CAF format "${description.formatId}" is not built-in LPCM.`,
    );
  }
  if (!isValidCafLpcmDescription(description)) {
    throw invalidCaf('CAF LPCM description fields are invalid.');
  }

  const bytesPerFrame = getCafBytesPerFrame(description)!;
  if (hasUnsupportedLpcmLayout(description, bytesPerFrame)) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_INPUT',
      'Padded CAF LPCM is not built in.',
    );
  }
  if (hasUnsupportedLpcmSampleRepresentation(description)) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_INPUT',
      'This CAF LPCM sample representation is not built in.',
    );
  }

  const availableBytes = Math.min(
    data.size,
    Math.max(0, view.byteLength - data.offset),
  );
  const frames = Math.floor(availableBytes / bytesPerFrame);
  if (frames === 0) {
    throw invalidCaf('CAF data chunk does not contain a complete frame.');
  }

  return {
    bytesPerFrame,
    bytesPerSample: description.bitDepth / 8,
    data,
    description,
    flags: decodeCafFlags(description.flags),
    frames,
    view,
  };
}

function decodeCafFlags(flags: number): CafFlags {
  const float = Boolean(flags & 1);
  const littleEndian = Boolean(flags & 2);
  const bigEndian = !littleEndian;
  const signed = !float;
  const sampleFormat = float ? 'float' : 'signed int';

  return {
    bigEndian,
    float,
    label: `${sampleFormat} ${bigEndian ? 'BE' : 'LE'}`,
    signed,
  };
}

function getCafSourceEncoding(
  description: CafDescription | null,
): AudioSourceEncoding {
  if (description === null) {
    return Object.freeze({ kind: 'unknown' });
  }
  if (description.formatId === 'lpcm') {
    const flags = decodeCafFlags(description.flags);
    return Object.freeze({
      bitDepth: description.bitDepth > 0 ? description.bitDepth : null,
      endianness:
        description.bitDepth <= 8
          ? 'not-applicable'
          : flags.bigEndian
            ? 'big'
            : 'little',
      kind: 'pcm',
      sampleFormat: flags.float ? 'float' : 'integer',
      signedness: flags.float ? 'not-applicable' : 'signed',
    });
  }

  const codec = normalizeCafCodec(description.formatId);
  if (codec === 'alac' || codec === 'flac') {
    return Object.freeze({
      bitDepth:
        codec === 'alac'
          ? getAlacSourceBitDepth(description.flags)
          : getFlacSourceBitDepth(description.flags),
      codec,
      kind: 'lossless-compressed',
    });
  }
  if (
    codec === 'aac' ||
    codec === 'mp3' ||
    codec === 'opus'
  ) {
    return Object.freeze({
      codec,
      estimatedBitrateBps: null,
      kind: 'lossy-compressed',
    });
  }
  return Object.freeze({ kind: 'unknown' });
}

function normalizeCafCodec(formatId: string): string {
  const codec = formatId.trim().toLowerCase();
  return codec === '.mp3' ? 'mp3' : codec;
}

function getAlacSourceBitDepth(flags: number): number | null {
  switch (flags) {
    case 1:
      return 16;
    case 2:
      return 20;
    case 3:
      return 24;
    case 4:
      return 32;
    default:
      return null;
  }
}

function getFlacSourceBitDepth(flags: number): number | null {
  switch (flags) {
    case 1:
      return 16;
    case 3:
      return 24;
    default:
      return null;
  }
}

function getCafBytesPerFrame(description: CafDescription): number | null {
  if (description.framesPerPacket <= 0) {
    return null;
  }

  const bytesPerFrame =
    description.bytesPerPacket / description.framesPerPacket;
  return Number.isSafeInteger(bytesPerFrame) && bytesPerFrame > 0
    ? bytesPerFrame
    : null;
}

function getUnsupportedCafLpcmNote(
  description: CafDescription,
  bytesPerFrame: number | null,
): string {
  if (!isValidCafLpcmDescription(description)) {
    return 'CAF LPCM description is invalid.';
  }
  if (hasUnsupportedLpcmLayout(description, bytesPerFrame!)) {
    return 'CAF LPCM layout requires a codec plugin.';
  }
  return 'CAF LPCM sample representation requires a codec plugin.';
}

function hasUnsupportedLpcmLayout(
  description: CafDescription,
  bytesPerFrame: number,
): boolean {
  const packedFrameBytes =
    (description.bitDepth / 8) * description.channels;
  return bytesPerFrame !== packedFrameBytes;
}

function hasUnsupportedLpcmSampleRepresentation(
  description: CafDescription,
): boolean {
  const flags = decodeCafFlags(description.flags);
  return (
    (description.flags & ~3) !== 0 ||
    (flags.float
      ? description.bitDepth !== 32 && description.bitDepth !== 64
      : ![8, 16, 24, 32].includes(description.bitDepth))
  );
}

function isValidCafLpcmDescription(description: CafDescription): boolean {
  const bytesPerFrame = getCafBytesPerFrame(description);
  return (
    description.channels > 0 &&
    Number.isFinite(description.sampleRate) &&
    description.sampleRate > 0 &&
    description.bytesPerPacket > 0 &&
    description.bitDepth > 0 &&
    description.bitDepth % 8 === 0 &&
    bytesPerFrame !== null &&
    (description.bitDepth / 8) * description.channels <= bytesPerFrame
  );
}

function invalidCaf(message: string): AudioTranscoderError {
  return new AudioTranscoderError('INVALID_AUDIO_DATA', message);
}
