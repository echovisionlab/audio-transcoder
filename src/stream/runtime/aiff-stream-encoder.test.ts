import { describe, expect, it, vi } from 'vitest';
import { readAscii, readExtended80, readInt24BE } from '../../codecs/binary.js';
import type { AudioStreamOutputChunk } from '../contracts.js';
import type { AudioStreamEncoderConfiguration } from './contracts.js';
import { createAiffStreamEncoder } from './aiff-stream-encoder.js';

describe('built-in AIFF stream encoder', () => {
  it('rejects an output chunk limit smaller than one complete frame', () => {
    expect(() =>
      createAiffStreamEncoder(
        createConfiguration({ channels: 2, outputChunkBytes: 3 }),
        16,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
  });

  it('rejects a header write larger than the configured output chunk limit', async () => {
    const destination = createDestination();
    const encoder = createAiffStreamEncoder(
      createConfiguration({
        channels: 1,
        outputChunkBytes: 2,
        writable: destination.stream,
      }),
      16,
    );

    await expect(encoder.start()).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
    });
    expect(destination.aborted).toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
    });
    expect(destination.stream.locked).toBe(false);
  });

  it('writes finalized 16-bit big-endian PCM through bounded seekable chunks', async () => {
    const destination = createDestination();
    const encoder = createAiffStreamEncoder(
      createConfiguration({
        channels: 1,
        outputChunkBytes: 64,
        sampleRate: 192_000,
        writable: destination.stream,
      }),
      16,
    );
    const samples = Float32Array.from(
      { length: 80 },
      (_value, index) => ((index % 5) - 2) / 2,
    );

    await encoder.start();
    await encoder.write(samples, 0);
    await encoder.finalize();

    const bytes = destination.bytes();
    const view = new DataView(bytes.buffer);
    expect(readAscii(view, 0, 4)).toBe('FORM');
    expect(view.getUint32(4, false)).toBe(bytes.byteLength - 8);
    expect(readAscii(view, 8, 4)).toBe('AIFF');
    expect(readAscii(view, 12, 4)).toBe('COMM');
    expect(view.getUint16(20, false)).toBe(1);
    expect(view.getUint32(22, false)).toBe(80);
    expect(view.getUint16(26, false)).toBe(16);
    expect(readExtended80(view, 28)).toBe(192_000);
    expect(readAscii(view, 38, 4)).toBe('SSND');
    expect(view.getUint32(42, false)).toBe(8 + samples.byteLength / 2);
    expect(view.getInt16(54, false)).toBe(-32_768);
    expect(view.getInt16(56, false)).toBe(-16_384);
    expect(view.getInt16(58, false)).toBe(0);
    expect(view.getInt16(60, false)).toBe(16_384);
    expect(view.getInt16(62, false)).toBe(32_767);
    expect(destination.writes.map(({ data }) => data.byteLength)).toEqual([
      54,
      64,
      64,
      32,
      54,
    ]);
    expect(destination.writes.every(({ data }) => data.byteLength <= 64)).toBe(
      true,
    );
    expect(destination.closed).toBe(true);
    expect(encoder.getBytesWritten()).toBe(54 + samples.length * 2);
  });

  it('writes 24-bit PCM, an odd SSND pad, and final random-access sizes', async () => {
    const destination = createDestination();
    const encoder = createAiffStreamEncoder(
      createConfiguration({ channels: 1, writable: destination.stream }),
      24,
    );

    await encoder.start();
    await encoder.write(new Float32Array([-1, 0, 1]), 0);
    await encoder.finalize();

    const bytes = destination.bytes();
    const view = new DataView(bytes.buffer);
    expect(bytes.byteLength).toBe(64);
    expect(view.getUint32(4, false)).toBe(56);
    expect(view.getUint32(22, false)).toBe(3);
    expect(view.getUint32(42, false)).toBe(17);
    expect(readInt24BE(view, 54)).toBe(-8_388_608);
    expect(readInt24BE(view, 57)).toBe(0);
    expect(readInt24BE(view, 60)).toBe(8_388_607);
    expect(view.getUint8(63)).toBe(0);
    expect(destination.writes.at(-2)).toMatchObject({ position: 63 });
    expect(destination.writes.at(-1)).toMatchObject({ position: 0 });
    expect(encoder.getBytesWritten()).toBe(64);
  });

  it('preserves the configured multichannel frame layout', async () => {
    const destination = createDestination();
    const encoder = createAiffStreamEncoder(
      createConfiguration({ channels: 3, writable: destination.stream }),
      16,
    );

    await encoder.start();
    await encoder.write(new Float32Array([1, 0, -1, 0.5, -0.5, 0]), 0);
    await encoder.finalize();

    const view = new DataView(destination.bytes().buffer);
    expect(view.getUint16(20, false)).toBe(3);
    expect(view.getUint32(22, false)).toBe(2);
    expect(
      Array.from({ length: 6 }, (_value, index) =>
        view.getInt16(54 + index * 2, false),
      ),
    ).toEqual([32_767, 0, -32_768, 16_384, -16_384, 0]);
  });

  it('rejects incomplete, concurrent, and non-sequential writes', async () => {
    const destination = createDestination();
    let releaseWrite: (() => void) | undefined;
    destination.beforeWrite = ({ position }) =>
      position === 54
        ? new Promise<void>((resolve) => {
            releaseWrite = resolve;
          })
        : undefined;
    const encoder = createAiffStreamEncoder(
      createConfiguration({ channels: 2, writable: destination.stream }),
      16,
    );
    await encoder.start();

    await expect(encoder.write(new Float32Array([0]), 0)).rejects.toMatchObject({
      code: 'INVALID_AUDIO_DATA',
    });
    await expect(
      encoder.write(new Float32Array([0, 0]), 1),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });

    const first = encoder.write(new Float32Array([0, 0]), 0);
    await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));
    await expect(
      encoder.write(new Float32Array([0, 0]), 0),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    releaseWrite!();
    await first;
    await encoder.finalize();
  });

  it('classifies an unrepresentable AIFF size as a target limit', async () => {
    const destination = createDestination();
    const encoder = createAiffStreamEncoder(
      createConfiguration({ channels: 1, writable: destination.stream }),
      16,
    );
    await encoder.start();
    const oversized = {
      length: 0x1_0000_0000,
    } as unknown as Float32Array;

    await expect(encoder.write(oversized, 0)).rejects.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      reason: 'target-size-limit',
    });
    await encoder.cancel();
  });

  it('aborts and unlocks the destination idempotently', async () => {
    const destination = createDestination();
    const encoder = createAiffStreamEncoder(
      createConfiguration({ writable: destination.stream }),
      16,
    );

    await encoder.start();
    await encoder.cancel('stop');
    await encoder.cancel('stop again');

    expect(destination.aborted).toBe('stop');
    expect(destination.stream.locked).toBe(false);
  });

  it('swallows a destination abort rejection while releasing its writer', async () => {
    const stream = new WritableStream<AudioStreamOutputChunk>({
      abort() {
        throw new Error('abort failed');
      },
    });
    const encoder = createAiffStreamEncoder(
      createConfiguration({ writable: stream }),
      16,
    );

    await expect(encoder.cancel('stop')).resolves.toBeUndefined();
    expect(stream.locked).toBe(false);
  });

  it('does not release a writer whose destination is already unlocked', async () => {
    const releaseLock = vi.fn();
    const writable = {
      getWriter: () => ({
        abort: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        releaseLock,
        write: vi.fn().mockResolvedValue(undefined),
      }),
      locked: false,
    } as unknown as WritableStream<AudioStreamOutputChunk>;
    const encoder = createAiffStreamEncoder(
      createConfiguration({ writable }),
      16,
    );

    await encoder.cancel();

    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('treats cancel after finalization and repeated finalize as no-ops', async () => {
    const destination = createDestination();
    const encoder = createAiffStreamEncoder(
      createConfiguration({ writable: destination.stream }),
      16,
    );
    await encoder.start();

    const firstFinalize = encoder.finalize();
    expect(encoder.finalize()).toBe(firstFinalize);
    await firstFinalize;
    await encoder.cancel('too late');

    expect(destination.aborted).toBeUndefined();
    expect(destination.closed).toBe(true);
  });

  it('rejects finalize before start and while a write is active', async () => {
    const pendingDestination = createDestination();
    const pendingEncoder = createAiffStreamEncoder(
      createConfiguration({ writable: pendingDestination.stream }),
      16,
    );
    await expect(pendingEncoder.finalize()).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: expect.stringContaining('pending'),
    });
    await pendingEncoder.cancel();

    const activeDestination = createDestination();
    let releaseWrite: (() => void) | undefined;
    activeDestination.beforeWrite = ({ position }) =>
      position === 54
        ? new Promise<void>((resolve) => {
            releaseWrite = resolve;
          })
        : undefined;
    const activeEncoder = createAiffStreamEncoder(
      createConfiguration({ writable: activeDestination.stream }),
      16,
    );
    await activeEncoder.start();
    const write = activeEncoder.write(new Float32Array([0, 0]), 0);
    await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));

    await expect(activeEncoder.finalize()).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: expect.stringContaining('writing'),
    });
    releaseWrite!();
    await write;
    await activeEncoder.cancel();
  });

  it('rejects a repeated start without disrupting a valid session', async () => {
    const destination = createDestination();
    const encoder = createAiffStreamEncoder(
      createConfiguration({ writable: destination.stream }),
      16,
    );

    await encoder.start();
    await expect(encoder.start()).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: expect.stringContaining('started'),
    });
    await encoder.finalize();
  });

  it('rejects a concurrent start before it can emit a duplicate header', async () => {
    const destination = createDestination();
    let blockFirstHeader = true;
    let releaseStart: (() => void) | undefined;
    destination.beforeWrite = ({ position }) => {
      if (position !== 0 || !blockFirstHeader) {
        return undefined;
      }
      blockFirstHeader = false;
      return new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
    };
    const encoder = createAiffStreamEncoder(
      createConfiguration({ writable: destination.stream }),
      16,
    );

    const firstStart = encoder.start();
    await vi.waitFor(() => expect(releaseStart).toBeTypeOf('function'));
    await expect(encoder.start()).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: expect.stringContaining('starting'),
    });
    expect(destination.writes).toHaveLength(0);

    releaseStart!();
    await firstStart;
    expect(destination.writes).toHaveLength(1);
    expect(destination.writes[0]).toMatchObject({ position: 0 });
    await encoder.cancel();
  });

  it('stays canceled when a blocked start write settles after cancellation', async () => {
    const destination = createDestination();
    let releaseStart: (() => void) | undefined;
    destination.beforeWrite = ({ position }) =>
      position === 0
        ? new Promise<void>((resolve) => {
            releaseStart = resolve;
          })
        : undefined;
    const encoder = createAiffStreamEncoder(
      createConfiguration({ writable: destination.stream }),
      16,
    );

    const start = encoder.start();
    await vi.waitFor(() => expect(releaseStart).toBeTypeOf('function'));
    const cancellation = encoder.cancel('stop during start');
    releaseStart!();

    await expect(start).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: expect.stringContaining('canceled'),
    });
    await expect(cancellation).resolves.toBeUndefined();
    expect(destination.aborted).toBe('stop during start');
    expect(destination.stream.locked).toBe(false);
    await expect(encoder.start()).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: expect.stringContaining('canceled'),
    });
  });

  it('cancels and unlocks when the destination fails to close', async () => {
    const stream = new WritableStream<AudioStreamOutputChunk>({
      close() {
        throw new Error('close failed');
      },
    });
    const encoder = createAiffStreamEncoder(
      createConfiguration({ writable: stream }),
      16,
    );
    await encoder.start();

    await expect(encoder.finalize()).rejects.toThrow('close failed');
    expect(stream.locked).toBe(false);
  });

  it('rejects frame counts beyond the AIFF 32-bit representation limit', async () => {
    const destination = createDestination();
    const encoder = createAiffStreamEncoder(
      createConfiguration({ channels: 1, writable: destination.stream }),
      16,
    );
    await encoder.start();
    const oversizedSamples = {
      length: 0x1_0000_0000,
    } as unknown as Float32Array;

    await expect(encoder.write(oversizedSamples, 0)).rejects.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      reason: 'target-size-limit',
    });
    await encoder.cancel();
  });

  it('aborts a pre-start session when its signal fires', async () => {
    const destination = createDestination();
    const controller = new AbortController();
    const encoder = createAiffStreamEncoder(
      createConfiguration({
        signal: controller.signal,
        writable: destination.stream,
      }),
      16,
    );
    controller.abort('stopped');

    await expect(encoder.start()).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'stopped',
    });
    expect(destination.aborted).toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(destination.stream.locked).toBe(false);
  });

  it('rejects a pre-aborted write before converting PCM', async () => {
    const destination = createDestination();
    const controller = new AbortController();
    const encoder = createAiffStreamEncoder(
      createConfiguration({
        outputChunkBytes: 4 * 1024 * 1024,
        signal: controller.signal,
        writable: destination.stream,
      }),
      16,
    );
    await encoder.start();
    controller.abort('write stopped');

    await expect(
      encoder.write(new Float32Array(4 * 1024 * 1024), 0),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'write stopped',
    });
    expect(destination.writes).toHaveLength(1);
  });

  it('bounds synchronous PCM conversion independently of the output limit', async () => {
    const destination = createDestination();
    const encoder = createAiffStreamEncoder(
      createConfiguration({
        channels: 1,
        outputChunkBytes: 4 * 1024 * 1024,
        writable: destination.stream,
      }),
      16,
    );
    await encoder.start();
    await encoder.write(new Float32Array(64 * 1024), 0);
    await encoder.finalize();

    expect(
      destination.writes
        .filter(({ position }) => position >= 54)
        .every(({ data }) => data.byteLength <= 64 * 1024),
    ).toBe(true);
  });
});

