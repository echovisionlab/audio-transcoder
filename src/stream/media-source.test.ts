import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedCustomSourceOptions {
  readonly read: (start: number, end: number) => Promise<Uint8Array>;
}

const mocks = vi.hoisted(() => ({
  canDecode: vi.fn(),
  canRead: vi.fn(),
  customSourceOptions: [] as CapturedCustomSourceOptions[],
  getChannels: vi.fn(),
  getCodec: vi.fn(),
  getDuration: vi.fn(),
  getFormat: vi.fn(),
  getSampleRate: vi.fn(),
  getTrack: vi.fn(),
  inputOptions: [] as { source: { constructor: { name: string } } }[],
  inputs: [] as { dispose: ReturnType<typeof vi.fn> }[],
  sampleSinks: [] as unknown[],
  samples: vi.fn(),
}));

vi.mock('mediabunny', () => {
  class CustomSource {
    constructor(options: CapturedCustomSourceOptions) {
      mocks.customSourceOptions.push(options);
    }
  }

  class Input {
    readonly dispose = vi.fn();

    constructor(options: { source: { constructor: { name: string } } }) {
      mocks.inputs.push(this);
      mocks.inputOptions.push(options);
    }

    canRead() {
      return mocks.canRead();
    }

    getFormat() {
      return mocks.getFormat();
    }

    getPrimaryAudioTrack() {
      return mocks.getTrack();
    }
  }

  class AudioSampleSink {
    constructor(track: unknown) {
      mocks.sampleSinks.push(track);
    }

    samples() {
      return mocks.samples();
    }
  }

  return {
    ALL_FORMATS: Object.freeze([]),
    AudioSampleSink,
    CustomSource,
    Input,
  };
});

import {
  inspectMediaBlob,
  openMediaBlobSource,
  probeMediaBlobSupport,
} from './media-source.js';
import { AudioTranscoderError } from '../errors.js';

const STREAM_INPUT = {
  blob: new Blob(['media bytes']),
  name: 'source.wav',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.customSourceOptions.length = 0;
  mocks.inputOptions.length = 0;
  mocks.inputs.length = 0;
  mocks.sampleSinks.length = 0;
  mocks.canRead.mockResolvedValue(true);
  mocks.canDecode.mockResolvedValue(true);
  mocks.getChannels.mockResolvedValue(2);
  mocks.getCodec.mockResolvedValue('pcm-s24');
  mocks.getDuration.mockResolvedValue(1);
  mocks.getFormat.mockResolvedValue({ name: 'WAVE' });
  mocks.getSampleRate.mockResolvedValue(48_000);
  mocks.getTrack.mockResolvedValue(createTrack());
  mocks.samples.mockReturnValue(samplesOf());
});

