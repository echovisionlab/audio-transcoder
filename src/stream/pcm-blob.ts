import type {
  AudioStreamInput,
  AudioStreamInspection,
} from './contracts.js';
import type { AudioSourceEncoding } from '../engine/contracts.js';
import type { PcmStreamSource } from './pcm-source.js';
import { AudioTranscoderError } from '../errors.js';
import { createOperationAbortedError } from '../engine/operation-errors.js';
import {
  readAscii,
  readExtended80,
  readInt64BE,
} from '../codecs/binary.js';
import { readPcmSample } from '../codecs/pcm.js';
import {
  getAudioStreamInputSize,
  readAudioStreamInputRange,
} from './runtime/bounded-blob-source.js';

const PCM_CHUNK_FRAMES = 16_384;
const MAX_CHANNELS = 32;

interface ParsedPcmBlob {
  readonly bitDepth: number | null;
  readonly bytesPerFrame: number | null;
  readonly channels: number;
  readonly codec: string;
  readonly container: 'AIFC' | 'AIFF' | 'CAF';
  readonly dataOffset: number;
  readonly float: boolean;
  readonly littleEndian: boolean;
  readonly sampleRate: number;
  readonly signed: boolean;
  readonly sourceEncoding: AudioSourceEncoding;
  readonly totalFrames: number | null;
  readonly unsupportedReason?: string;
}

type SupportedPcmBlob = ParsedPcmBlob & {
  readonly bitDepth: number;
  readonly bytesPerFrame: number;
  readonly totalFrames: number;
  readonly unsupportedReason?: never;
};

type ParsedPcmDescription = Omit<
  ParsedPcmBlob,
  'container' | 'dataOffset' | 'totalFrames'
>;

type AiffCommon = ParsedPcmDescription & {
  readonly bitDepth: number;
  readonly bytesPerFrame: number;
  readonly declaredFrames: number;
};

export async function inspectCustomPcmBlob(
  input: AudioStreamInput,
  signal?: AbortSignal,
): Promise<AudioStreamInspection | null> {
  const parsed = await parseCustomPcmInput(input, signal);
  return parsed === null
    ? null
    : toInspection(parsed, getAudioStreamInputSize(input));
}

export async function openCustomPcmBlobSource(
  input: AudioStreamInput,
  inputReadBytes: number,
  pcmChunkBytes: number,
  signal?: AbortSignal,
): Promise<PcmStreamSource | null> {
  assertPositiveChunkLimit(inputReadBytes, 'inputReadBytes');
  assertPositiveChunkLimit(pcmChunkBytes, 'pcmChunkBytes');
  const parsed = await parseCustomPcmInput(input, signal);
  if (parsed === null) {
    return null;
  }
  if (parsed.unsupportedReason !== undefined) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_INPUT',
      parsed.unsupportedReason,
    );
  }
  const pcm = parsed as SupportedPcmBlob;
  const framesPerChunk = resolveFramesPerChunk(
    pcm,
    inputReadBytes,
    pcmChunkBytes,
  );

  const inspection = toInspection(pcm, getAudioStreamInputSize(input));
  return {
    channels: pcm.channels,
    close(): void {},
    async *chunks(chunkSignal?: AbortSignal) {
      const bytesPerSample = pcm.bitDepth / 8;
      for (
        let startFrame = 0;
        startFrame < pcm.totalFrames;
        startFrame += framesPerChunk
      ) {
        throwIfAborted(chunkSignal);
        const frames = Math.min(
          framesPerChunk,
          pcm.totalFrames - startFrame,
        );
        const bytes = await readInputRange(
          input,
          pcm.dataOffset + startFrame * pcm.bytesPerFrame,
          frames * pcm.bytesPerFrame,
          chunkSignal,
        );
        const view = new DataView(bytes);
        const samples = new Float32Array(frames * pcm.channels);

        for (let frame = 0; frame < frames; frame += 1) {
          const frameOffset = frame * pcm.bytesPerFrame;
          for (let channel = 0; channel < pcm.channels; channel += 1) {
            samples[frame * pcm.channels + channel] = readPcmSample(
              view,
              frameOffset + channel * bytesPerSample,
              pcm.bitDepth,
              {
                float: pcm.float,
                littleEndian: pcm.littleEndian,
                signed: pcm.signed,
              },
            );
          }
        }
        throwIfAborted(chunkSignal);
        yield samples;
      }
    },
    durationSeconds: pcm.totalFrames / pcm.sampleRate,
    inspection,
    sampleRate: pcm.sampleRate,
    totalFrames: pcm.totalFrames,
  };
}

