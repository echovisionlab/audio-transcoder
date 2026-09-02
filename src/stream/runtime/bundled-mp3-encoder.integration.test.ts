import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  Mp3OutputFormat,
  Output,
} from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';
import {
  instantiateBundledMp3Wasm,
  parseBundledMp3FrameHeader,
  createBundledMp3EncoderRegistration,
  type BundledMp3FrameHeader,
  type Mp3WasmByteLoader,
} from './bundled-mp3-encoder.js';

const artifactUrl = new URL(
  '../../../codec-build/mp3/mp3.wasm',
  import.meta.url,
);
const loadWasm = vi.fn(async () => {
  // Node types are deliberately absent from the browser package's tsconfig.
  // @ts-expect-error Vitest runs this integration fixture in Node.
  const { readFile } = await import('node:fs/promises');
  return Uint8Array.from(await readFile(artifactUrl));
}) as Mp3WasmByteLoader & ReturnType<typeof vi.fn>;
const bundledMp3Encoder = createBundledMp3EncoderRegistration(loadWasm);

describe('bundled MP3 encoder integration', () => {
  it('encodes deterministic MPEG-1 Layer III without creating a nested Worker', async () => {
    bundledMp3Encoder.register();

    const first = await encodeMp3();
    const second = await encodeMp3();

    expect(second).toEqual(first);
    expect(loadWasm).toHaveBeenCalledOnce();
    const frames = parseFrames(first);
    expect(frames.length).toBeGreaterThan(0);
    expect(
      frames.every(
        ({ audioSamplesInFrame, sampleRate }) =>
          audioSamplesInFrame === 1152 && sampleRate === 48_000,
      ),
    ).toBe(true);
  });

  it('runs the pinned ABI at the supported low-rate edge and rejects invalid native configurations', async () => {
    bundledMp3Encoder.register();
    const bytes = await encodeMp3({
      channels: 1,
      frames: 1_600,
      sampleRate: 16_000,
    });
    const frames = parseFrames(bytes);
    expect(frames.length).toBeGreaterThan(0);
    expect(
      frames.every(
        ({ audioSamplesInFrame, sampleRate }) =>
          audioSamplesInFrame === 576 && sampleRate === 16_000,
      ),
    ).toBe(true);

    const runtime = await instantiateBundledMp3Wasm(loadWasm);
    const highBitrate = runtime.wasm_mp3_create(2, 48_000, 320_000);
    expect(highBitrate).not.toBe(0);
    runtime.wasm_mp3_destroy(highBitrate);
    expect(runtime.wasm_mp3_create(2, 24_000, 192_000)).toBe(0);
    expect(runtime.wasm_mp3_last_create_error()).toBeLessThan(0);
  });
});

async function encodeMp3(
  options: {
    readonly channels?: number;
    readonly frames?: number;
    readonly sampleRate?: number;
  } = {},
): Promise<Uint8Array> {
  const channels = options.channels ?? 2;
  const sampleRate = options.sampleRate ?? 48_000;
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp3OutputFormat({ xingHeader: true }),
    target,
  });
  const source = new AudioSampleSource({
    bitrate: 128_000,
    bitrateMode: 'constant',
    codec: 'mp3',
    onEncoderConfig: bundledMp3Encoder.bind,
  });
  output.addAudioTrack(source);
  await output.start();

  const frames = options.frames ?? 4_800;
  const samples = Float32Array.from(
    { length: frames * channels },
    (_value, index) =>
      Math.sin((index * Math.PI) / 32) * 0.25,
  );
  const sample = new AudioSample({
    data: samples,
    format: 'f32',
    numberOfChannels: channels,
    sampleRate,
    timestamp: 0,
  });
  try {
    await source.add(sample);
  } finally {
    sample.close();
  }
  source.close();
  await output.finalize();

  if (target.buffer === null) {
    throw new Error('MediaBunny did not finalize the MP3 buffer.');
  }
  return new Uint8Array(target.buffer);
}

function parseFrames(bytes: Uint8Array): readonly BundledMp3FrameHeader[] {
  const frames: BundledMp3FrameHeader[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) {
      throw new Error(`Truncated MP3 header at byte ${offset}.`);
    }
    const word = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset,
      4,
    ).getUint32(0, false);
    const header = parseBundledMp3FrameHeader(word);
    if (header === null || offset + header.totalSize > bytes.byteLength) {
      throw new Error(`Invalid MP3 frame at byte ${offset}.`);
    }
    frames.push(header);
    offset += header.totalSize;
  }
  return frames;
}
