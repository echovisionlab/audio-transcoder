import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AudioProgress,
  CreateAudioTranscoderWorkerEngineOptions,
  DecodedAudio,
  EncodedAudio,
} from '../engine/contracts.js';
import { AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES } from '../engine/buffer-policy.js';
import { AUDIO_TRANSCODER_VERSION } from '../package-metadata.js';
import { createAudioTranscoderWorkerEngine } from './client.js';
import type { AudioWorkerRequest, AudioWorkerResponse } from './protocol.js';

const PRESET = {
  bitDepth: 16,
  container: 'wav',
  extension: 'wav',
  id: 'wav-pcm16',
  mimeType: 'audio/wav',
  sampleFormat: 'integer' as const,
};
const DECODED: DecodedAudio = {
  channelData: [new Float32Array([0.25])],
  durationSeconds: 1,
  sampleRate: 1,
  source: 'worker',
};
const ENCODED: EncodedAudio = { data: new ArrayBuffer(1), preset: PRESET };
const PROGRESS: AudioProgress = {
  completedFrames: 1,
  operation: 'decode',
  phase: 'decode',
  progress: 0.5,
  totalFrames: 2,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('audio worker client', () => {
  it('keeps metadata and inspection local while decoding in the worker', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const inputData = new Uint8Array([1, 2, 3]).buffer;
    const progress = vi.fn();
    const result = engine.decode(
      { data: inputData, name: 'unknown.bin' },
      { onProgress: progress },
    );
    const request = worker.posts[0];

    expect(engine.getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
    expect(engine.getInfo().version).toBe(AUDIO_TRANSCODER_VERSION);
    expect(engine.getCapabilities().decode).toContain('wav');
    expect(engine.inspect({ data: inputData }).container).toBe('Unknown');
    expect(request?.message).toMatchObject({ id: 1, type: 'decode' });
    const requestedInput = request?.message as Extract<
      AudioWorkerRequest,
      { type: 'decode' }
    >;
    expect(requestedInput.input.data).not.toBe(inputData);
    expect(new Uint8Array(requestedInput.input.data)).toEqual(
      new Uint8Array(inputData),
    );
    expect(request?.transfer).toEqual([requestedInput.input.data]);

    worker.emitMessage({ id: 999, operation: 'decode', type: 'result', value: DECODED });
    worker.emitMessage({ id: 1, progress: PROGRESS, type: 'progress' });
    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });

    const decoded = await result;
    const progressEvent = progress.mock.calls[0]?.[0] as AudioProgress;
    expect(decoded).toEqual(DECODED);
    expect(decoded).not.toBe(DECODED);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.channelData)).toBe(true);
    expect(progressEvent).toEqual(PROGRESS);
    expect(Object.isFrozen(progressEvent)).toBe(true);
  });

  it('encodes copied PCM channels and transcodes copied input buffers', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const channel = new Float32Array([0, 1]);
    const encodeResult = engine.encode(
      { channelData: [channel], sampleRate: 48_000 },
      PRESET.id,
    );
    const encodeRequest = worker.posts[0]?.message as Extract<
      AudioWorkerRequest,
      { type: 'encode' }
    >;

    expect(encodeRequest.audio.channelData[0]).not.toBe(channel);
    expect(encodeRequest.audio.channelData[0]).toEqual(channel);
    expect(worker.posts[0]?.transfer).toEqual([
      encodeRequest.audio.channelData[0]?.buffer,
    ]);
    worker.emitMessage({ id: 1, operation: 'encode', type: 'result', value: ENCODED });
    const encoded = await encodeResult;
    expect(encoded).toEqual(ENCODED);
    expect(encoded).not.toBe(ENCODED);
    expect(Object.isFrozen(encoded)).toBe(true);
    expect(Object.isFrozen(encoded.preset)).toBe(true);

    const inputData = new ArrayBuffer(2);
    const transcodeResult = engine.transcode(
      { data: inputData },
      PRESET.id,
    );
    const transcodeRequest = worker.posts[1]?.message as Extract<
      AudioWorkerRequest,
      { type: 'transcode' }
    >;
    expect(transcodeRequest.input.data).not.toBe(inputData);
    worker.emitMessage({
      id: 2,
      operation: 'transcode',
      type: 'result',
      value: ENCODED,
    });
    await expect(transcodeResult).resolves.toEqual(ENCODED);
  });

  it.each(['decode', 'transcode'] as const)(
    'rejects oversized %s input before copying or posting it',
    async (operation) => {
      const worker = new WorkerStub();
      const engine = createEngine(worker);
      const data = new ArrayBuffer(
        AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES + 1,
      );
      const slice = vi.spyOn(data, 'slice');
      const result =
        operation === 'decode'
          ? engine.decode({ data })
          : engine.transcode({ data }, PRESET.id);

      await expect(result).rejects.toMatchObject({
        code: 'RESOURCE_LIMIT_EXCEEDED',
      });
      expect(slice).not.toHaveBeenCalled();
      expect(worker.posts).toHaveLength(0);
    },
  );

  it('rejects oversized PCM before copying or posting channels', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const channel = new Float32Array(
      new ArrayBuffer(AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES + 4),
    );
    const slice = vi.spyOn(channel, 'slice');

    await expect(
      engine.encode({ channelData: [channel], sampleRate: 1 }, PRESET.id),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    expect(slice).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(0);
  });

  it('rejects shared-view PCM copy amplification before slicing or posting', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const viewBytes = 40 * 1024 * 1024;
    const buffer = fakeBuffer(viewBytes);
    const first = fakeChannel(buffer, viewBytes);
    const second = fakeChannel(buffer, viewBytes);

    await expect(
      engine.encode(
        { channelData: [first.channel, second.channel], sampleRate: 1 },
        PRESET.id,
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    expect(first.slice).not.toHaveBeenCalled();
    expect(second.slice).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(0);
  });

  it('rejects transfer and shared-buffer copy amplification before preparing PCM', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const transferableBytes = 32 * 1024 * 1024;
    const sharedViewBytes = 20 * 1024 * 1024;
    const transferable = fakeTransferableBuffer(transferableBytes);
    const shared = fakeBuffer(sharedViewBytes);
    const transferredFirst = fakeChannel(transferable, 4);
    const transferredSecond = fakeChannel(transferable, 4);
    const copiedFirst = fakeChannel(shared, sharedViewBytes);
    const copiedSecond = fakeChannel(shared, sharedViewBytes);

    await expect(
      engine.encode(
        {
          channelData: [
            transferredFirst.channel,
            transferredSecond.channel,
            copiedFirst.channel,
            copiedSecond.channel,
          ],
          sampleRate: 1,
        },
        PRESET.id,
        { transferInput: true },
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    expect(copiedFirst.slice).not.toHaveBeenCalled();
    expect(copiedSecond.slice).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(0);
  });

  it('allows the exact boundary and serializes the explicit unsafe opt-in', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const boundaryData = new ArrayBuffer(
      AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES,
    );
    const boundaryResult = engine.decode(
      { data: boundaryData },
      { transferInput: true },
    );

    expect(worker.posts[0]?.message).not.toHaveProperty(
      'unsafeAllowLargeBuffers',
    );
    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
    await boundaryResult;

    const oversizedData = new ArrayBuffer(
      AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES + 1,
    );
    const unsafeResult = engine.transcode(
      { data: oversizedData },
      PRESET.id,
      { transferInput: true, unsafeAllowLargeBuffers: true },
    );
    expect(worker.posts[1]?.message).toMatchObject({
      id: 2,
      type: 'transcode',
      unsafeAllowLargeBuffers: true,
    });
    worker.emitMessage({ id: 2, operation: 'transcode', type: 'result', value: ENCODED });
    await unsafeResult;
  });

  it('snapshots queued input and options while preserving content mutations', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const first = engine.decode({ data: new ArrayBuffer(1) });
    const queuedData = new Uint8Array([1]).buffer;
    const replacementData = new Uint8Array([7]).buffer;
    const input = { data: queuedData, name: 'original.raw' };
    const operationOptions: {
      transferInput?: boolean;
      unsafeAllowLargeBuffers?: boolean;
    } = { transferInput: false };
    const second = engine.transcode(input, PRESET.id, operationOptions);

    expect(worker.posts).toHaveLength(1);
    new Uint8Array(queuedData)[0] = 9;
    input.data = replacementData;
    input.name = 'replacement.raw';
    operationOptions.transferInput = true;
    operationOptions.unsafeAllowLargeBuffers = true;
    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
    await first;

    expect(worker.posts).toHaveLength(2);
    const request = worker.posts[1]?.message as Extract<
      AudioWorkerRequest,
      { type: 'transcode' }
    >;
    expect(new Uint8Array(request.input.data)).toEqual(new Uint8Array([9]));
    expect(request.input.data).not.toBe(queuedData);
    expect(request.input.name).toBe('original.raw');
    expect(request).not.toHaveProperty('unsafeAllowLargeBuffers');
    worker.emitMessage({ id: 2, operation: 'transcode', type: 'result', value: ENCODED });
    await second;
  });

  it('snapshots queued PCM structure while preserving channel content mutations', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const first = engine.decode({ data: new ArrayBuffer(1) });
    const original = new Float32Array([1]);
    const replacement = new Float32Array([7]);
    const channelData = [original];
    const audio = { channelData, sampleRate: 48_000 };
    const operationOptions: { transferInput?: boolean } = {
      transferInput: false,
    };
    const second = engine.encode(audio, PRESET.id, operationOptions);

    original[0] = 9;
    channelData[0] = replacement;
    audio.channelData = [replacement];
    audio.sampleRate = 96_000;
    operationOptions.transferInput = true;
    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
    await first;

    const request = worker.posts[1]?.message as Extract<
      AudioWorkerRequest,
      { type: 'encode' }
    >;
    expect(request.audio.sampleRate).toBe(48_000);
    expect(request.audio.channelData[0]).not.toBe(original);
    expect(request.audio.channelData[0]).toEqual(new Float32Array([9]));
    expect(worker.posts[1]?.transfer).toEqual([
      request.audio.channelData[0]?.buffer,
    ]);
    worker.emitMessage({ id: 2, operation: 'encode', type: 'result', value: ENCODED });
    await second;
  });

  it('rechecks a queued length-tracking PCM snapshot after its backing grows', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const first = engine.decode({ data: new ArrayBuffer(1) });
    const backing = fakeBuffer(20 * 1024 * 1024);
    const firstChannel = fakeLengthTrackingChannel(backing);
    const secondChannel = fakeLengthTrackingChannel(backing);
    const queued = engine.encode(
      {
        channelData: [firstChannel.channel, secondChannel.channel],
        sampleRate: 1,
      },
      PRESET.id,
    );
    const rejection = expect(queued).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
    });

    backing.byteLength = 40 * 1024 * 1024;
    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
    await first;
    await rejection;

    expect(firstChannel.slice).not.toHaveBeenCalled();
    expect(secondChannel.slice).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(1);
  });

  it('cancels queued calls without preparing or posting their buffers', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const first = engine.decode({ data: new ArrayBuffer(1) });
    const controller = new AbortController();
    const slice = vi.spyOn(ArrayBuffer.prototype, 'slice');
    const queued = engine.transcode(
      { data: new ArrayBuffer(1) },
      PRESET.id,
      { signal: controller.signal },
    );

    controller.abort('remove queued');
    await expect(queued).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'remove queued',
    });
    expect(slice).not.toHaveBeenCalled();
    slice.mockRestore();
    expect(worker.posts).toHaveLength(1);
    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
    await first;
  });

  it('bounds the default queue at eight operations behind the active one', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const active = engine.decode({ data: new ArrayBuffer(1) });
    const queued = Array.from({ length: 8 }, () =>
      engine.decode({ data: new ArrayBuffer(1) }),
    );

    await expect(
      engine.decode({ data: new ArrayBuffer(1) }),
    ).rejects.toMatchObject({
      code: 'QUEUE_CAPACITY_EXCEEDED',
      message:
        'Audio transcoder Worker queue is full (maxQueued: 8; active operation excluded).',
    });
    expect(worker.posts).toHaveLength(1);

    engine.terminate();
    await Promise.allSettled([active, ...queued]);
  });

  it('enforces the aggregate waiting-byte budget while excluding active input', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, { maxQueuedBytes: 3 });
    const active = engine.decode({ data: new ArrayBuffer(16) });
    const queued = engine.decode({ data: new ArrayBuffer(2) });
    const rejectedSignal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(
      engine.transcode(
        { data: new ArrayBuffer(2) },
        PRESET.id,
        { signal: rejectedSignal, unsafeAllowLargeBuffers: true },
      ),
    ).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message:
        'Audio transcoder Worker waiting queue exceeds maxQueuedBytes (3 bytes; queued: 2 bytes; requested: 2 bytes; active operation excluded).',
    });
    expect(rejectedSignal.addEventListener).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(1);

    engine.terminate();
    await Promise.allSettled([active, queued]);
  });

  it('releases a byte reservation on dequeue so the budget can be reused', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, { maxQueuedBytes: 2 });
    const active = engine.decode({ data: new ArrayBuffer(8) });
    const queued = engine.decode({ data: new ArrayBuffer(2) });

    await expect(
      engine.decode({ data: new ArrayBuffer(1) }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });

    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
    await active;
    const replacement = engine.decode({ data: new ArrayBuffer(2) });
    expect(worker.posts[1]?.message).toMatchObject({ id: 2, type: 'decode' });

    worker.emitMessage({ id: 2, operation: 'decode', type: 'result', value: DECODED });
    await queued;
    expect(worker.posts[2]?.message).toMatchObject({ id: 3, type: 'decode' });
    worker.emitMessage({ id: 3, operation: 'decode', type: 'result', value: DECODED });
    await replacement;
    engine.terminate();
  });

  it('releases queued bytes when abort listener registration throws', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, { maxQueuedBytes: 1 });
    const active = engine.decode({ data: new ArrayBuffer(1) });
    const failure = new Error('listener registration failed');
    const signal = {
      aborted: false,
      addEventListener(): never {
        throw failure;
      },
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(
      engine.decode({ data: new ArrayBuffer(1) }, { signal }),
    ).rejects.toBe(failure);
    const replacement = engine.decode({ data: new ArrayBuffer(1) });
    expect(worker.posts).toHaveLength(1);

    engine.terminate();
    await Promise.allSettled([active, replacement]);
  });

  it('charges a shared PCM backing buffer once at its full byte length', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, { maxQueuedBytes: 16 });
    const active = engine.decode({ data: new ArrayBuffer(1) });
    const backing = new ArrayBuffer(16);
    const queued = engine.encode(
      {
        channelData: [
          new Float32Array(backing, 0, 1),
          new Float32Array(backing, 4, 1),
        ],
        sampleRate: 1,
      },
      PRESET.id,
    );

    await expect(
      engine.decode({ data: new ArrayBuffer(1) }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });

    engine.terminate();
    await Promise.allSettled([active, queued]);
  });

  it('uses overflow-safe arithmetic at the safe-integer byte boundary', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, {
      maxQueuedBytes: Number.MAX_SAFE_INTEGER,
    });
    const active = engine.decode({ data: new ArrayBuffer(1) });
    const queued = engine.decode(
      { data: fakeTransferableBuffer(Number.MAX_SAFE_INTEGER) },
      { transferInput: true, unsafeAllowLargeBuffers: true },
    );

    await expect(
      engine.decode(
        { data: fakeTransferableBuffer(Number.MAX_SAFE_INTEGER + 1) },
        { transferInput: true, unsafeAllowLargeBuffers: true },
      ),
    ).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message: expect.stringContaining('requested: an unsafe size'),
    });

    engine.terminate();
    await Promise.allSettled([active, queued]);
  });

  it('supports zero waiting operations without copying a rejected input', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, { maxQueued: 0, maxQueuedBytes: 0 });
    const active = engine.decode({ data: new ArrayBuffer(1) });
    const rejectedInput = new ArrayBuffer(1);
    const slice = vi.spyOn(rejectedInput, 'slice');
    const channelData = [new Float32Array(1)];
    const iterateChannels = vi.spyOn(channelData, Symbol.iterator);

    await expect(
      engine.transcode({ data: rejectedInput }, PRESET.id),
    ).rejects.toMatchObject({ code: 'QUEUE_CAPACITY_EXCEEDED' });
    await expect(
      engine.encode({ channelData, sampleRate: 1 }, PRESET.id),
    ).rejects.toMatchObject({ code: 'QUEUE_CAPACITY_EXCEEDED' });
    expect(slice).not.toHaveBeenCalled();
    expect(iterateChannels).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(1);

    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
    await active;
    engine.terminate();
  });

  it('releases cancelled queue capacity synchronously and preserves FIFO', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, { maxQueued: 1, maxQueuedBytes: 1 });
    const active = engine.decode({ data: new ArrayBuffer(1) });
    const controller = createManualAbortSignal();
    const cancelledInput = new ArrayBuffer(1);
    const cancelled = engine.transcode(
      { data: cancelledInput },
      PRESET.id,
      { signal: controller.signal, transferInput: true },
    );

    await expect(
      engine.decode({ data: new ArrayBuffer(1) }),
    ).rejects.toMatchObject({ code: 'QUEUE_CAPACITY_EXCEEDED' });
    controller.abort('free queue slot');
    const replacement = engine.decode({ data: new ArrayBuffer(1) });
    controller.invokeDetachedListener();

    expect(cancelledInput.byteLength).toBe(1);
    expect(controller.signal.removeEventListener).toHaveBeenCalledOnce();
    expect(worker.posts).toHaveLength(1);
    await expect(cancelled).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'free queue slot',
    });

    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
    await active;
    expect(worker.posts[1]?.message).toMatchObject({ id: 3, type: 'decode' });
    worker.emitMessage({ id: 3, operation: 'decode', type: 'result', value: DECODED });
    await replacement;
    engine.terminate();
  });

  it('transfers original ArrayBuffers only when explicitly requested', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const inputData = new ArrayBuffer(2);
    const decodeResult = engine.decode(
      { data: inputData },
      { transferInput: true },
    );
    const decodeRequest = worker.posts[0]?.message as Extract<
      AudioWorkerRequest,
      { type: 'decode' }
    >;
    expect(decodeRequest.input.data).toBe(inputData);
    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
    await decodeResult;

    const channel = new Float32Array([1]);
    const encodeResult = engine.encode(
      { channelData: [channel, channel], sampleRate: 1 },
      PRESET.id,
      { transferInput: true },
    );
    const encodeRequest = worker.posts[1]?.message as Extract<
      AudioWorkerRequest,
      { type: 'encode' }
    >;
    expect(encodeRequest.audio.channelData).toEqual([channel, channel]);
    expect(worker.posts[1]?.transfer).toEqual([channel.buffer]);
    worker.emitMessage({ id: 2, operation: 'encode', type: 'result', value: ENCODED });
    await encodeResult;
  });

  it('copies SharedArrayBuffer channels because they are not transferable', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const channel = new Float32Array(new SharedArrayBuffer(4));
    const result = engine.encode(
      { channelData: [channel], sampleRate: 1 },
      PRESET.id,
      { transferInput: true },
    );
    const request = worker.posts[0]?.message as Extract<
      AudioWorkerRequest,
      { type: 'encode' }
    >;

    expect(request.audio.channelData[0]).not.toBe(channel);
    expect(request.audio.channelData[0]?.buffer).toBeInstanceOf(ArrayBuffer);
    worker.emitMessage({ id: 1, operation: 'encode', type: 'result', value: ENCODED });
    await result;
  });

  it.each([
    [{ code: 'UNSUPPORTED_INPUT' as const, message: 'coded', name: 'AudioTranscoderError' }, 'AudioTranscoderError'],
    [{ message: 'plain', name: 'TypeError' }, 'TypeError'],
  ])('reconstructs worker errors %#', async (error, expectedName) => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const result = engine.decode({ data: new ArrayBuffer(1) });

    worker.emitMessage({ error, id: 1, type: 'error' });

    await expect(result).rejects.toMatchObject({
      message: error.message,
      name: expectedName,
    });
  });

  it.each([
    [new Error('error stop'), 'error stop'],
    ['string stop', 'string stop'],
    [123, 'Audio operation was aborted.'],
  ])('rejects pre-aborted operations without posting %#', async (reason, message) => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const signal = { aborted: true, reason } as AbortSignal;
    const slice = vi.spyOn(ArrayBuffer.prototype, 'slice');

    await expect(
      engine.decode({ data: new ArrayBuffer(1) }, { signal }),
    ).rejects.toMatchObject({ code: 'OPERATION_ABORTED', message });
    expect(slice).not.toHaveBeenCalled();
    slice.mockRestore();
    expect(worker.posts).toHaveLength(0);
  });

  it('cancels active operations and settles even if cancellation posting fails', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const controller = new AbortController();
    const result = engine.decode(
      { data: new ArrayBuffer(1) },
      { signal: controller.signal },
    );

    worker.throwOnCancel = true;
    controller.abort('active stop');
    const settled = vi.fn();
    void result.then(settled, settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    worker.emitMessage({ id: 1, progress: PROGRESS, type: 'progress' });
    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
    await expect(result).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'active stop',
    });
  });

  it('cancels and rejects when a progress listener throws', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const failure = new Error('UI callback failed');
    const result = engine.decode(
      { data: new ArrayBuffer(1) },
      {
        onProgress() {
          throw failure;
        },
      },
    );
    const next = engine.decode({ data: new ArrayBuffer(1) });

    worker.emitMessage({ id: 1, progress: PROGRESS, type: 'progress' });
    expect(worker.posts.at(-1)?.message).toEqual({ id: 1, type: 'cancel' });
    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
    await expect(result).rejects.toBe(failure);
    expect(worker.posts[2]?.message).toMatchObject({ id: 2, type: 'decode' });
    worker.emitMessage({ id: 2, operation: 'decode', type: 'result', value: DECODED });
    await next;
  });

  it('settles a callback failure if cancellation posting also fails', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const result = engine.decode(
      { data: new ArrayBuffer(1) },
      { onProgress: () => { throw new Error('callback'); } },
    );
    worker.throwOnCancel = true;

    worker.emitMessage({ id: 1, progress: PROGRESS, type: 'progress' });
    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
    await expect(result).rejects.toThrow('callback');
  });

  it('preserves local cancellation if the Worker fails during cleanup', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const controller = new AbortController();
    const result = engine.decode(
      { data: new ArrayBuffer(1) },
      {
        onProgress() {
          controller.abort('listener stopped');
          throw new Error('late callback failure');
        },
        signal: controller.signal,
      },
    );

    worker.emitMessage({ id: 1, progress: PROGRESS, type: 'progress' });
    worker.emitError('cleanup failed');
    await expect(result).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'listener stopped',
    });
  });

  it('cleans up and rejects synchronous postMessage failures', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    worker.throwOnOperation = true;

    await expect(engine.decode({ data: new ArrayBuffer(1) })).rejects.toThrow(
      'post failed',
    );
  });

  it.each([
    ['error message', 'error', 'worker crashed'],
    ['fallback error message', 'error', ''],
    ['message deserialization', 'messageerror', ''],
  ] as const)('rejects pending work after %s', async (_case, eventType, message) => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const result = engine.decode({ data: new ArrayBuffer(1) });
    const queued = engine.encode(
      { channelData: [new Float32Array(1)], sampleRate: 1 },
      PRESET.id,
    );

    if (eventType === 'error') {
      worker.emitError(message);
    } else {
      worker.emitMessageError();
    }

    await expect(result).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
    await expect(queued).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
    await expect(engine.decode({ data: new ArrayBuffer(1) })).rejects.toMatchObject({
      code: 'WORKER_TERMINATED',
    });
  });

  it('terminates idempotently and rejects every pending operation', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const first = engine.decode({ data: new ArrayBuffer(1) });
    const queuedSignal = createManualAbortSignal();
    const second = engine.encode(
      { channelData: [new Float32Array(1)], sampleRate: 1 },
      PRESET.id,
      { signal: queuedSignal.signal },
    );
    const lateError = worker.listeners.error[0]!;

    engine.terminate();
    engine.terminate();
    lateError({ message: 'late error' } as ErrorEvent);

    await expect(first).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await expect(second).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    expect(worker.terminateCalls).toBe(1);
    expect(worker.listenerCount()).toBe(0);
    expect(queuedSignal.signal.removeEventListener).toHaveBeenCalledOnce();
  });

  it.each([
    -1,
    1.5,
    65,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'rejects invalid maxQueued %s before creating a Worker',
    (maxQueued) => {
      const workerFactory = vi.fn(() => new WorkerStub() as unknown as Worker);

      expect(() =>
        createAudioTranscoderWorkerEngine({ maxQueued, workerFactory }),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVALID_CONFIGURATION',
          message: 'Worker engine maxQueued must be an integer from 0 to 64.',
        }),
      );
      expect(workerFactory).not.toHaveBeenCalled();
    },
  );

  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'rejects invalid maxQueuedBytes %s before creating a Worker',
    (maxQueuedBytes) => {
      const workerFactory = vi.fn(() => new WorkerStub() as unknown as Worker);

      expect(() =>
        createAudioTranscoderWorkerEngine({ maxQueuedBytes, workerFactory }),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVALID_CONFIGURATION',
          message:
            'Worker engine maxQueuedBytes must be a non-negative safe integer.',
        }),
      );
      expect(workerFactory).not.toHaveBeenCalled();
    },
  );

  it('accepts the maxQueued and maxQueuedBytes hard boundaries', () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, {
      maxQueued: 64,
      maxQueuedBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(worker.listenerCount()).toBe(3);
    engine.terminate();
  });

  it('uses the native module Worker by default', () => {
    const worker = new WorkerStub();
    const WorkerConstructor = vi.fn(function WorkerConstructor(
      _url: URL,
      _options: WorkerOptions,
    ) {
      return worker;
    });
    vi.stubGlobal('Worker', WorkerConstructor);

    const engine = createAudioTranscoderWorkerEngine();

    expect(WorkerConstructor).toHaveBeenCalledWith(expect.any(URL), {
      name: 'audio-transcoder',
      type: 'module',
    });
    engine.terminate();
  });

  it('fails clearly when Web Workers are unavailable', () => {
    vi.stubGlobal('Worker', undefined);

    expect(() => createAudioTranscoderWorkerEngine()).toThrowError(
      expect.objectContaining({ code: 'WORKER_UNAVAILABLE' }),
    );
  });
});