function resolveFramesPerChunk(
  pcm: SupportedPcmBlob,
  inputReadBytes: number,
  pcmChunkBytes: number,
): number {
  const sourceFrameBytes = pcm.bytesPerFrame;
  const decodedFrameBytes = pcm.channels * Float32Array.BYTES_PER_ELEMENT;
  if (sourceFrameBytes > inputReadBytes) {
    throw invalidConfiguration(
      `inputReadBytes must be at least ${sourceFrameBytes} bytes for one source PCM frame.`,
    );
  }
  if (decodedFrameBytes > pcmChunkBytes) {
    throw invalidConfiguration(
      `pcmChunkBytes must be at least ${decodedFrameBytes} bytes for one decoded PCM frame.`,
    );
  }
  return Math.min(
    PCM_CHUNK_FRAMES,
    Math.floor(inputReadBytes / sourceFrameBytes),
    Math.floor(pcmChunkBytes / decodedFrameBytes),
  );
}

function assertPositiveChunkLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidConfiguration(`${name} must be a positive safe integer.`);
  }
}

async function parseCustomPcmInput(
  input: AudioStreamInput,
  signal?: AbortSignal,
): Promise<ParsedPcmBlob | null> {
  const size = getAudioStreamInputSize(input);
  if (size < 12) {
    return null;
  }
  const header = new DataView(await readInputRange(input, 0, 12, signal));
  if (readAscii(header, 0, 4) === 'caff') {
    return parseCaf(input, signal);
  }
  const formType = readAscii(header, 8, 4);
  if (
    readAscii(header, 0, 4) === 'FORM' &&
    (formType === 'AIFF' || formType === 'AIFC')
  ) {
    return parseAiff(input, formType, signal);
  }
  return null;
}

