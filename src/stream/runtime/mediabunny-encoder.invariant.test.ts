import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  descriptor: undefined as Record<string, unknown> | undefined,
  supported: true,
}));

vi.mock('../../codecs/stream-output-presets.js', () => ({
  findStreamOutputPresetDescriptor: () => mocks.descriptor,
  isStreamOutputConfigurationSupported: () => mocks.supported,
}));

vi.mock('mediabunny', () => ({
  AdtsOutputFormat: class {},
  AudioSample: class {},
  AudioSampleSource: class {},
  FlacOutputFormat: class {},
  Mp3OutputFormat: class {},
  Output: class {},
  StreamTarget: class {},
  WavOutputFormat: class {},
}));

vi.mock('./aiff-stream-encoder.js', () => ({
  createAiffStreamEncoder: vi.fn(),
}));
vi.mock('./ogg-opus-stream-encoder.js', () => ({
  createOggOpusStreamEncoder: vi.fn(),
}));

import { createMediaBunnyStreamEncoderAdapter } from './mediabunny-encoder.js';

beforeEach(() => {
  mocks.supported = true;
});

describe('MediaBunny adapter manifest invariants', () => {
  it.each([
    ['a lossy AIFF descriptor', descriptor('aiff', 'lossy', 16, null)],
    ['an unsupported AIFF bit depth', descriptor('aiff', 'lossless', 32, null)],
  ])('rejects %s before constructing a writer', async (_name, invalid) => {
    mocks.descriptor = invalid;
    const adapter = createMediaBunnyStreamEncoderAdapter(vi.fn());

    await expect(adapter.create(configuration())).rejects.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      message: expect.stringContaining('AIFF stream writer'),
    });
  });

  it('rejects a non-lossy Ogg Opus descriptor before loading its writer', async () => {
    mocks.descriptor = descriptor('ogg', 'lossless', 24, 'ogg-opus');
    const adapter = createMediaBunnyStreamEncoderAdapter(vi.fn());

    await expect(adapter.create(configuration())).rejects.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      message: expect.stringContaining('Ogg Opus stream writer'),
    });
  });

  it('requires an explicit Ogg Opus raw-WASM factory', async () => {
    mocks.descriptor = descriptor('ogg', 'lossy', 0, 'ogg-opus');
    const adapter = createMediaBunnyStreamEncoderAdapter(vi.fn());

    await expect(adapter.create(configuration())).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: expect.stringContaining('explicit raw-WASM factory'),
    });
  });

  it('rejects a MediaBunny-routed descriptor without encoder configuration', async () => {
    mocks.descriptor = descriptor('wav', 'lossless', 16, null);
    const adapter = createMediaBunnyStreamEncoderAdapter(vi.fn());

    await expect(adapter.create(configuration())).rejects.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      message: expect.stringContaining('built-in stream writer'),
    });
  });
});

function descriptor(
  format: 'aiff' | 'ogg' | 'wav',
  kind: 'lossless' | 'lossy',
  bitDepth: number,
  wasmCodec: 'ogg-opus' | null,
): Record<string, unknown> {
  return {
    bitDepth,
    bitrate: 128_000,
    constraints: {
      channels: { maximum: 2, minimum: 1 },
      sampleRate: { kind: 'range', maximum: 192_000, minimum: 8_000 },
    },
    encoding: null,
    format,
    kind,
    preset: { id: 'malformed-preset' },
    wasmCodec,
  };
}

function configuration() {
  return {
    channels: 2,
    outputChunkBytes: 64 * 1024,
    preset: {
      bitDepth: 16,
      container: 'wav',
      extension: 'wav',
      id: 'malformed-preset',
      mimeType: 'audio/wav',
      sampleFormat: 'integer' as const,
    },
    rf64: false,
    sampleRate: 48_000,
    writable: new WritableStream(),
  };
}
