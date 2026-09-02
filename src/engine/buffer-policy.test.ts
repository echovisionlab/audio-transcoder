import { describe, expect, it } from 'vitest';
import {
  assertWholeBufferDecodeEstimateWithinLimit,
  assertWholeBufferInputWithinLimit,
  assertWholeBufferPcmWithinLimit,
  assertWorkerPcmPayloadWithinLimit,
  AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES,
  createWorkerPcmPayloadPlan,
  estimatePlanarFloat32ByteLength,
  getUniquePcmBufferByteLength,
} from './buffer-policy.js';
import { AudioTranscoderError } from '../errors.js';

describe('whole-buffer policy', () => {
  it('allows the exact public 64 MiB boundary and rejects one byte over it', () => {
    expect(AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES).toBe(64 * 1024 * 1024);
    expect(() =>
      assertWholeBufferInputWithinLimit(
        { data: fakeArrayBuffer(AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES) },
        {},
      ),
    ).not.toThrow();

    expect(() =>
      assertWholeBufferInputWithinLimit(
        {
          data: fakeArrayBuffer(
            AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES + 1,
          ),
        },
        {},
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'RESOURCE_LIMIT_EXCEEDED',
        message: expect.stringMatching(
          /createAudioTranscoderStreamWorkerEngine\(\).*createAudioTranscoderStreamWorkerPool\(\)/,
        ),
      }),
    );
  });

  it('counts each underlying PCM buffer once across shared views', () => {
    const arrayBuffer = new ArrayBuffer(16);
    const sharedBuffer = new SharedArrayBuffer(8);
    const channelData = [
      new Float32Array(arrayBuffer, 0, 2),
      new Float32Array(arrayBuffer, 8, 2),
      new Float32Array(sharedBuffer),
    ];

    expect(getUniquePcmBufferByteLength(channelData)).toBe(24);
  });

  it('estimates planar Float32 storage without overflowing', () => {
    expect(estimatePlanarFloat32ByteLength(0, 2)).toBe(0);
    expect(estimatePlanarFloat32ByteLength(4, 2)).toBe(32);
    expect(
      estimatePlanarFloat32ByteLength(Number.MAX_SAFE_INTEGER, 2),
    ).toBe(Number.POSITIVE_INFINITY);
    expect(estimatePlanarFloat32ByteLength(-1, 2)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(estimatePlanarFloat32ByteLength(1, Number.NaN)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('enforces the decoded PCM estimate before allocation', () => {
    const exactFrames =
      AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES /
      Float32Array.BYTES_PER_ELEMENT;

    expect(() =>
      assertWholeBufferDecodeEstimateWithinLimit(
        { channels: 1, frames: exactFrames },
        {},
      ),
    ).not.toThrow();
    expect(() =>
      assertWholeBufferDecodeEstimateWithinLimit(
        { channels: 1, frames: exactFrames + 1 },
        {},
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_LIMIT_EXCEEDED' }),
    );
  });

  it('rejects unique PCM storage over the limit but allows the exact boundary', () => {
    const exactBuffer = fakeArrayBuffer(
      AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES,
    );
    expect(() =>
      assertWholeBufferPcmWithinLimit(
        {
          channelData: [
            fakeChannel(exactBuffer),
            fakeChannel(exactBuffer),
          ],
          sampleRate: 48_000,
        },
        {},
      ),
    ).not.toThrow();

    expect(() =>
      assertWholeBufferPcmWithinLimit(
        {
          channelData: [
            fakeChannel(
              fakeArrayBuffer(AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES),
            ),
            fakeChannel(fakeArrayBuffer(1)),
          ],
          sampleRate: 48_000,
        },
        {},
      ),
    ).toThrowError(AudioTranscoderError);
  });

  it('counts every copied PCM view even when views share one backing store', () => {
    const viewBytes = 40 * 1024 * 1024;
    const buffer = fakeArrayBuffer(viewBytes);
    const channelData = [
      fakeChannel(buffer, viewBytes),
      fakeChannel(buffer, viewBytes),
    ];
    const plan = createWorkerPcmPayloadPlan(channelData, false);

    expect(getUniquePcmBufferByteLength(channelData)).toBe(viewBytes);
    expect(plan.byteLength).toBe(viewBytes * 2);
    expect(plan.channels.map(({ mode }) => mode)).toEqual(['copy', 'copy']);
    expect(plan.transferBuffers).toEqual([]);
    expect(() => assertWorkerPcmPayloadWithinLimit(plan, {})).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_LIMIT_EXCEEDED' }),
    );
  });

  it('counts transferable buffers once and every copied shared view', () => {
    const transferableBytes = 32 * 1024 * 1024;
    const sharedViewBytes = 20 * 1024 * 1024;
    const transferable = fakeTransferableArrayBuffer(transferableBytes);
    const shared = fakeArrayBuffer(sharedViewBytes);
    const channelData = [
      fakeChannel(transferable, 4),
      fakeChannel(transferable, 4),
      fakeChannel(shared, sharedViewBytes),
      fakeChannel(shared, sharedViewBytes),
    ];
    const plan = createWorkerPcmPayloadPlan(channelData, true);

    expect(getUniquePcmBufferByteLength(channelData)).toBe(
      transferableBytes + sharedViewBytes,
    );
    expect(plan.byteLength).toBe(
      transferableBytes + sharedViewBytes * 2,
    );
    expect(plan.channels.map(({ mode }) => mode)).toEqual([
      'transfer',
      'transfer',
      'copy',
      'copy',
    ]);
    expect(plan.transferBuffers).toEqual([transferable]);
    expect(() => assertWorkerPcmPayloadWithinLimit(plan, {})).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_LIMIT_EXCEEDED' }),
    );
  });

  it('reports an unsafe size instead of overflowing PCM byte accounting', () => {
    const channelData = [
      fakeChannel(fakeArrayBuffer(Number.MAX_SAFE_INTEGER)),
      fakeChannel(fakeArrayBuffer(1)),
    ];

    expect(getUniquePcmBufferByteLength(channelData)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(() =>
      assertWholeBufferPcmWithinLimit(
        { channelData, sampleRate: 1 },
        {},
      ),
    ).toThrowError(/an unsafe size/);

    const plan = createWorkerPcmPayloadPlan(channelData, false);
    expect(plan.byteLength).toBe(Number.POSITIVE_INFINITY);
    expect(() => assertWorkerPcmPayloadWithinLimit(plan, {})).toThrowError(
      /an unsafe size/,
    );
  });

  it('allows explicit unsafe input and PCM opt-ins', () => {
    const options = { unsafeAllowLargeBuffers: true } as const;

    expect(() =>
      assertWholeBufferInputWithinLimit(
        { data: fakeArrayBuffer(Number.POSITIVE_INFINITY) },
        options,
      ),
    ).not.toThrow();
    expect(() =>
      assertWholeBufferDecodeEstimateWithinLimit(
        { channels: Number.POSITIVE_INFINITY, frames: 1 },
        options,
      ),
    ).not.toThrow();
    expect(() =>
      assertWholeBufferPcmWithinLimit(
        {
          channelData: [
            fakeChannel(fakeArrayBuffer(Number.POSITIVE_INFINITY)),
          ],
          sampleRate: 1,
        },
        options,
      ),
    ).not.toThrow();
    expect(() =>
      assertWorkerPcmPayloadWithinLimit(
        { byteLength: Number.POSITIVE_INFINITY, channels: [], transferBuffers: [] },
        options,
      ),
    ).not.toThrow();
  });
});

function fakeArrayBuffer(byteLength: number): ArrayBuffer {
  return { byteLength } as ArrayBuffer;
}

function fakeTransferableArrayBuffer(byteLength: number): ArrayBuffer {
  const buffer = Object.create(ArrayBuffer.prototype) as ArrayBuffer;
  Object.defineProperty(buffer, 'byteLength', { value: byteLength });
  return buffer;
}

function fakeChannel(
  buffer: ArrayBufferLike,
  byteLength = buffer.byteLength,
): Float32Array {
  return {
    buffer,
    byteLength,
    length: byteLength / Float32Array.BYTES_PER_ELEMENT,
  } as Float32Array;
}
