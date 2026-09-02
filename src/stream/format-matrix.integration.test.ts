import { describe, expect, it } from "vitest";
import type {
  AudioStreamOutput,
  AudioStreamOutputChunk,
  AudioStreamOutputPresetId,
} from "./contracts.js";
import { createAudioTranscoderStreamEngine } from "./engine.js";
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from "./capabilities.js";
import {
  WAV_OUTPUT_PRESET_DESCRIPTORS,
  WAV_OUTPUT_PRESETS,
} from "../codecs/wav-presets.js";
import { STREAM_OUTPUT_PRESETS } from "../codecs/stream-output-presets.js";
import { createAudioTranscoderEngine } from "../engine/factory.js";
import { createTestCodecAssetProvider } from "./codec-assets.test-support.js";

const CODEC_ASSETS = createTestCodecAssetProvider();

const EXPECTED_OUTPUTS = Object.freeze([
  {
    bitDepth: 16,
    codec: "pcm-s16",
    id: "wav-pcm16",
    sampleFormat: "integer",
  },
  {
    bitDepth: 24,
    codec: "pcm-s24",
    id: "wav-pcm24",
    sampleFormat: "integer",
  },
  {
    bitDepth: 32,
    codec: "pcm-s32",
    id: "wav-pcm32",
    sampleFormat: "integer",
  },
  {
    bitDepth: 32,
    codec: "pcm-f32",
    id: "wav-float32",
    sampleFormat: "float",
  },
] as const);

const EXPECTED_INPUT_CAPABILITIES = Object.freeze([
  {
    extensions: ["aif", "aifc", "aiff", "caf"],
    path: "built-in-pcm",
  },
  {
    extensions: [
      "aac",
      "adts",
      "flac",
      "m4a",
      "mka",
      "mkv",
      "mov",
      "mp3",
      "mp4",
      "oga",
      "ogg",
      "opus",
      "qt",
      "ts",
      "wav",
      "wave",
      "webm",
    ],
    path: "runtime-probed",
  },
]);

const EXPECTED_CODEC_RUNTIME = Object.freeze({
  encoderAdapter: "mediabunny",
  inputAdapters: Object.freeze(["pcm", "mediabunny"]),
  resamplerAdapter: "libsamplerate-wasm",
});

const EXPECTED_INPUT_IDS = Object.freeze([
  "caf-s8",
  "caf-s16-be",
  "caf-s24-le",
  "caf-s32-be",
  "caf-f32-le",
  "caf-f64-be",
  "aiff-s16",
  "aiff-s24",
  "aiff-s32",
  "aifc-s16",
  "wav-pcm32-input",
  "wav-float32-input",
] as const);

const INPUTS: readonly MatrixInput[] = Object.freeze([
  cafInput("caf-s8", 48_000, 1, 8, false, false),
  cafInput("caf-s16-be", 44_100, 2, 16, false, false),
  cafInput("caf-s24-le", 96_000, 1, 24, false, true),
  cafInput("caf-s32-be", 192_000, 2, 32, false, false),
  cafInput("caf-f32-le", 192_000, 1, 32, true, true),
  cafInput("caf-f64-be", 48_000, 2, 64, true, false),
  aiffInput("aiff-s16", 44_100, 1, 16, false),
  aiffInput("aiff-s24", 96_000, 2, 24, false),
  aiffInput("aiff-s32", 48_000, 1, 32, false),
  aiffInput("aifc-s16", 48_000, 2, 16, true),
  wavInput("wav-pcm32-input", "wav-pcm32", 48_000, 2),
  wavInput("wav-float32-input", "wav-float32", 96_000, 1),
]);

const TARGET_SAMPLE_RATES = Object.freeze([44_100, 96_000] as const);
const TARGET_CHANNELS = Object.freeze([1, 2] as const);
const MATRIX = INPUTS.flatMap((input) =>
  EXPECTED_OUTPUTS.flatMap((output) =>
    TARGET_SAMPLE_RATES.flatMap((sampleRate) =>
      TARGET_CHANNELS.map((channels) => ({
        channels,
        input,
        output,
        sampleRate,
      })),
    ),
  ),
);

const inputCache = new Map<string, Promise<Blob>>();