interface WorkerPost {
  readonly message: AudioWorkerRequest;
  readonly transfer: readonly Transferable[];
}

class WorkerStub {
  readonly posts: WorkerPost[] = [];
  readonly listeners = {
    error: [] as ((event: ErrorEvent) => void)[],
    message: [] as ((event: MessageEvent<AudioWorkerResponse>) => void)[],
    messageerror: [] as (() => void)[],
  };
  terminateCalls = 0;
  terminated = false;
  throwOnCancel = false;
  throwOnOperation = false;

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') {
      this.listeners.message.push(
        listener as unknown as (event: MessageEvent<AudioWorkerResponse>) => void,
      );
    } else if (type === 'error') {
      this.listeners.error.push(listener as unknown as (event: ErrorEvent) => void);
    } else {
      this.listeners.messageerror.push(listener as unknown as () => void);
    }
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type === 'message') {
      this.listeners.message.splice(
        this.listeners.message.indexOf(
          listener as unknown as (event: MessageEvent<AudioWorkerResponse>) => void,
        ),
        1,
      );
    } else if (type === 'error') {
      this.listeners.error.splice(
        this.listeners.error.indexOf(
          listener as unknown as (event: ErrorEvent) => void,
        ),
        1,
      );
    } else {
      this.listeners.messageerror.splice(
        this.listeners.messageerror.indexOf(listener as unknown as () => void),
        1,
      );
    }
  }

  listenerCount(): number {
    return (
      this.listeners.message.length +
      this.listeners.error.length +
      this.listeners.messageerror.length
    );
  }

  emitError(message: string): void {
    for (const listener of this.listeners.error) {
      listener({ message } as ErrorEvent);
    }
  }

  emitMessage(message: AudioWorkerResponse): void {
    for (const listener of this.listeners.message) {
      listener({ data: message } as MessageEvent<AudioWorkerResponse>);
    }
  }

  emitMessageError(): void {
    for (const listener of this.listeners.messageerror) {
      listener();
    }
  }

  postMessage(message: AudioWorkerRequest, transfer: Transferable[] = []): void {
    if (
      (message.type === 'cancel' && this.throwOnCancel) ||
      (message.type !== 'cancel' && this.throwOnOperation)
    ) {
      throw new Error('post failed');
    }
    this.posts.push({ message, transfer });
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.terminated = true;
  }
}

