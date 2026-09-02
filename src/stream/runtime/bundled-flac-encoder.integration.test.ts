import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BufferSource,
  BufferTarget,
  EncodedPacketSink,
  FlacOutputFormat,
  Input,
  Output,
} from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { createBundledFlacEncoderRegistration } from './bundled-flac-encoder.js';

const loadFlacWasm = async (): Promise<Uint8Array<ArrayBuffer>> => {
  // Node types are deliberately absent from the browser package's tsconfig.
  // @ts-expect-error Vitest runs this integration fixture in Node.
  const { readFile } = await import('node:fs/promises');
  const bytes: Uint8Array = await readFile(
    new URL('../../../codec-build/flac/flac.wasm', import.meta.url),
  );
  return Uint8Array.from(bytes);
};
const bundledFlacEncoder = createBundledFlacEncoderRegistration(loadFlacWasm);

describe('bundled FLAC encoder integration', () => {
  it.each([
    ['s16', 16],
    ['f32', 24],
  ] as const)('encodes deterministic %s PCM through MediaBunny', async (format, bitDepth) => {
    bundledFlacEncoder.register();

    const first = await encodeFlac(format);
    const second = await encodeFlac(format);
    expect(second).toEqual(first);
    expect(first.subarray(0, 4)).toEqual(Uint8Array.of(0x66, 0x4c, 0x61, 0x43));
    expect(readStreamInfo(first)).toEqual({
      bitDepth,
      channels: 2,
      sampleRate: 48_000,
    });

    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(first),
    });
    const track = await input.getPrimaryAudioTrack();
    expect(track).not.toBeNull();
    expect(await track!.getCodec()).toBe('flac');
    expect(await track!.getSampleRate()).toBe(48_000);
    expect(await track!.getNumberOfChannels()).toBe(2);
    const sink = new EncodedPacketSink(track!);
    let packets = 0;
    for await (const packet of sink.packets()) {
      expect(packet.type).toBe('key');
      packets += 1;
    }
    expect(packets).toBeGreaterThan(0);
    input.dispose();
  });
});

async function encodeFlac(format: 'f32' | 's16'): Promise<Uint8Array> {
  const target = new BufferTarget();
  const output = new Output({
    format: new FlacOutputFormat(),
    target,
  });
  const source = new AudioSampleSource({
    codec: 'flac',
    onEncoderConfig: bundledFlacEncoder.bind,
  });
  output.addAudioTrack(source);
  await output.start();

  const frames = 4_096;
  const values = Array.from({ length: frames * 2 }, (_value, index) =>
    Math.sin((index * Math.PI) / 64),
  );
  const data = format === 's16'
    ? Int16Array.from(values, (value) => Math.round(value * 32_767))
    : Float32Array.from(values, (value) => value * 0.5);
  const sample = new AudioSample({
    data,
    format,
    numberOfChannels: 2,
    sampleRate: 48_000,
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
    throw new Error('MediaBunny did not finalize the FLAC buffer.');
  }
  return new Uint8Array(target.buffer);
}

function readStreamInfo(bytes: Uint8Array): {
  readonly bitDepth: number;
  readonly channels: number;
  readonly sampleRate: number;
} {
  if (bytes.byteLength < 22 || (bytes[4]! & 0x7f) !== 0) {
    throw new Error('FLAC STREAMINFO is missing.');
  }
  return {
    sampleRate: (bytes[18]! << 12) | (bytes[19]! << 4) | (bytes[20]! >> 4),
    channels: ((bytes[20]! >> 1) & 0x07) + 1,
    bitDepth: (((bytes[20]! & 0x01) << 4) | (bytes[21]! >> 4)) + 1,
  };
}