describe('MediaBunny streaming source adapter', () => {
  it('inspects supported PCM metadata and disposes the probe', async () => {
    const inspection = await inspectMediaBlob(STREAM_INPUT, 65_536);

    expect(inspection).toEqual({
      bitDepth: 24,
      channels: 2,
      codec: 'pcm-s24',
      container: 'WAVE',
      decodeSupport: 'built-in',
      durationSeconds: 1,
      notes: [],
      sampleRate: 48_000,
      size: STREAM_INPUT.blob.size,
      sourceEncoding: {
        bitDepth: 24,
        endianness: 'little',
        kind: 'pcm',
        sampleFormat: 'integer',
        signedness: 'signed',
      },
    });
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(mocks.inputOptions[0]?.source).toMatchObject({});
    expect(mocks.inputOptions[0]?.source.constructor.name).toBe('CustomSource');
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'pcm-f32be',
      {
        bitDepth: 32,
        endianness: 'big',
        kind: 'pcm',
        sampleFormat: 'float',
        signedness: 'not-applicable',
      },
    ],
    [
      'pcm-u8',
      {
        bitDepth: 8,
        endianness: 'not-applicable',
        kind: 'pcm',
        sampleFormat: 'integer',
        signedness: 'unsigned',
      },
    ],
  ] as const)('structures MediaBunny codec %s', async (codec, expected) => {
    mocks.getCodec.mockResolvedValue(codec);

    await expect(inspectMediaBlob(STREAM_INPUT, 65_536)).resolves.toMatchObject({
      bitDepth: expected.bitDepth,
      sourceEncoding: expected,
    });
  });

  it.each([
    'aac',
    'ac3',
    'alaw',
    'eac3',
    'mp3',
    'opus',
    'ulaw',
    'vorbis',
  ] as const)('structures lossy MediaBunny codec %s', async (codec) => {
    mocks.getCodec.mockResolvedValue(codec);

    await expect(inspectMediaBlob(STREAM_INPUT, 65_536)).resolves.toMatchObject({
      bitDepth: null,
      sourceEncoding: {
        codec,
        estimatedBitrateBps: null,
        kind: 'lossy-compressed',
      },
    });
  });

  it('structures ALAC as lossless compressed source audio', async () => {
    mocks.getCodec.mockResolvedValue('alac');

    await expect(inspectMediaBlob(STREAM_INPUT, 65_536)).resolves.toMatchObject({
      sourceEncoding: {
        bitDepth: null,
        codec: 'alac',
        kind: 'lossless-compressed',
      },
    });
  });

  it('returns null when no registered demuxer can read the Blob', async () => {
    mocks.canRead.mockResolvedValue(false);

    await expect(inspectMediaBlob(STREAM_INPUT, 65_536)).resolves.toBeNull();
    await expect(
      probeMediaBlobSupport(STREAM_INPUT, 65_536),
    ).resolves.toBeNull();
    await expect(
      openMediaBlobSource(STREAM_INPUT, 65_536, 65_536),
    ).resolves.toBeNull();
    expect(mocks.inputs).toHaveLength(3);
    expect(mocks.inputs.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it('rejects a recognized container without an audio track', async () => {
    mocks.getTrack.mockResolvedValue(null);

    await expect(inspectMediaBlob(STREAM_INPUT, 65_536)).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
      message: expect.stringContaining('audio track'),
    });
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('normalizes unknown codecs and invalid durations', async () => {
    mocks.getCodec.mockResolvedValue(null);
    mocks.getDuration.mockResolvedValue(Number.POSITIVE_INFINITY);

    await expect(inspectMediaBlob(STREAM_INPUT, 65_536)).resolves.toMatchObject({
      bitDepth: null,
      codec: 'Unknown',
      decodeSupport: 'likely-browser',
      durationSeconds: null,
      sourceEncoding: { kind: 'unknown' },
    });
  });

  it('reports browser-dependent decode and rejects opening it', async () => {
    mocks.canDecode.mockResolvedValue(false);
    mocks.getCodec.mockResolvedValue('flac');

    await expect(inspectMediaBlob(STREAM_INPUT, 65_536)).resolves.toMatchObject({
      decodeSupport: 'browser-dependent',
      notes: ['A browser decoder or codec plugin is required.'],
      sourceEncoding: {
        bitDepth: null,
        codec: 'flac',
        kind: 'lossless-compressed',
      },
    });
    await expect(
      openMediaBlobSource(STREAM_INPUT, 65_536, 65_536),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
      message: 'WAVE flac cannot be decoded in this browser.',
    });
    expect(mocks.inputs[1]?.dispose).toHaveBeenCalledOnce();
  });

  it('confirms support by decoding and releasing only the first sample', async () => {
    mocks.getCodec.mockResolvedValue('flac');
    const sample = new SampleStub([0.25, -0.25]);
    const stream = trackedSamples(sample, new SampleStub([1, -1]));
    mocks.samples.mockReturnValue(stream.iterator);

    await expect(
      probeMediaBlobSupport(STREAM_INPUT, 65_536),
    ).resolves.toMatchObject({
      codec: 'flac',
      decodeSupport: 'likely-browser',
      notes: [],
    });
    expect(stream.next).toHaveBeenCalledOnce();
    expect(stream.return).toHaveBeenCalledOnce();
    expect(sample.close).toHaveBeenCalledOnce();
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('confirms support when the decoder iterator has no return method', async () => {
    mocks.getCodec.mockResolvedValue('flac');
    const sample = new SampleStub([0.25, -0.25]);
    mocks.samples.mockReturnValue(samplesWithoutReturn(sample));

    await expect(
      probeMediaBlobSupport(STREAM_INPUT, 65_536),
    ).resolves.toMatchObject({ decodeSupport: 'likely-browser' });
    expect(sample.close).toHaveBeenCalledOnce();
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('reports a first-sample decoder failure as recognized unsupported', async () => {
    mocks.getCodec.mockResolvedValue('flac');
    const failure = new DOMException(
      'InternalAudioDecoderCocoa decoding failed',
      'EncodingError',
    );
    const stream = failingSamples(failure);
    mocks.samples.mockReturnValue(stream.iterator);

    await expect(
      probeMediaBlobSupport(STREAM_INPUT, 65_536),
    ).resolves.toMatchObject({
      decodeSupport: 'browser-dependent',
      notes: ['The browser decoder could not decode the first audio sample.'],
    });
    expect(stream.return).toHaveBeenCalledOnce();
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('rejects probe budget exhaustion and succeeds with enough budget', async () => {
    mocks.getCodec.mockResolvedValue('flac');
    const sample = new SampleStub([0.25, -0.25]);
    mocks.samples.mockImplementation(() => sourceReadingSamples(sample));

    await expect(
      probeMediaBlobSupport(STREAM_INPUT, 4),
    ).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message: 'Media input exceeded the 4-byte cumulative read limit.',
    });
    await expect(
      probeMediaBlobSupport(STREAM_INPUT, 8),
    ).resolves.toMatchObject({
      codec: 'flac',
      decodeSupport: 'likely-browser',
    });
    expect(sample.close).toHaveBeenCalledOnce();
    expect(mocks.inputs).toHaveLength(2);
    expect(mocks.inputs.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it('treats sample and iterator cleanup failures as failed validation', async () => {
    mocks.getCodec.mockResolvedValue('flac');
    const sample = new SampleStub([0, 0]);
    sample.close.mockImplementation(() => {
      throw new Error('sample close failed');
    });
    const stream = trackedSamples(sample);
    stream.return.mockRejectedValue(new Error('iterator return failed'));
    mocks.samples.mockReturnValue(stream.iterator);

    await expect(
      probeMediaBlobSupport(STREAM_INPUT, 65_536),
    ).resolves.toMatchObject({
      decodeSupport: 'browser-dependent',
      notes: ['The browser decoder could not decode the first audio sample.'],
    });
    expect(sample.close).toHaveBeenCalledOnce();
    expect(stream.return).toHaveBeenCalledOnce();
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('preserves a resource-limit failure from iterator cleanup', async () => {
    mocks.getCodec.mockResolvedValue('flac');
    const failure = new AudioTranscoderError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Decoder cleanup exceeded its resource budget.',
    );
    const stream = trackedSamples(new SampleStub([0, 0]));
    stream.return.mockRejectedValue(failure);
    mocks.samples.mockReturnValue(stream.iterator);

    await expect(
      probeMediaBlobSupport(STREAM_INPUT, 65_536),
    ).rejects.toBe(failure);
    expect(stream.return).toHaveBeenCalledOnce();
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('reports an audio track that reaches end before a sample as unsupported', async () => {
    mocks.getCodec.mockResolvedValue('flac');
    const stream = trackedSamples();
    mocks.samples.mockReturnValue(stream.iterator);

    await expect(
      probeMediaBlobSupport(STREAM_INPUT, 65_536),
    ).resolves.toMatchObject({
      decodeSupport: 'browser-dependent',
      notes: ['The audio track did not produce a decodable sample.'],
    });
    expect(stream.return).toHaveBeenCalledOnce();
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('maps abort during first-sample validation and releases the probe', async () => {
    mocks.getCodec.mockResolvedValue('flac');
    const stream = deferredSamples();
    mocks.samples.mockReturnValue(stream.iterator);
    const controller = new AbortController();
    const probing = probeMediaBlobSupport(
      STREAM_INPUT,
      65_536,
      controller.signal,
    );
    await vi.waitFor(() => expect(stream.next).toHaveBeenCalledOnce());

    controller.abort('stop validation');

    await expect(probing).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'stop validation',
    });
    expect(stream.return).toHaveBeenCalledOnce();
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('maps abort while the browser decoder availability check is stalled', async () => {
    mocks.getCodec.mockResolvedValue('flac');
    mocks.canDecode.mockReturnValue(new Promise<boolean>(() => undefined));
    const controller = new AbortController();
    const probing = probeMediaBlobSupport(
      STREAM_INPUT,
      65_536,
      controller.signal,
    );
    await vi.waitFor(() => expect(mocks.canDecode).toHaveBeenCalledOnce());

    controller.abort('decoder probe deadline');

    await expect(probing).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'decoder probe deadline',
    });
    expect(mocks.sampleSinks).toHaveLength(0);
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('uses a fresh MediaBunny Input when opening after validation', async () => {
    const sample = new SampleStub([0, 0]);
    mocks.samples.mockReturnValue(trackedSamples(sample).iterator);

    await probeMediaBlobSupport(STREAM_INPUT, 65_536);
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 65_536);

    expect(mocks.inputs).toHaveLength(2);
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
    expect(mocks.inputs[1]?.dispose).not.toHaveBeenCalled();
    source!.close();
    expect(mocks.inputs[1]?.dispose).toHaveBeenCalledOnce();
  });

  it('does not allocate a sample sink when canDecode rejects the codec', async () => {
    mocks.canDecode.mockResolvedValue(false);

    await expect(
      probeMediaBlobSupport(STREAM_INPUT, 65_536),
    ).resolves.toMatchObject({ decodeSupport: 'browser-dependent' });
    expect(mocks.sampleSinks).toHaveLength(0);
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ['zero channels', 0, 48_000],
    ['fractional channels', 1.5, 48_000],
    ['too many channels', 33, 48_000],
    ['zero sample rate', 2, 0],
    ['fractional sample rate', 2, 44_100.5],
  ] as const)('rejects invalid decoded parameters: %s', async (_label, channels, rate) => {
    mocks.getChannels.mockResolvedValue(channels);
    mocks.getSampleRate.mockResolvedValue(rate);

    await expect(inspectMediaBlob(STREAM_INPUT, 65_536)).rejects.toMatchObject({
      code: 'INVALID_AUDIO_DATA',
    });
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('maps aborts before and during probing', async () => {
    const before = new AbortController();
    before.abort('before probe');
    await expect(
      inspectMediaBlob(STREAM_INPUT, 65_536, before.signal),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'before probe',
    });
    expect(mocks.inputs).toHaveLength(0);

    const during = new AbortController();
    mocks.getFormat.mockImplementation(async () => {
      during.abort('during probe');
      return { name: 'WAVE' };
    });
    await expect(
      inspectMediaBlob(STREAM_INPUT, 65_536, during.signal),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'during probe',
    });
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();

    const beforeMetadata = new AbortController();
    mocks.canRead.mockImplementationOnce(() => {
      beforeMetadata.abort('before metadata');
      return Promise.reject(new Error('late container-recognition failure'));
    });
    await expect(
      inspectMediaBlob(STREAM_INPUT, 65_536, beforeMetadata.signal),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'before metadata',
    });
    expect(mocks.inputs[1]?.dispose).toHaveBeenCalledOnce();
  });

  it.each(['container recognition', 'audio-track lookup'] as const)(
    'maps abort while %s is stalled',
    async (stage) => {
      if (stage === 'container recognition') {
        mocks.canRead.mockReturnValue(new Promise<boolean>(() => undefined));
      } else {
        mocks.getTrack.mockReturnValue(new Promise<never>(() => undefined));
      }
      const controller = new AbortController();
      const inspection = inspectMediaBlob(
        STREAM_INPUT,
        65_536,
        controller.signal,
      );
      await vi.waitFor(() =>
        expect(
          stage === 'container recognition' ? mocks.canRead : mocks.getTrack,
        ).toHaveBeenCalledOnce(),
      );

      controller.abort(`stop ${stage}`);

      await expect(inspection).rejects.toMatchObject({
        code: 'OPERATION_ABORTED',
        message: `stop ${stage}`,
      });
      expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
    },
  );

  it('rethrows ordinary probe failures after disposal', async () => {
    const failure = new TypeError('metadata failed');
    mocks.getCodec.mockRejectedValue(failure);
    const controller = new AbortController();

    await expect(
      inspectMediaBlob(STREAM_INPUT, 65_536, controller.signal),
    ).rejects.toBe(failure);
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('streams interleaved samples and closes every resource once', async () => {
    const first = new SampleStub([0.25, -0.25, 0.5, -0.5]);
    const second = new SampleStub([1, -1]);
    mocks.samples.mockReturnValue(samplesOf(first, second));
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 65_536);
    const chunks = await collect(source!.chunks());

    expect(source).toMatchObject({
      channels: 2,
      durationSeconds: 1,
      sampleRate: 48_000,
      totalFrames: null,
    });
    expect(chunks.map((chunk) => [...chunk])).toEqual([
      [0.25, -0.25, 0.5, -0.5],
      [1, -1],
    ]);
    expect(first.copyTo).toHaveBeenCalledWith(expect.any(Float32Array), {
      format: 'f32',
      frameCount: 2,
      frameOffset: 0,
      planeIndex: 0,
    });
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    source!.close();
    source!.close();
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('streams from a decoder iterator without a return method', async () => {
    const sample = new SampleStub([0.25, -0.25]);
    mocks.samples.mockReturnValue(samplesWithoutReturn(sample));
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 65_536);

    await expect(collect(source!.chunks())).resolves.toEqual([
      new Float32Array([0.25, -0.25]),
    ]);
    expect(sample.close).toHaveBeenCalledOnce();
    source!.close();
  });

  it.each([0, 1.5] as const)(
    'rejects an invalid PCM chunk bound before opening input: %s',
    async (pcmChunkBytes) => {
      await expect(
        openMediaBlobSource(STREAM_INPUT, 65_536, pcmChunkBytes),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
      expect(mocks.inputs).toHaveLength(0);
    },
  );

  it('splits one native sample into bounded interleaved chunks', async () => {
    const sample = new SampleStub([
      0.125, -0.125, 0.25, -0.25, 0.375, -0.375, 0.5, -0.5, 0.625,
      -0.625,
    ]);
    mocks.samples.mockReturnValue(samplesOf(sample));
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 20);

    const chunks = await collect(source!.chunks());

    expect(chunks.every((chunk) => chunk.byteLength <= 20)).toBe(true);
    expect(chunks.map((chunk) => [...chunk])).toEqual([
      [0.125, -0.125, 0.25, -0.25],
      [0.375, -0.375, 0.5, -0.5],
      [0.625, -0.625],
    ]);
    expect(sample.copyTo.mock.calls.map(([, options]) => options)).toEqual([
      { format: 'f32', frameCount: 2, frameOffset: 0, planeIndex: 0 },
      { format: 'f32', frameCount: 2, frameOffset: 2, planeIndex: 0 },
      { format: 'f32', frameCount: 1, frameOffset: 4, planeIndex: 0 },
    ]);
    expect(sample.close).toHaveBeenCalledOnce();
    source!.close();
  });

  it('rejects a PCM limit that cannot hold one complete frame', async () => {
    const sample = new SampleStub([0, 0]);
    mocks.samples.mockReturnValue(samplesOf(sample));
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 7);

    await expect(collect(source!.chunks())).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: expect.stringContaining('at least 8 bytes'),
    });
    expect(sample.copyTo).not.toHaveBeenCalled();
    expect(sample.close).toHaveBeenCalledOnce();
    source!.close();
  });

  it.each([-1, 1.5] as const)(
    'rejects an invalid decoded frame count and closes the sample: %s',
    async (frames) => {
      const sample = new SampleStub([], { frames });
      mocks.samples.mockReturnValue(samplesOf(sample));
      const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 8);

      await expect(collect(source!.chunks())).rejects.toMatchObject({
        code: 'INVALID_AUDIO_DATA',
        message: expect.stringContaining('frame count'),
      });
      expect(sample.close).toHaveBeenCalledOnce();
      source!.close();
    },
  );

  it('rejects decoder end before the first sample as unsupported input', async () => {
    mocks.samples.mockReturnValue(samplesOf());
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 8);

    await expect(collect(source!.chunks())).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
      message:
        'WAVE pcm-s24 did not produce a decoded audio sample in this browser.',
    });
    source!.close();
  });

  it('closes an empty native sample without copying', async () => {
    const sample = new SampleStub([]);
    mocks.samples.mockReturnValue(samplesOf(sample));
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 8);

    await expect(collect(source!.chunks())).resolves.toEqual([]);
    expect(sample.copyTo).not.toHaveBeenCalled();
    expect(sample.close).toHaveBeenCalledOnce();
    source!.close();
  });

  it('keeps a native sample open only until consumer cancellation', async () => {
    const sample = new SampleStub([0, 0, 1, -1]);
    mocks.samples.mockReturnValue(samplesOf(sample));
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 8);
    const iterator = source!.chunks()[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    expect(sample.close).not.toHaveBeenCalled();
    await iterator.return?.();
    expect(sample.close).toHaveBeenCalledOnce();
    source!.close();
  });

  it('closes the active sample and input when aborted between slices', async () => {
    const sample = new SampleStub([0, 0, 1, -1]);
    mocks.samples.mockReturnValue(samplesOf(sample));
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 8);
    const controller = new AbortController();
    const iterator = source!.chunks(controller.signal)[Symbol.asyncIterator]();
    await iterator.next();

    controller.abort('stop between slices');
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'stop between slices',
    });
    expect(sample.close).toHaveBeenCalledOnce();
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
    source!.close();
  });

  it.each([
    ['channels', { channels: 1, sampleRate: 48_000 }],
    ['sample rate', { channels: 2, sampleRate: 44_100 }],
  ] as const)('rejects samples whose %s changes', async (_label, parameters) => {
    const sample = new SampleStub([0, 0], parameters);
    mocks.samples.mockReturnValue(samplesOf(sample));
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 65_536);

    await expect(collect(source!.chunks())).rejects.toMatchObject({
      code: 'INVALID_AUDIO_DATA',
      message: expect.stringContaining('changed'),
    });
    expect(sample.close).toHaveBeenCalledOnce();
    source!.close();
  });

  it('closes a sample when copying it fails', async () => {
    const failure = new Error('copy failed');
    const sample = new SampleStub([0, 0]);
    sample.copyTo.mockImplementation(() => {
      throw failure;
    });
    mocks.samples.mockReturnValue(samplesOf(sample));
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 65_536);

    await expect(collect(source!.chunks())).rejects.toBe(failure);
    expect(sample.close).toHaveBeenCalledOnce();
    source!.close();
  });

  it('rethrows ordinary decoder iterator failures', async () => {
    const failure = new Error('decoder failed');
    mocks.samples.mockReturnValue(throwingSamples(failure));
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 65_536);

    await expect(collect(source!.chunks())).rejects.toBe(failure);
    source!.close();
  });

  it('normalizes a first decoder EncodingError as unsupported input', async () => {
    const failure = new DOMException(
      'InternalAudioDecoderCocoa decoding failed',
      'EncodingError',
    );
    mocks.samples.mockReturnValue(throwingSamples(failure));
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 65_536);

    await expect(collect(source!.chunks())).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
      message: expect.stringContaining('first audio sample'),
    });
    source!.close();
  });

  it('preserves an EncodingError after the decoder produced a sample', async () => {
    const sample = new SampleStub([0, 0]);
    const failure = new DOMException('malformed later packet', 'EncodingError');
    mocks.samples.mockReturnValue(sampleThenThrow(sample, failure));
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 65_536);

    await expect(collect(source!.chunks())).rejects.toBe(failure);
    expect(sample.close).toHaveBeenCalledOnce();
    source!.close();
  });

  it('settles a stalled decoder iterator on abort', async () => {
    mocks.samples.mockReturnValue(
      waitingSamples(new Promise<void>(() => undefined)),
    );
    const source = await openMediaBlobSource(STREAM_INPUT, 65_536, 65_536);
    const controller = new AbortController();
    const chunks = collect(source!.chunks(controller.signal));
    await Promise.resolve();

    controller.abort('stop decode');
    await expect(chunks).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'stop decode',
    });
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
    source!.close();
    expect(mocks.inputs[0]?.dispose).toHaveBeenCalledOnce();
  });
});