function createEngine(
  worker: WorkerStub,
  options: Omit<CreateAudioTranscoderWorkerEngineOptions, 'workerFactory'> = {},
) {
  return createAudioTranscoderWorkerEngine({
    ...options,
    workerFactory: () => worker as unknown as Worker,
  });
}

function createManualAbortSignal(): {
  abort(reason: unknown): void;
  invokeDetachedListener(): void;
  readonly signal: AbortSignal;
} {
  let aborted = false;
  let listener: (() => void) | undefined;
  let reason: unknown;
  const signal = {
    addEventListener(
      _type: string,
      value: EventListenerOrEventListenerObject,
    ): void {
      listener =
        typeof value === 'function'
          ? () => value({} as Event)
          : () => value.handleEvent({} as Event);
    },
    get aborted() {
      return aborted;
    },
    removeEventListener: vi.fn(),
    get reason() {
      return reason;
    },
  } as unknown as AbortSignal;

  return {
    abort(nextReason): void {
      aborted = true;
      reason = nextReason;
      listener?.();
    },
    invokeDetachedListener(): void {
      listener?.();
    },
    signal,
  };
}

interface FakeBuffer {
  byteLength: number;
}

interface FakeChannel {
  readonly channel: Float32Array;
  readonly slice: ReturnType<typeof vi.fn>;
}

function fakeBuffer(byteLength: number): FakeBuffer {
  return { byteLength };
}

function fakeTransferableBuffer(byteLength: number): ArrayBuffer {
  const buffer = Object.create(ArrayBuffer.prototype) as ArrayBuffer;
  Object.defineProperty(buffer, 'byteLength', { value: byteLength });
  return buffer;
}

function fakeChannel(
  buffer: FakeBuffer | ArrayBuffer,
  byteLength: number,
): FakeChannel {
  const slice = vi.fn();
  const channel = {
    buffer: buffer as ArrayBufferLike,
    byteLength,
    length: byteLength / Float32Array.BYTES_PER_ELEMENT,
    slice,
  } as unknown as Float32Array;
  return { channel, slice };
}

function fakeLengthTrackingChannel(buffer: FakeBuffer): FakeChannel {
  const slice = vi.fn();
  const channel = {
    buffer: buffer as unknown as ArrayBufferLike,
    get byteLength() {
      return buffer.byteLength;
    },
    get length() {
      return buffer.byteLength / Float32Array.BYTES_PER_ELEMENT;
    },
    slice,
  } as unknown as Float32Array;
  return { channel, slice };
}