function createConfiguration(
  overrides: Partial<AudioStreamEncoderConfiguration> = {},
): AudioStreamEncoderConfiguration {
  return {
    channels: 2,
    outputChunkBytes: 64 * 1024,
    preset: {
      bitDepth: 16,
      container: 'aiff',
      extension: 'aiff',
      id: 'aiff-pcm16',
      mimeType: 'audio/aiff',
      sampleFormat: 'integer',
    },
    rf64: null,
    sampleRate: 48_000,
    writable: new WritableStream<AudioStreamOutputChunk>(),
    ...overrides,
  };
}

function createDestination(): {
  aborted: unknown;
  beforeWrite: ((
    chunk: AudioStreamOutputChunk,
  ) => Promise<void> | undefined) | undefined;
  bytes(): Uint8Array<ArrayBuffer>;
  closed: boolean;
  readonly stream: WritableStream<AudioStreamOutputChunk>;
  readonly writes: AudioStreamOutputChunk[];
} {
  let aborted: unknown;
  let closed = false;
  let bytes = new Uint8Array(0);
  const writes: AudioStreamOutputChunk[] = [];
  const destination = {
    get aborted() {
      return aborted;
    },
    beforeWrite: undefined as
      | ((chunk: AudioStreamOutputChunk) => Promise<void> | undefined)
      | undefined,
    bytes: () => bytes,
    get closed() {
      return closed;
    },
    stream: undefined as unknown as WritableStream<AudioStreamOutputChunk>,
    writes,
  };
  destination.stream = new WritableStream<AudioStreamOutputChunk>({
    abort(reason) {
      aborted = reason;
    },
    close() {
      closed = true;
    },
    async write(chunk) {
      await destination.beforeWrite?.(chunk);
      writes.push({
        data: Uint8Array.from(chunk.data),
        position: chunk.position,
        type: 'write',
      });
      const end = chunk.position + chunk.data.byteLength;
      if (end > bytes.byteLength) {
        const grown = new Uint8Array(end);
        grown.set(bytes);
        bytes = grown;
      }
      bytes.set(chunk.data, chunk.position);
    },
  });
  return destination;
}