function createTrack() {
  return {
    canDecode: () => mocks.canDecode(),
    getCodec: () => mocks.getCodec(),
    getDurationFromMetadata: () => mocks.getDuration(),
    getNumberOfChannels: () => mocks.getChannels(),
    getSampleRate: () => mocks.getSampleRate(),
  };
}

class SampleStub {
  readonly close = vi.fn();
  readonly copyTo = vi.fn(
    (
      target: Float32Array,
      options: {
        readonly frameCount: number;
        readonly frameOffset: number;
      },
    ) => {
      const start = options.frameOffset * this.numberOfChannels;
      const end =
        start + options.frameCount * this.numberOfChannels;
      target.set(this.values.slice(start, end));
    },
  );
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly sampleRate: number;

  constructor(
    private readonly values: readonly number[],
    parameters: {
      readonly channels?: number;
      readonly frames?: number;
      readonly sampleRate?: number;
    } = {},
  ) {
    this.numberOfChannels = parameters.channels ?? 2;
    this.numberOfFrames =
      parameters.frames ?? values.length / this.numberOfChannels;
    this.sampleRate = parameters.sampleRate ?? 48_000;
  }
}

async function* samplesOf(...samples: SampleStub[]) {
  for (const sample of samples) {
    yield sample;
  }
}