async function parseCaf(
  input: AudioStreamInput,
  signal?: AbortSignal,
): Promise<ParsedPcmBlob> {
  const size = getAudioStreamInputSize(input);
  let offset = 8;
  let description: ParsedPcmDescription | undefined;

  while (offset + 12 <= size) {
    const header = new DataView(
      await readInputRange(input, offset, 12, signal),
    );
    const chunkType = readAscii(header, 0, 4);
    const encodedSize = readInt64BE(header, 4);
    const dataOffset = offset + 12;
    const logicalSize =
      encodedSize === -1n ? size - dataOffset : toSafeSize(encodedSize);
    assertChunkRange(size, dataOffset, logicalSize, 'CAF');

    if (chunkType === 'desc') {
      if (logicalSize < 32) {
        throw invalidAudio('CAF desc chunk is too small.');
      }
      const view = new DataView(
        await readInputRange(input, dataOffset, 32, signal),
      );
      const flags = view.getUint32(12, false);
      const bitDepth = view.getUint32(28, false);
      const bytesPerPacket = view.getUint32(16, false);
      const framesPerPacket = view.getUint32(20, false);
      const channels = view.getUint32(24, false);
      const sampleRate = view.getFloat64(0, false);
      const formatId = readAscii(view, 8, 4);
      const float = Boolean(flags & 1);
      const littleEndian = Boolean(flags & 2);
      const bigEndian = !littleEndian;
      const signed = !float;
      const candidateBytesPerFrame = framesPerPacket === 0
        ? 0
        : bytesPerPacket / framesPerPacket;
      const bytesPerFrame =
        Number.isSafeInteger(candidateBytesPerFrame) &&
        candidateBytesPerFrame > 0
          ? candidateBytesPerFrame
          : null;
      validateBasicAudioParameters(channels, sampleRate);

      if (formatId === 'lpcm') {
        validatePcmDescription({
          bitDepth,
          bytesPerFrame: bytesPerFrame ?? 0,
          channels,
          sampleRate,
        });
      }
      const unsupportedSampleFormat =
        (flags & ~3) !== 0 ||
        (float && bitDepth !== 32 && bitDepth !== 64) ||
        (!float && ![8, 16, 24, 32].includes(bitDepth));
      const paddedLayout =
        bytesPerFrame !== null &&
        bytesPerFrame !== (bitDepth / 8) * channels;

      description = {
        bitDepth: bitDepth === 0 ? null : bitDepth,
        bytesPerFrame,
        channels,
        codec:
          formatId === 'lpcm'
            ? `${formatId} ${float ? 'float' : 'signed integer'} ${bigEndian ? 'BE' : 'LE'}`
            : normalizeCafCodec(formatId),
        float,
        littleEndian,
        sampleRate,
        signed,
        sourceEncoding: getCafSourceEncoding(
          formatId,
          flags,
          bitDepth,
          float,
          bigEndian,
        ),
        ...(formatId !== 'lpcm'
          ? { unsupportedReason: `CAF format "${formatId}" is not LPCM.` }
          : paddedLayout
            ? {
                unsupportedReason:
                  'Padded CAF LPCM is unsupported.',
              }
            : unsupportedSampleFormat
              ? {
                  unsupportedReason:
                    'This CAF LPCM sample representation is unsupported.',
                }
            : {}),
      };
    }

    if (chunkType === 'data') {
      if (description === undefined) {
        throw invalidAudio('CAF desc chunk must precede the data chunk.');
      }
      if (logicalSize < 4) {
        throw invalidAudio('CAF data chunk is too small.');
      }
      const audioBytes = logicalSize - 4;
      const totalFrames = description.bytesPerFrame === null
        ? null
        : Math.floor(audioBytes / description.bytesPerFrame);
      if (description.unsupportedReason === undefined) {
        assertNonEmpty(totalFrames!, 'CAF data');
      }
      return {
        ...description,
        container: 'CAF',
        dataOffset: dataOffset + 4,
        totalFrames,
      };
    }

    offset = dataOffset + logicalSize;
  }

  throw invalidAudio('CAF requires both desc and data chunks.');
}