describe("strict streaming format matrix", () => {
  it("matches the independent output capability manifest", () => {
    expect(
      WAV_OUTPUT_PRESET_DESCRIPTORS.map(({ bitDepth, codec, preset }) => ({
        bitDepth,
        codec,
        id: preset.id,
        sampleFormat: preset.sampleFormat,
      })),
    ).toEqual(EXPECTED_OUTPUTS);
    expect(WAV_OUTPUT_PRESETS.map(({ id }) => id)).toEqual(
      EXPECTED_OUTPUTS.map(({ id }) => id),
    );
    expect(WAV_OUTPUT_PRESET_DESCRIPTORS.every(Object.isFrozen)).toBe(true);
    expect(WAV_OUTPUT_PRESETS.every(Object.isFrozen)).toBe(true);
    expect(AUDIO_TRANSCODER_STREAM_CAPABILITIES.inputs).toEqual(
      EXPECTED_INPUT_CAPABILITIES,
    );
    expect(AUDIO_TRANSCODER_STREAM_CAPABILITIES.codecRuntime).toEqual(
      EXPECTED_CODEC_RUNTIME,
    );
    expect(
      Object.isFrozen(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES.codecRuntime.inputAdapters,
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(AUDIO_TRANSCODER_STREAM_CAPABILITIES.codecRuntime),
    ).toBe(true);
    expect(AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits).toEqual({
      buffers: {
        defaultInputReadBytes: 8 * 1024 * 1024,
        defaultOutputChunkBytes: 4 * 1024 * 1024,
        defaultPcmChunkBytes: 4 * 1024 * 1024,
        maximumBytes: 64 * 1024 * 1024,
        minimumBytes: 64 * 1024,
      },
      channels: { maximum: 32, minimum: 1 },
      maximumConcurrency: 4,
      queue: { defaultMaximumQueued: 8, maximumQueued: 64 },
      recommendedConcurrency: 1,
      sampleRate: {
        maximum: 384_000,
        minimum: 8_000,
        passThrough: { maximum: 384_000, minimum: 8_000 },
        resampling: { maximum: 192_000, minimum: 8_000 },
      },
    });
    expect(AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputPresets).toBe(
      STREAM_OUTPUT_PRESETS,
    );
    expect(Object.isFrozen(AUDIO_TRANSCODER_STREAM_CAPABILITIES)).toBe(true);
    expect(INPUTS.map(({ id }) => id)).toEqual(EXPECTED_INPUT_IDS);
    expect(MATRIX).toHaveLength(
      EXPECTED_INPUT_IDS.length *
        EXPECTED_OUTPUTS.length *
        TARGET_SAMPLE_RATES.length *
        TARGET_CHANNELS.length,
    );
  });

  it.each(MATRIX)(
    "$input.id -> $output.id at $sampleRate Hz / $channels ch",
    async ({ channels, input, output, sampleRate }) => {
      const blob = await getInput(input);
      const sink = new SeekableMemorySink();
      const result = await createAudioTranscoderStreamEngine({
        codecAssets: CODEC_ASSETS,
      }).transcode(
        { blob, name: `${input.id}.${input.extension}` },
        {
          channels,
          dither: "none",
          presetId: output.id,
          sampleRate,
        },
        sink.stream,
      );
      const bytes = sink.bytes();
      const localEngine = createAudioTranscoderEngine();
      const inspection = localEngine.inspect({ data: bytes.buffer });
      const decoded = await localEngine.decode({ data: bytes.buffer });
      const expectedFrames = Math.floor(
        (input.frames * sampleRate) / input.sampleRate,
      );

      expect(result).toMatchObject({
        bytesWritten: bytes.byteLength,
        channels,
        preset: expect.objectContaining({ id: output.id }),
        rf64: false,
        sampleRate,
      });
      expect(inspection).toMatchObject({
        bitDepth: output.bitDepth,
        channels,
        codec: output.sampleFormat === "float" ? "PCM float" : "PCM integer",
        container: "WAV",
        sampleRate,
      });
      expect(decoded.channelData).toHaveLength(channels);
      expect(
        decoded.channelData.every(
          (channel) => channel.length === expectedFrames,
        ),
      ).toBe(true);
      expect(
        decoded.channelData.every((channel) =>
          channel.every((sample) => Number.isFinite(sample)),
        ),
      ).toBe(true);
      expect(result.durationSeconds).toBe(expectedFrames / sampleRate);
      expect(sink.closed).toBe(true);
      expect(sink.aborted).toBe(false);
    },
  );

  it.each(EXPECTED_OUTPUTS)("writes real RF64 for $id", async ({ id }) => {
    const input = INPUTS[0]!;
    const sink = new SeekableMemorySink();
    await createAudioTranscoderStreamEngine({
      codecAssets: CODEC_ASSETS,
    }).transcode(
      { blob: await getInput(input), name: "source.caf" },
      { presetId: id, wavContainer: "rf64" },
      sink.stream,
    );

    expect(readAscii(sink.bytes(), 0, 4)).toBe("RF64");
    expect(readAscii(sink.bytes(), 12, 4)).toBe("ds64");
    expect(sink.closed).toBe(true);
  });
});

interface MatrixInput {
  readonly create: () => Promise<Blob>;
  readonly extension: string;
  readonly frames: number;
  readonly id: string;
  readonly sampleRate: number;
}

function getInput(input: MatrixInput): Promise<Blob> {
  const existing = inputCache.get(input.id);
  if (existing !== undefined) {
    return existing;
  }
  const created = input.create();
  inputCache.set(input.id, created);
  return created;
}

function cafInput(
  id: string,
  sampleRate: number,
  channels: number,
  bitDepth: 8 | 16 | 24 | 32 | 64,
  float: boolean,
  littleEndian: boolean,
): MatrixInput {
  const frames = 256;
  return {
    create: async () =>
      createCaf({
        bitDepth,
        channels,
        float,
        frames,
        littleEndian,
        sampleRate,
      }),
    extension: "caf",
    frames,
    id,
    sampleRate,
  };
}

function aiffInput(
  id: string,
  sampleRate: number,
  channels: number,
  bitDepth: 16 | 24 | 32,
  aifc: boolean,
): MatrixInput {
  const frames = 256;
  return {
    create: async () =>
      createAiff({
        aifc,
        bitDepth,
        channels,
        frames,
        sampleRate,
      }),
    extension: aifc ? "aifc" : "aiff",
    frames,
    id,
    sampleRate,
  };
}

function wavInput(
  id: string,
  presetId: AudioStreamOutputPresetId,
  sampleRate: number,
  channels: number,
): MatrixInput {
  const frames = 256;
  return {
    async create() {
      const channelData = Array.from({ length: channels }, (_value, channel) =>
        createSignal(frames, channel),
      );
      const encoded = await createAudioTranscoderEngine().encode(
        { channelData, sampleRate },
        presetId,
      );
      return new Blob([encoded.data], { type: "audio/wav" });
    },
    extension: "wav",
    frames,
    id,
    sampleRate,
  };
}

function createCaf(options: {
  readonly bitDepth: 8 | 16 | 24 | 32 | 64;
  readonly channels: number;
  readonly float: boolean;
  readonly frames: number;
  readonly littleEndian: boolean;
  readonly sampleRate: number;
}): Blob {
  const bytesPerSample = options.bitDepth / 8;
  const payloadBytes = options.frames * options.channels * bytesPerSample;
  const buffer = new ArrayBuffer(68 + payloadBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "caff");
  view.setUint16(4, 1, false);
  writeAscii(view, 8, "desc");
  view.setBigInt64(12, 32n, false);
  view.setFloat64(20, options.sampleRate, false);
  writeAscii(view, 28, "lpcm");
  const flags = (options.float ? 1 : 0) | (options.littleEndian ? 2 : 0);
  view.setUint32(32, flags, false);
  view.setUint32(36, bytesPerSample * options.channels, false);
  view.setUint32(40, 1, false);
  view.setUint32(44, options.channels, false);
  view.setUint32(48, options.bitDepth, false);
  writeAscii(view, 52, "data");
  view.setBigInt64(56, BigInt(payloadBytes + 4), false);
  writeInterleavedPcm(view, 68, options);
  return new Blob([buffer], { type: "audio/x-caf" });
}

function createAiff(options: {
  readonly aifc: boolean;
  readonly bitDepth: 16 | 24 | 32;
  readonly channels: number;
  readonly frames: number;
  readonly sampleRate: number;
}): Blob {
  const commonBytes = options.aifc ? 22 : 18;
  const bytesPerSample = options.bitDepth / 8;
  const payloadBytes = options.frames * options.channels * bytesPerSample;
  const soundBytes = 8 + payloadBytes;
  const totalBytes = 12 + 8 + commonBytes + 8 + soundBytes;
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "FORM");
  view.setUint32(4, totalBytes - 8, false);
  writeAscii(view, 8, options.aifc ? "AIFC" : "AIFF");
  writeAscii(view, 12, "COMM");
  view.setUint32(16, commonBytes, false);
  view.setUint16(20, options.channels, false);
  view.setUint32(22, options.frames, false);
  view.setUint16(26, options.bitDepth, false);
  writeExtended80(view, 28, options.sampleRate);
  if (options.aifc) {
    writeAscii(view, 38, "NONE");
  }
  const soundChunk = 20 + commonBytes;
  writeAscii(view, soundChunk, "SSND");
  view.setUint32(soundChunk + 4, soundBytes, false);
  writeInterleavedPcm(view, soundChunk + 16, {
    ...options,
    float: false,
    littleEndian: false,
  });
  return new Blob([buffer], { type: "audio/aiff" });
}

