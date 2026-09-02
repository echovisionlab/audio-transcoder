import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioStreamOutputChunk } from '../contracts.js';
import type { AudioStreamEncoderConfiguration } from './contracts.js';
import type { OggOpusWasmExports } from './ogg-opus-wasm-runtime.js';
import {
  createOggOpusStreamEncoderFactory,
  OGG_OPUS_FIXED_SERIAL,
  OGG_OPUS_MAX_PAGE_BYTES,
} from './ogg-opus-stream-encoder.js';
import { createTestCodecAssetProvider } from '../codec-assets.test-support.js';

const CODEC_ASSETS = createTestCodecAssetProvider();
const createOggOpusStreamEncoder = createOggOpusStreamEncoderFactory(() =>
  CODEC_ASSETS.load('ogg-opus'),
);

const runtimeFactoryMocks = vi.hoisted(() => ({
  createInstantiator: vi.fn(),
}));

afterEach(() => {
  runtimeFactoryMocks.createInstantiator.mockReset();
  vi.doUnmock('./ogg-opus-wasm-runtime.js');
});

describe('bundled Ogg Opus stream encoder', () => {
  it('emits deterministic, bounded pages with exact pre-skip and end granule', async () => {
    const frames = 48_137;
    const samples = Float32Array.from(
      { length: frames },
      (_value, index) => Math.sin((index * Math.PI * 2 * 440) / 48_000) * 0.25,
    );

    const first = await encode(samples, 1, 96_000, 128);
    const second = await encode(samples, 1, 96_000, 128);

    expect(first.bytes).toEqual(second.bytes);
    expect(first.writes.every(({ data }) => data.byteLength <= 128)).toBe(true);
    expect(first.bytesWritten).toBe(first.bytes.byteLength);

    const pages = parseOggPages(first.bytes);
    expect(pages.length).toBeGreaterThan(3);
    expect(pages.every(({ bytes }) => bytes <= OGG_OPUS_MAX_PAGE_BYTES)).toBe(
      true,
    );
    expect(pages.map(({ sequence }) => sequence)).toEqual(
      pages.map((_page, index) => index),
    );
    expect(pages.every(({ serial }) => serial === OGG_OPUS_FIXED_SERIAL)).toBe(
      true,
    );
    expect(pages[0]!.flags & 0x02).toBe(0x02);
    expect(pages.slice(1).every(({ flags }) => (flags & 0x02) === 0)).toBe(
      true,
    );
    expect(pages.at(-1)!.flags & 0x04).toBe(0x04);
    expect(pages.slice(0, -1).every(({ flags }) => (flags & 0x04) === 0)).toBe(
      true,
    );

    const firstBody = pages[0]!.body;
    expect(new TextDecoder().decode(firstBody.subarray(0, 8))).toBe('OpusHead');
    expect(firstBody[9]).toBe(1);
    const preskip = new DataView(
      firstBody.buffer,
      firstBody.byteOffset,
      firstBody.byteLength,
    ).getUint16(10, true);
    expect(preskip).toBe(312);
    expect(pages.at(-1)!.granule).toBe(BigInt(preskip + frames));
  }, 30_000);

  it('preserves stereo headers and exact non-packet-aligned duration', async () => {
    const frames = 961;
    const samples = new Float32Array(frames * 2);
    for (let frame = 0; frame < frames; frame += 1) {
      samples[frame * 2] = frame % 2 === 0 ? 0.5 : -0.5;
      samples[frame * 2 + 1] = frame % 3 === 0 ? -0.25 : 0.25;
    }

    const output = await encode(samples, 2, 128_000, 65_536);
    const pages = parseOggPages(output.bytes);
    const head = pages[0]!.body;
    const preskip = new DataView(
      head.buffer,
      head.byteOffset,
      head.byteLength,
    ).getUint16(10, true);

    expect(head[9]).toBe(2);
    expect(pages.at(-1)!.granule).toBe(BigInt(preskip + frames));
  });

  it('rejects invalid layouts and releases a canceled destination', async () => {
    const destination = createDestination();
    const encoder = await createOggOpusStreamEncoder(
      createConfiguration({ writable: destination.stream }),
      64_000,
    );
    await encoder.start();

    await expect(encoder.write(new Float32Array([0]), 0)).rejects.toMatchObject(
      {
        code: 'INVALID_AUDIO_DATA',
      },
    );
    await expect(
      encoder.write(new Float32Array([0, 0]), 1),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });

    await encoder.cancel('stop');
    await encoder.cancel('stop again');
    expect(destination.aborted).toBe('stop');
    expect(destination.stream.locked).toBe(false);
  });

  it('classifies an unsafe Ogg frame count as a target limit', async () => {
    const destination = createDestination();
    const encoder = await createOggOpusStreamEncoder(
      createConfiguration({
        channels: 1,
        writable: destination.stream,
      }),
      64_000,
    );
    await encoder.start();
    const oversized = {
      length: Number.MAX_SAFE_INTEGER + 1,
    } as unknown as Float32Array;

    await expect(encoder.write(oversized, 0)).rejects.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      reason: 'target-size-limit',
    });
    await encoder.cancel();
  });

  it('creates an encoder factory from an explicit raw-WASM loader', async () => {
    const { wasm, destroy } = createFakeWasm();
    const module = await importEncoderWithWasm(wasm);
    const loadWasm = vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>();
    const factory = module.createOggOpusStreamEncoderFactory(loadWasm);

    const encoder = await factory(createConfiguration(), 64_000);
    await encoder.cancel();

    expect(destroy).toHaveBeenCalledOnce();
    expect(runtimeFactoryMocks.createInstantiator).toHaveBeenCalledWith(
      loadWasm,
    );
  });

  it('checks cancellation before PCM enters WASM', async () => {
    const destination = createDestination();
    const controller = new AbortController();
    const encoder = await createOggOpusStreamEncoder(
      createConfiguration({
        signal: controller.signal,
        writable: destination.stream,
      }),
      192_000,
    );
    await encoder.start();
    const headerWrites = destination.writes.length;
    controller.abort('encode stopped');

    await expect(
      encoder.write(new Float32Array(96_000), 0),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'encode stopped',
    });
    expect(destination.writes).toHaveLength(headerWrites);
    await encoder.cancel('encode stopped');
    expect(destination.stream.locked).toBe(false);
  });

  it('rejects promptly when an injected WASM loader ignores cancellation', async () => {
    const loader = deferred<Uint8Array<ArrayBuffer>>();
    const loadWasm = vi.fn((_signal?: AbortSignal) => loader.promise);
    const factory = createOggOpusStreamEncoderFactory(loadWasm);
    const controller = new AbortController();
    const destination = createDestination();

    const pending = factory(
      createConfiguration({
        signal: controller.signal,
        writable: destination.stream,
      }),
      128_000,
    );
    await vi.waitFor(() => expect(loadWasm).toHaveBeenCalledOnce());
    const loaderSignal = loadWasm.mock.calls[0]?.[0];
    controller.abort('Ogg setup stopped');

    await expect(pending).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'Ogg setup stopped',
    });
    expect(loaderSignal).toBeInstanceOf(AbortSignal);
    expect(loaderSignal?.aborted).toBe(true);
    expect(destination.stream.locked).toBe(false);
    loader.reject(new Error('late Ogg loader failure'));
  });

  it('rejects unsupported sample rates and channel counts before loading WASM', async () => {
    await expect(
      createOggOpusStreamEncoder(
        createConfiguration({ sampleRate: 44_100 }),
        64_000,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
    await expect(
      createOggOpusStreamEncoder(createConfiguration({ channels: 3 }), 64_000),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
  });
});

describe('bundled Ogg Opus stream encoder failures', () => {
  afterEach(() => {
    vi.doUnmock('./ogg-opus-wasm-runtime.js');
    vi.restoreAllMocks();
  });

  it.each([new Error('compile failed'), 'invalid module'])(
    'maps a lazy runtime rejection without locking output (%s)',
    async (failure) => {
      const module = await importEncoderWithRuntimeFailure(failure);
      const destination = createDestination();

      await expect(
        module.createOggOpusStreamEncoder(
          createConfiguration({ writable: destination.stream }),
          64_000,
        ),
      ).rejects.toMatchObject({
        code: 'WORKER_FAILURE',
        message: expect.stringContaining(
          failure instanceof Error ? failure.message : failure,
        ),
      });
      expect(destination.stream.locked).toBe(false);
    },
  );

  it('rejects a mismatched bridge bound and a failed native create', async () => {
    const wrongBound = createFakeWasm({ maxPageBytes: 1 });
    const wrongBoundModule = await importEncoderWithWasm(wrongBound.wasm);
    await expect(
      wrongBoundModule.createOggOpusStreamEncoder(
        createConfiguration(),
        64_000,
      ),
    ).rejects.toMatchObject({ code: 'WORKER_FAILURE' });

    const failedCreate = createFakeWasm({ createHandle: 0 });
    const failedCreateModule = await importEncoderWithWasm(failedCreate.wasm);
    await expect(
      failedCreateModule.createOggOpusStreamEncoder(
        createConfiguration(),
        64_000,
      ),
    ).rejects.toMatchObject({
      code: 'WORKER_FAILURE',
      message: expect.stringContaining('code -17'),
    });
  });

  it('destroys native state when locking the destination fails', async () => {
    const fake = createFakeWasm();
    const module = await importEncoderWithWasm(fake.wasm);
    const failure = new Error('writer unavailable');
    const writable = {
      getWriter(): never {
        throw failure;
      },
    } as unknown as AudioStreamEncoderConfiguration['writable'];

    await expect(
      module.createOggOpusStreamEncoder(
        createConfiguration({ writable }),
        64_000,
      ),
    ).rejects.toBe(failure);
    expect(fake.destroy).toHaveBeenCalledWith(1);
  });

  it.each([
    { pcmCapacityFrames: 0, pcmPointer: 8 },
    { pcmCapacityFrames: 960, pcmPointer: 0 },
  ])(
    'rejects an invalid PCM bridge and unlocks output (%o)',
    async (options) => {
      const fake = createFakeWasm(options);
      const module = await importEncoderWithWasm(fake.wasm);
      const abortFailure = new Error('abort failed');
      const writable = new WritableStream<AudioStreamOutputChunk>({
        abort() {
          throw abortFailure;
        },
      });

      await expect(
        module.createOggOpusStreamEncoder(
          createConfiguration({ writable }),
          64_000,
        ),
      ).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
      expect(fake.destroy).toHaveBeenCalledWith(1);
      expect(writable.locked).toBe(false);
    },
  );

  it('swallows destination abort failure and avoids releasing an absent lock', async () => {
    const fake = createFakeWasm();
    const module = await importEncoderWithWasm(fake.wasm);
    const releaseLock = vi.fn();
    const writer = {
      abort: vi.fn().mockRejectedValue(new Error('abort failed')),
      close: vi.fn().mockResolvedValue(undefined),
      releaseLock,
      write: vi.fn().mockResolvedValue(undefined),
    } as unknown as WritableStreamDefaultWriter<AudioStreamOutputChunk>;
    const writable = {
      get locked() {
        return false;
      },
      getWriter: () => writer,
    } as unknown as AudioStreamEncoderConfiguration['writable'];
    const encoder = await module.createOggOpusStreamEncoder(
      createConfiguration({ writable }),
      64_000,
    );

    await expect(encoder.cancel('stop')).resolves.toBeUndefined();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('stops a pending header write when cancel destroys the session', async () => {
    const page = new Uint8Array(27);
    const fake = createFakeWasm({ pullResults: [page, 0] });
    const module = await importEncoderWithWasm(fake.wasm);
    const write = deferred<void>();
    let writeStarted = false;
    const writable = new WritableStream<AudioStreamOutputChunk>({
      write() {
        writeStarted = true;
        return write.promise;
      },
    });
    const encoder = await module.createOggOpusStreamEncoder(
      createConfiguration({ writable }),
      64_000,
    );

    const start = encoder.start();
    await vi.waitFor(() => expect(writeStarted).toBe(true));
    const cancel = encoder.cancel('stop');
    write.resolve(undefined);

    await expect(start).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    await cancel;
    expect(writable.locked).toBe(false);
  });

  it('maps negative page pulls and malformed page pointers or lengths', async () => {
    const negative = createFakeWasm({ pullResults: [-13] });
    const negativeModule = await importEncoderWithWasm(negative.wasm);
    const negativeEncoder = await negativeModule.createOggOpusStreamEncoder(
      createConfiguration(),
      64_000,
    );
    await expect(negativeEncoder.start()).rejects.toMatchObject({
      code: 'WORKER_FAILURE',
      message: expect.stringContaining('code -13'),
    });

    for (const invalid of [
      { pageLength: 27, pagePointer: 0 },
      { pageLength: 26, pagePointer: 8_192 },
      { pageLength: 65_308, pagePointer: 8_192 },
    ]) {
      const fake = createFakeWasm({
        ...invalid,
        pullResults: [1],
      });
      const module = await importEncoderWithWasm(fake.wasm);
      const encoder = await module.createOggOpusStreamEncoder(
        createConfiguration(),
        64_000,
      );
      await expect(encoder.start()).rejects.toMatchObject({
        code: 'WORKER_FAILURE',
      });
    }
  });

  it('enforces start/finalize idempotence and ignores cancel after finalize', async () => {
    const fake = createFakeWasm();
    const module = await importEncoderWithWasm(fake.wasm);
    const destination = createDestination();
    const encoder = await module.createOggOpusStreamEncoder(
      createConfiguration({ writable: destination.stream }),
      64_000,
    );

    await encoder.start();
    await expect(encoder.start()).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    const firstFinalize = encoder.finalize();
    const secondFinalize = encoder.finalize();
    expect(secondFinalize).toBe(firstFinalize);
    await firstFinalize;
    await encoder.cancel('too late');

    expect(fake.drain).toHaveBeenCalledTimes(1);
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(destination.closed).toBe(true);
    expect(destination.aborted).toBeUndefined();
  });

  it('rejects finalize and write in invalid or concurrently active states', async () => {
    const beforeStart = createFakeWasm();
    const beforeStartModule = await importEncoderWithWasm(beforeStart.wasm);
    const pending = await beforeStartModule.createOggOpusStreamEncoder(
      createConfiguration(),
      64_000,
    );
    await expect(pending.finalize()).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    await expect(pending.write(new Float32Array(2), 0)).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    await pending.cancel();

    const page = new Uint8Array(27);
    const active = createFakeWasm({ pullResults: [0, page, 0] });
    const activeModule = await importEncoderWithWasm(active.wasm);
    const outputWrite = deferred<void>();
    let writeStarted = false;
    const writable = new WritableStream<AudioStreamOutputChunk>({
      write() {
        writeStarted = true;
        return outputWrite.promise;
      },
    });
    const encoder = await activeModule.createOggOpusStreamEncoder(
      createConfiguration({ writable }),
      64_000,
    );
    await encoder.start();
    const write = encoder.write(new Float32Array(2), 0);
    await vi.waitFor(() => expect(writeStarted).toBe(true));

    await expect(encoder.finalize()).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: expect.stringContaining('writing'),
    });
    await expect(encoder.write(new Float32Array(2), 0)).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: expect.stringContaining('writing'),
    });
    outputWrite.resolve(undefined);
    await write;
    await encoder.cancel();
  });

  it('aborts and unlocks after drain, EOS, and native write failures', async () => {
    for (const options of [
      { drainResult: -13 },
      { eosSeen: 0 },
      { writeResult: -11 },
    ]) {
      const fake = createFakeWasm(options);
      const module = await importEncoderWithWasm(fake.wasm);
      const destination = createDestination();
      const encoder = await module.createOggOpusStreamEncoder(
        createConfiguration({ writable: destination.stream }),
        64_000,
      );
      await encoder.start();

      const operation =
        options.writeResult === undefined
          ? encoder.finalize()
          : encoder.write(new Float32Array(2), 0);
      await expect(operation).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
      expect(destination.stream.locked).toBe(false);
      expect(fake.destroy).toHaveBeenCalledWith(1);
    }
  });

  it('rejects an unsafe cumulative frame count before touching native PCM', async () => {
    const fake = createFakeWasm();
    const module = await importEncoderWithWasm(fake.wasm);
    const encoder = await module.createOggOpusStreamEncoder(
      createConfiguration(),
      64_000,
    );
    await encoder.start();
    vi.spyOn(Number, 'isSafeInteger')
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(encoder.write(new Float32Array(2), 0)).rejects.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      reason: 'target-size-limit',
    });
    expect(fake.write).not.toHaveBeenCalled();
    await encoder.cancel();
  });

  it.each([499, 512_001, 64_000.5])(
    'rejects invalid bitrate %s before loading native state',
    async (bitrate) => {
      await expect(
        createOggOpusStreamEncoder(createConfiguration(), bitrate),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    },
  );

  it.each([0, 1.5])('rejects invalid outputChunkBytes %s', async (bytes) => {
    await expect(
      createOggOpusStreamEncoder(
        createConfiguration({ outputChunkBytes: bytes }),
        64_000,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
  });
});

interface FakeWasmOptions {
  readonly createHandle?: number;
  readonly drainResult?: number;
  readonly eosSeen?: number;
  readonly maxPageBytes?: number;
  readonly pageLength?: number;
  readonly pagePointer?: number;
  readonly pcmCapacityFrames?: number;
  readonly pcmPointer?: number;
  readonly pullResults?: readonly (number | Uint8Array<ArrayBuffer>)[];
  readonly writeResult?: number;
}

function createFakeWasm(options: FakeWasmOptions = {}): {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly drain: ReturnType<typeof vi.fn>;
  readonly wasm: OggOpusWasmExports;
  readonly write: ReturnType<typeof vi.fn>;
} {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const pagePointer = options.pagePointer ?? 8_192;
  const pullResults = [...(options.pullResults ?? [])];
  let currentPage = new Uint8Array(27);
  const destroy = vi.fn();
  const drain = vi.fn(() => options.drainResult ?? 0);
  const write = vi.fn(() => options.writeResult ?? 0);
  const wasm = {
    memory,
    wasm_ogg_opus_create: vi.fn(() => options.createHandle ?? 1),
    wasm_ogg_opus_destroy: destroy,
    wasm_ogg_opus_drain: drain,
    wasm_ogg_opus_eos_seen: vi.fn(() => options.eosSeen ?? 1),
    wasm_ogg_opus_last_create_error: vi.fn(() => -17),
    wasm_ogg_opus_max_page_bytes: vi.fn(
      () => options.maxPageBytes ?? OGG_OPUS_MAX_PAGE_BYTES,
    ),
    wasm_ogg_opus_page: vi.fn(() => pagePointer),
    wasm_ogg_opus_page_length: vi.fn(
      () => options.pageLength ?? currentPage.byteLength,
    ),
    wasm_ogg_opus_pcm: vi.fn(() => options.pcmPointer ?? 8),
    wasm_ogg_opus_pcm_capacity_frames: vi.fn(
      () => options.pcmCapacityFrames ?? 960,
    ),
    wasm_ogg_opus_pull_page: vi.fn(() => {
      const result = pullResults.shift() ?? 0;
      if (result instanceof Uint8Array) {
        currentPage = result;
        new Uint8Array(memory.buffer).set(result, pagePointer);
        return 1;
      }
      return result;
    }),
    wasm_ogg_opus_write: write,
  } as unknown as OggOpusWasmExports;
  return { destroy, drain, wasm, write };
}

async function importEncoderWithWasm(
  wasm: OggOpusWasmExports,
) {
  vi.resetModules();
  vi.doMock('./ogg-opus-wasm-runtime.js', () => ({
    createOggOpusWasmInstantiator:
      runtimeFactoryMocks.createInstantiator.mockReturnValue(
        vi.fn().mockResolvedValue(wasm),
      ),
  }));
  const module = await import('./ogg-opus-stream-encoder.js');
  return {
    ...module,
    createOggOpusStreamEncoder: module.createOggOpusStreamEncoderFactory(
      async () => new Uint8Array(),
    ),
  };
}

async function importEncoderWithRuntimeFailure(
  failure: unknown,
) {
  vi.resetModules();
  vi.doMock('./ogg-opus-wasm-runtime.js', () => ({
    createOggOpusWasmInstantiator: vi
      .fn()
      .mockReturnValue(vi.fn().mockRejectedValue(failure)),
  }));
  const module = await import('./ogg-opus-stream-encoder.js');
  return {
    ...module,
    createOggOpusStreamEncoder: module.createOggOpusStreamEncoderFactory(
      async () => new Uint8Array(),
    ),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function encode(
  samples: Float32Array,
  channels: number,
  bitrateBps: number,
  outputChunkBytes: number,
): Promise<{
  bytes: Uint8Array<ArrayBuffer>;
  bytesWritten: number;
  writes: readonly AudioStreamOutputChunk[];
}> {
  const destination = createDestination();
  const encoder = await createOggOpusStreamEncoder(
    createConfiguration({
      channels,
      outputChunkBytes,
      writable: destination.stream,
    }),
    bitrateBps,
  );
  await encoder.start();
  await encoder.write(samples, 0);
  await encoder.finalize();
  return {
    bytes: destination.bytes(),
    bytesWritten: encoder.getBytesWritten(),
    writes: destination.writes,
  };
}

function createConfiguration(
  overrides: Partial<AudioStreamEncoderConfiguration> = {},
): AudioStreamEncoderConfiguration {
  return {
    channels: 2,
    outputChunkBytes: 64 * 1024,
    preset: {
      bitDepth: null,
      container: 'ogg',
      extension: 'ogg',
      id: 'ogg-opus-128kbps',
      mimeType: 'audio/ogg',
      sampleFormat: 'lossy',
    },
    rf64: null,
    sampleRate: 48_000,
    writable: new WritableStream<AudioStreamOutputChunk>(),
    ...overrides,
  };
}

function createDestination(): {
  readonly aborted: unknown;
  bytes(): Uint8Array<ArrayBuffer>;
  readonly closed: boolean;
  readonly stream: WritableStream<AudioStreamOutputChunk>;
  readonly writes: AudioStreamOutputChunk[];
} {
  let aborted: unknown;
  let closed = false;
  let bytes = new Uint8Array(0);
  const writes: AudioStreamOutputChunk[] = [];
  const stream = new WritableStream<AudioStreamOutputChunk>({
    abort(reason) {
      aborted = reason;
    },
    close() {
      closed = true;
    },
    write(chunk) {
      writes.push({
        data: Uint8Array.from(chunk.data),
        position: chunk.position,
        type: 'write',
      });
      const required = chunk.position + chunk.data.byteLength;
      if (bytes.byteLength < required) {
        const grown = new Uint8Array(required);
        grown.set(bytes);
        bytes = grown;
      }
      bytes.set(chunk.data, chunk.position);
    },
  });
  return {
    get aborted() {
      return aborted;
    },
    bytes: () => bytes,
    get closed() {
      return closed;
    },
    stream,
    writes,
  };
}

interface ParsedOggPage {
  readonly body: Uint8Array<ArrayBuffer>;
  readonly bytes: number;
  readonly flags: number;
  readonly granule: bigint;
  readonly sequence: number;
  readonly serial: number;
}

function parseOggPages(bytes: Uint8Array<ArrayBuffer>): ParsedOggPage[] {
  const pages: ParsedOggPage[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    expect(new TextDecoder().decode(bytes.subarray(offset, offset + 4))).toBe(
      'OggS',
    );
    const segments = bytes[offset + 26]!;
    const headerBytes = 27 + segments;
    let bodyBytes = 0;
    for (let index = 0; index < segments; index += 1) {
      bodyBytes += bytes[offset + 27 + index]!;
    }
    const pageBytes = headerBytes + bodyBytes;
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset,
      pageBytes,
    );
    pages.push({
      body: bytes.slice(offset + headerBytes, offset + pageBytes),
      bytes: pageBytes,
      flags: bytes[offset + 5]!,
      granule: view.getBigInt64(6, true),
      sequence: view.getUint32(18, true),
      serial: view.getUint32(14, true),
    });
    offset += pageBytes;
  }
  expect(offset).toBe(bytes.byteLength);
  return pages;
}