function samplesWithoutReturn(sample: SampleStub) {
  let consumed = false;
  return {
    async next(): Promise<IteratorResult<SampleStub, void>> {
      if (consumed) {
        return { done: true, value: undefined };
      }
      consumed = true;
      return { done: false, value: sample };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

async function* throwingSamples(error: Error) {
  throw error;
  yield new SampleStub([]);
}

async function* sampleThenThrow(sample: SampleStub, error: Error) {
  yield sample;
  throw error;
}

async function* sourceReadingSamples(sample: SampleStub) {
  const source = currentCustomSourceOptions();
  await source.read(0, 3);
  await source.read(3, 6);
  yield sample;
}

async function* waitingSamples(waiting: Promise<void>) {
  await waiting;
  throw new Error('disposed decoder');
  yield new SampleStub([]);
}

function trackedSamples(...samples: SampleStub[]) {
  let index = 0;
  const next = vi.fn(async (): Promise<IteratorResult<SampleStub, void>> => {
    const sample = samples[index++];
    return sample === undefined
      ? { done: true, value: undefined }
      : { done: false, value: sample };
  });
  const returnIterator = vi.fn(
    async (): Promise<IteratorResult<SampleStub, void>> => ({
      done: true,
      value: undefined,
    }),
  );
  const iterator = {
    next,
    return: returnIterator,
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return { iterator, next, return: returnIterator };
}

function failingSamples(error: Error) {
  const next = vi.fn(async (): Promise<IteratorResult<SampleStub, void>> => {
    throw error;
  });
  const returnIterator = vi.fn(
    async (): Promise<IteratorResult<SampleStub, void>> => ({
      done: true,
      value: undefined,
    }),
  );
  const iterator = {
    next,
    return: returnIterator,
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return { iterator, next, return: returnIterator };
}

function deferredSamples() {
  const next = vi.fn(
    () =>
      new Promise<IteratorResult<SampleStub, void>>(() => undefined),
  );
  const returnIterator = vi.fn(
    async (): Promise<IteratorResult<SampleStub, void>> => ({
      done: true,
      value: undefined,
    }),
  );
  const iterator = {
    next,
    return: returnIterator,
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return {
    iterator,
    next,
    return: returnIterator,
  };
}

function currentCustomSourceOptions(): CapturedCustomSourceOptions {
  const options = mocks.customSourceOptions.at(-1);
  if (options === undefined) {
    throw new Error('Expected captured CustomSource options.');
  }
  return options;
}

async function collect(
  chunks: AsyncIterable<Float32Array>,
): Promise<Float32Array[]> {
  const result: Float32Array[] = [];
  for await (const chunk of chunks) {
    result.push(chunk);
  }
  return result;
}