function writeInterleavedPcm(
  view: DataView,
  offset: number,
  options: {
    readonly bitDepth: 8 | 16 | 24 | 32 | 64;
    readonly channels: number;
    readonly float: boolean;
    readonly frames: number;
    readonly littleEndian: boolean;
  },
): void {
  const bytesPerSample = options.bitDepth / 8;
  for (let frame = 0; frame < options.frames; frame += 1) {
    for (let channel = 0; channel < options.channels; channel += 1) {
      const sample = signalAt(frame, channel);
      const sampleOffset =
        offset + (frame * options.channels + channel) * bytesPerSample;
      if (options.float && options.bitDepth === 32) {
        view.setFloat32(sampleOffset, sample, options.littleEndian);
      } else if (options.float) {
        view.setFloat64(sampleOffset, sample, options.littleEndian);
      } else if (options.bitDepth === 8) {
        view.setInt8(sampleOffset, toInteger(sample, 8));
      } else if (options.bitDepth === 16) {
        view.setInt16(
          sampleOffset,
          toInteger(sample, 16),
          options.littleEndian,
        );
      } else if (options.bitDepth === 24) {
        writeInt24(
          view,
          sampleOffset,
          toInteger(sample, 24),
          options.littleEndian,
        );
      } else {
        view.setInt32(
          sampleOffset,
          toInteger(sample, 32),
          options.littleEndian,
        );
      }
    }
  }
}

