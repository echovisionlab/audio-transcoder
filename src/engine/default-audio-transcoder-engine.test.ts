import { describe, expect, it, vi } from 'vitest';
import { CodecRegistry } from '../codecs/codec-registry.js';
import type { AudioDecoderAdapter } from '../codecs/contracts.js';
import type {
  AudioInput,
  DecodedAudio,
  EncodedAudio,
  PcmAudio,
} from './contracts.js';
import { AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES } from './buffer-policy.js';
import { DefaultAudioTranscoderEngine } from './default-audio-transcoder-engine.js';

const PRESET = {
  bitDepth: 16,
  container: 'test',
  extension: 'test',
  id: 'test',
  mimeType: 'audio/test',
  sampleFormat: 'integer' as const,
};
const DECODED: DecodedAudio = {
  channelData: [new Float32Array(1)],
  durationSeconds: 1,
  sampleRate: 1,
  source: 'test',
};
const ENCODED: EncodedAudio = { data: new ArrayBuffer(1), preset: PRESET };
const OVERSIZED_DECODE_ESTIMATE = {
  channels: 1,
  frames:
    AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES /
      Float32Array.BYTES_PER_ELEMENT +
    1,
};

describe('DefaultAudioTranscoderEngine whole-buffer policy', () => {
  it.each(['decode', 'transcode'] as const)(
    'rejects oversized %s input before invoking a decoder',
    async (operation) => {
      const harness = createHarness();
      const input = oversizedInput();
      const result =
        operation === 'decode'
          ? harness.engine.decode(input)
          : harness.engine.transcode(input, PRESET.id);

      await expect(result).rejects.toMatchObject({
        code: 'RESOURCE_LIMIT_EXCEEDED',
      });
      expect(harness.decode).not.toHaveBeenCalled();
      expect(harness.encode).not.toHaveBeenCalled();
    },
  );

  it('rejects oversized PCM before invoking an encoder', async () => {
    const harness = createHarness();

    await expect(harness.engine.encode(oversizedPcm(), PRESET.id)).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
    });
    expect(harness.encode).not.toHaveBeenCalled();
  });

  it.each(['decode', 'transcode'] as const)(
    'rejects an oversized %s estimate before invoking the decoder',
    async (operation) => {
      const estimateDecodedPcm = vi.fn(() => OVERSIZED_DECODE_ESTIMATE);
      const harness = createHarness(DECODED, estimateDecodedPcm);
      const onProgress = vi.fn();
      const result =
        operation === 'decode'
          ? harness.engine.decode({ data: new ArrayBuffer(1) }, { onProgress })
          : harness.engine.transcode(
              { data: new ArrayBuffer(1) },
              PRESET.id,
              { onProgress },
            );

      await expect(result).rejects.toMatchObject({
        code: 'RESOURCE_LIMIT_EXCEEDED',
      });
      expect(estimateDecodedPcm).toHaveBeenCalledOnce();
      expect(harness.decode).not.toHaveBeenCalled();
      expect(harness.encode).not.toHaveBeenCalled();
      expect(onProgress.mock.calls.map(([event]) => event.progress)).toEqual([
        0,
      ]);
    },
  );

  it('checks decoded PCM before the transcode encode phase', async () => {
    const harness = createHarness({
      ...DECODED,
      channelData: oversizedPcm().channelData,
    });
    const onProgress = vi.fn();

    await expect(
      harness.engine.transcode(
        { data: new ArrayBuffer(1) },
        PRESET.id,
        { onProgress },
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    expect(harness.decode).toHaveBeenCalledOnce();
    expect(harness.encode).not.toHaveBeenCalled();
    expect(onProgress.mock.calls.map(([event]) => event.progress)).toEqual([0]);
  });

  it('rejects oversized decoded PCM before completing decode progress', async () => {
    const harness = createHarness({
      ...DECODED,
      channelData: oversizedPcm().channelData,
    });
    const onProgress = vi.fn();

    await expect(
      harness.engine.decode(
        { data: new ArrayBuffer(1) },
        { onProgress },
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    expect(harness.decode).toHaveBeenCalledOnce();
    expect(harness.encode).not.toHaveBeenCalled();
    expect(onProgress.mock.calls.map(([event]) => event.progress)).toEqual([0]);
  });

  it('passes explicit unsafe opt-ins through decode, encode, and transcode', async () => {
    const decoded = {
      ...DECODED,
      channelData: oversizedPcm().channelData,
    };
    const harness = createHarness(
      decoded,
      () => OVERSIZED_DECODE_ESTIMATE,
    );
    const options = { unsafeAllowLargeBuffers: true } as const;

    await expect(harness.engine.decode(oversizedInput(), options)).resolves.toEqual(
      decoded,
    );
    await expect(
      harness.engine.encode(oversizedPcm(), PRESET.id, options),
    ).resolves.toEqual(ENCODED);
    await expect(
      harness.engine.transcode(oversizedInput(), PRESET.id, options),
    ).resolves.toEqual(ENCODED);
    expect(harness.decode).toHaveBeenCalledTimes(2);
    expect(harness.encode).toHaveBeenCalledTimes(2);
  });
});

function createHarness(
  decoded: DecodedAudio = DECODED,
  estimateDecodedPcm?: AudioDecoderAdapter['estimateDecodedPcm'],
) {
  const decode = vi.fn(async () => decoded);
  const encode = vi.fn(async () => ENCODED);
  const decoder: AudioDecoderAdapter = {
    decode,
    formats: ['test'],
    id: 'test-decoder',
    ...(estimateDecodedPcm === undefined ? {} : { estimateDecodedPcm }),
  };
  const registry = new CodecRegistry({
    decoders: [decoder],
    encoders: [{ encode, id: 'test-encoder', presets: [PRESET] }],
    inspectors: [],
  });

  return {
    decode,
    encode,
    engine: new DefaultAudioTranscoderEngine(
      { name: 'test', version: '0.0.0' },
      registry,
    ),
  };
}

function oversizedInput(): AudioInput {
  return {
    data: fakeArrayBuffer(AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES + 1),
  };
}

function oversizedPcm(): PcmAudio {
  return {
    channelData: [
      { buffer: fakeArrayBuffer(AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES + 1) } as Float32Array,
    ],
    sampleRate: 48_000,
  };
}

function fakeArrayBuffer(byteLength: number): ArrayBuffer {
  return { byteLength } as ArrayBuffer;
}