async function parseAiff(
  input: AudioStreamInput,
  formType: 'AIFC' | 'AIFF',
  signal?: AbortSignal,
): Promise<ParsedPcmBlob> {
  const size = getAudioStreamInputSize(input);
  let offset = 12;
  let common: AiffCommon | undefined;

  while (offset + 8 <= size) {
    const header = new DataView(
      await readInputRange(input, offset, 8, signal),
    );
    const chunkId = readAscii(header, 0, 4);
    const chunkSize = header.getUint32(4, false);
    const dataOffset = offset + 8;
    assertChunkRange(size, dataOffset, chunkSize, formType);

    if (chunkId === 'COMM') {
      if (chunkSize < 18) {
        throw invalidAudio(`${formType} COMM chunk is too small.`);
      }
      const bytesToRead = formType === 'AIFC' ? Math.min(22, chunkSize) : 18;
      const view = new DataView(
        await readInputRange(input, dataOffset, bytesToRead, signal),
      );
      const bitDepth = view.getUint16(6, false);
      const channels = view.getUint16(0, false);
      const sampleRate = readExtended80(view, 8);
      const compression =
        formType === 'AIFC' && chunkSize >= 22
          ? readAscii(view, 18, 4)
          : 'NONE';
      const bytesPerFrame = channels * (bitDepth / 8);
      validatePcmDescription({
        bitDepth,
        bytesPerFrame,
        channels,
        sampleRate,
      });
      common = {
        bitDepth,
        bytesPerFrame,
        channels,
        codec:
          compression === 'NONE'
            ? 'PCM signed integer BE'
            : `Compression ${compression}`,
        declaredFrames: view.getUint32(2, false),
        float: false,
        littleEndian: false,
        sampleRate,
        signed: true,
        sourceEncoding: getAiffSourceEncoding(compression, bitDepth),
        ...(compression === 'NONE'
          ? {}
          : {
              unsupportedReason: `${formType} compression "${compression}" is unsupported.`,
            }),
      };
    }

    if (chunkId === 'SSND') {
      if (common === undefined) {
        throw invalidAudio(`${formType} COMM chunk must precede SSND.`);
      }
      if (chunkSize < 8) {
        throw invalidAudio(`${formType} SSND chunk is too small.`);
      }
      const soundHeader = new DataView(
        await readInputRange(input, dataOffset, 8, signal),
      );
      const soundOffset = soundHeader.getUint32(0, false);
      if (soundOffset > chunkSize - 8) {
        throw invalidAudio(`${formType} SSND offset exceeds its chunk.`);
      }
      const availableFrames = Math.floor(
        (chunkSize - 8 - soundOffset) / common.bytesPerFrame,
      );
      const totalFrames = Math.min(common.declaredFrames, availableFrames);
      assertNonEmpty(totalFrames, `${formType} SSND`);
      const { declaredFrames: _declaredFrames, ...description } = common;
      return {
        ...description,
        container: formType,
        dataOffset: dataOffset + 8 + soundOffset,
        totalFrames,
      };
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  throw invalidAudio(`${formType} requires both COMM and SSND chunks.`);
}

function toInspection(
  parsed: ParsedPcmBlob,
  size: number,
): AudioStreamInspection {
  return Object.freeze({
    bitDepth: parsed.bitDepth,
    channels: parsed.channels,
    codec: parsed.codec,
    container: parsed.container,
    decodeSupport:
      parsed.unsupportedReason === undefined ? 'built-in' : 'browser-dependent',
    durationSeconds:
      parsed.totalFrames === null
        ? null
        : parsed.totalFrames / parsed.sampleRate,
    notes:
      parsed.unsupportedReason === undefined ? [] : [parsed.unsupportedReason],
    sampleRate: parsed.sampleRate,
    size,
    sourceEncoding: parsed.sourceEncoding,
  });
}

function getCafSourceEncoding(
  formatId: string,
  flags: number,
  bitDepth: number,
  float: boolean,
  bigEndian: boolean,
): AudioSourceEncoding {
  if (formatId === 'lpcm') {
    return Object.freeze({
      bitDepth,
      endianness:
        bitDepth <= 8 ? 'not-applicable' : bigEndian ? 'big' : 'little',
      kind: 'pcm',
      sampleFormat: float ? 'float' : 'integer',
      signedness: float ? 'not-applicable' : 'signed',
    });
  }

  const codec = normalizeCafCodec(formatId);
  if (codec === 'alac' || codec === 'flac') {
    return Object.freeze({
      bitDepth:
        codec === 'alac'
          ? getAlacSourceBitDepth(flags)
          : getFlacSourceBitDepth(flags),
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

function getAiffSourceEncoding(
  compression: string,
  bitDepth: number,
): AudioSourceEncoding {
  switch (compression) {
    case 'NONE':
    case 'twos':
      return createPcmEncoding(bitDepth, 'integer', 'big', 'signed');
    case 'sowt':
      return createPcmEncoding(bitDepth, 'integer', 'little', 'signed');
    case 'raw ':
      return createPcmEncoding(
        bitDepth,
        'integer',
        'not-applicable',
        'unsigned',
      );
    case 'fl32':
    case 'FL32':
    case 'fl64':
    case 'FL64':
      return createPcmEncoding(bitDepth, 'float', 'big', 'not-applicable');
    case 'ALAC':
    case 'alac':
      return Object.freeze({
        bitDepth: null,
        codec: 'alac',
        kind: 'lossless-compressed',
      });
    case 'alaw':
    case 'ima4':
    case 'ulaw':
      return Object.freeze({
        codec: compression.trim().toLowerCase(),
        estimatedBitrateBps: null,
        kind: 'lossy-compressed',
      });
    default:
      return Object.freeze({ kind: 'unknown' });
  }
}

function createPcmEncoding(
  bitDepth: number,
  sampleFormat: 'float' | 'integer',
  endianness: Extract<AudioSourceEncoding, { readonly kind: 'pcm' }>['endianness'],
  signedness: Extract<AudioSourceEncoding, { readonly kind: 'pcm' }>['signedness'],
): AudioSourceEncoding {
  return Object.freeze({
    bitDepth,
    endianness: bitDepth <= 8 ? 'not-applicable' : endianness,
    kind: 'pcm',
    sampleFormat,
    signedness,
  });
}

function validatePcmDescription(description: {
  readonly bitDepth: number;
  readonly bytesPerFrame: number;
  readonly channels: number;
  readonly sampleRate: number;
}): void {
  validateBasicAudioParameters(description.channels, description.sampleRate);
  const bytesPerSample = description.bitDepth / 8;
  if (
    ![8, 16, 24, 32, 64].includes(description.bitDepth) ||
    !Number.isInteger(description.bytesPerFrame) ||
    description.bytesPerFrame < bytesPerSample * description.channels
  ) {
    throw invalidAudio('PCM stream description is invalid.');
  }
}

function validateBasicAudioParameters(
  channels: number,
  sampleRate: number,
): void {
  if (
    !Number.isSafeInteger(channels) ||
    channels < 1 ||
    channels > MAX_CHANNELS ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 1
  ) {
    throw invalidAudio('PCM stream description is invalid.');
  }
}

function assertChunkRange(
  sourceSize: number,
  offset: number,
  size: number,
  container: string,
): void {
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !Number.isSafeInteger(offset + size) ||
    offset + size > sourceSize
  ) {
    throw invalidAudio(`${container} chunk exceeds the source file.`);
  }
}

function assertNonEmpty(frames: number, label: string): void {
  if (!Number.isSafeInteger(frames) || frames < 1) {
    throw invalidAudio(`${label} does not contain a complete PCM frame.`);
  }
}

function toSafeSize(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidAudio('Audio chunk size is outside the safe integer range.');
  }
  return Number(value);
}

async function readInputRange(
  input: AudioStreamInput,
  offset: number,
  size: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  const blob = 'blob' in input && input.blob instanceof Blob
    ? input.blob
    : undefined;
  const inputSize = blob?.size ?? getAudioStreamInputSize(input);
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset + size > inputSize
  ) {
    throw invalidAudio('Requested audio byte range is outside the source file.');
  }
  if (blob !== undefined) {
    const bytes = await blob.slice(offset, offset + size).arrayBuffer();
    throwIfAborted(signal);
    if (bytes.byteLength !== size) {
      throw invalidAudio('The browser returned a truncated audio byte range.');
    }
    return bytes;
  }
  const bytes = await readAudioStreamInputRange(
    input,
    offset,
    offset + size,
    signal,
  );
  throwIfAborted(signal);
  if (bytes.byteLength !== size) {
    throw invalidAudio('The browser returned a truncated audio byte range.');
  }
  return bytes.buffer;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createOperationAbortedError(signal);
  }
}

function invalidAudio(message: string): AudioTranscoderError {
  return new AudioTranscoderError('INVALID_AUDIO_DATA', message);
}

function invalidConfiguration(message: string): AudioTranscoderError {
  return new AudioTranscoderError('INVALID_CONFIGURATION', message);
}