function createSignal(frames: number, channel: number): Float32Array {
  return Float32Array.from({ length: frames }, (_value, frame) =>
    signalAt(frame, channel),
  );
}

function signalAt(frame: number, channel: number): number {
  return 0.5 * Math.sin((2 * Math.PI * (frame + channel * 7)) / 31);
}

function toInteger(sample: number, bitDepth: number): number {
  const maximum = 2 ** (bitDepth - 1) - 1;
  const minimum = -(2 ** (bitDepth - 1));
  return Math.round(sample < 0 ? sample * -minimum : sample * maximum);
}

function writeInt24(
  view: DataView,
  offset: number,
  value: number,
  littleEndian: boolean,
): void {
  if (littleEndian) {
    view.setUint8(offset, value & 0xff);
    view.setUint8(offset + 1, (value >> 8) & 0xff);
    view.setUint8(offset + 2, (value >> 16) & 0xff);
  } else {
    view.setUint8(offset, (value >> 16) & 0xff);
    view.setUint8(offset + 1, (value >> 8) & 0xff);
    view.setUint8(offset + 2, value & 0xff);
  }
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function writeExtended80(view: DataView, offset: number, value: number): void {
  const power = Math.floor(Math.log2(value));
  const mantissa = BigInt(Math.round((value / 2 ** power) * 2 ** 63));
  view.setUint16(offset, power + 16_383, false);
  view.setUint32(offset + 2, Number((mantissa >> 32n) & 0xffff_ffffn), false);
  view.setUint32(offset + 6, Number(mantissa & 0xffff_ffffn), false);
}

class SeekableMemorySink {
  aborted = false;
  closed = false;
  private data = new Uint8Array();
  readonly stream: AudioStreamOutput;

  constructor() {
    this.stream = new WritableStream<AudioStreamOutputChunk>({
      abort: () => {
        this.aborted = true;
      },
      close: () => {
        this.closed = true;
      },
      write: ({ data, position }) => {
        const end = position + data.byteLength;
        if (end > this.data.byteLength) {
          const expanded = new Uint8Array(end);
          expanded.set(this.data);
          this.data = expanded;
        }
        this.data.set(data, position);
      },
    });
  }

  bytes(): Uint8Array<ArrayBuffer> {
    return this.data;
  }
}
