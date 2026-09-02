import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  AudioTranscoderCustomStreamWorkerRuntimeOptions,
  AudioTranscoderDefaultStreamWorkerRuntimeOptions,
  AudioStreamInputSupportResult,
  AudioStreamInspection,
  AudioStreamOutputChunk,
  AudioStreamOutputSupportResult,
  AudioStreamProgress,
  AudioStreamTranscodeResult,
  AudioTranscoderStreamWorkerRuntimeOptions,
  CreateAudioTranscoderStreamWorkerEngineOptions,
} from "./contracts.js";
import { createAudioTranscoderStreamWorkerEngine } from "./client.js";
import type {
  AudioStreamWorkerRequest,
  AudioStreamWorkerResponse,
} from "./protocol.js";
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from "./capabilities.js";
import type { AudioTranscoderStreamCapabilities } from "./capabilities.js";
import { AUDIO_TRANSCODER_VERSION } from "../package-metadata.js";
import { AudioTranscoderError } from "../errors.js";

const INSPECTION: AudioStreamInspection = {
  bitDepth: 24,
  channels: 1,
  codec: "pcm-s24",
  container: "WAVE",
  decodeSupport: "built-in",
  durationSeconds: 1,
  notes: [],
  sampleRate: 48_000,
  size: 100,
  sourceEncoding: {
    bitDepth: 24,
    endianness: "little",
    kind: "pcm",
    sampleFormat: "integer",
    signedness: "signed",
  },
};
const PRESET = {
  bitDepth: 16,
  container: "wav",
  extension: "wav",
  id: "wav-pcm16",
  mimeType: "audio/wav",
  sampleFormat: "integer" as const,
};
const RESULT: AudioStreamTranscodeResult = {
  bytesWritten: 64,
  channels: 1,
  details: { format: "wav", rf64: false },
  durationSeconds: 1,
  format: "wav",
  preset: PRESET,
  rf64: false,
  sampleRate: 48_000,
};
const PROGRESS: AudioStreamProgress = {
  durationSeconds: 1,
  phase: "decode",
  processedSeconds: 0.5,
  progress: 0.49,
};
const SUPPORTED_INPUT: AudioStreamInputSupportResult = {
  inspection: INSPECTION,
  status: "supported",
};
const SUPPORTED_OUTPUT: AudioStreamOutputSupportResult = {
  code: "SUPPORTED",
  message: "The output runtime probe succeeded.",
  reason: "runtime-verified",
  status: "supported",
};
const TEST_CODEC_ASSETS = Object.freeze({
  source: Object.freeze({
    baseUrl: "/codec-assets",
    kind: "self-hosted" as const,
  }),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stream worker client", () => {
  it("passes a serializable HTTP input descriptor across the Worker boundary", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const input = {
      http: {
        credentials: "include" as const,
        headers: { Authorization: "Bearer source-ticket" },
        size: 12_345,
        url: "https://example.test/api/tools/youtube-audio/source",
      },
      name: "source.m4a",
    };
    const result = engine.inspect(input);

    expect(worker.posts).toEqual([
      {
        message: {
          id: 1,
          input,
          options: {},
          type: "inspect",
        },
        transfer: [],
      },
    ]);
    worker.emit({
      id: 1,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await expect(result).resolves.toEqual(INSPECTION);
    await engine.dispose();
  });

  it("serializes operations and transfers output only when its turn starts", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const input = { blob: new Blob(["audio"]), name: "source.wav" };
    const onProgress = vi.fn();
    const inspection = engine.inspect(input, { inputReadBytes: 65_536 });
    const output = new WritableStream();
    const transcode = engine.transcode(
      input,
      { presetId: "wav-pcm16" },
      output,
      {
        maxOutputBytes: 4 * 1024 * 1024,
        onProgress,
        outputChunkBytes: 65_536,
        pcmChunkBytes: 131_072,
      },
    );

    expect(engine.getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
    expect(engine.getInfo().version).toBe(AUDIO_TRANSCODER_VERSION);
    expect(engine.getCapabilities().limits.recommendedConcurrency).toBe(1);
    expect(worker.posts).toHaveLength(1);
    expect(worker.posts[0]).toMatchObject({
      message: {
        id: 1,
        options: { inputReadBytes: 65_536 },
        type: "inspect",
      },
      transfer: [],
    });
    worker.emit({
      id: 999,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    worker.emit({
      id: 1,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    const inspected = await inspection;
    expect(inspected).toEqual(INSPECTION);
    expect(inspected).not.toBe(INSPECTION);
    expect(Object.isFrozen(inspected)).toBe(true);
    expect(Object.isFrozen(inspected.notes)).toBe(true);
    expect(Object.isFrozen(inspected.sourceEncoding)).toBe(true);

    expect(worker.posts[1]?.message).toMatchObject({
      id: 2,
      options: {
        maxOutputBytes: 4 * 1024 * 1024,
        outputChunkBytes: 65_536,
        pcmChunkBytes: 131_072,
      },
      type: "transcode",
    });
    expect(worker.posts[1]?.transfer).toHaveLength(1);
    expect(worker.posts[1]?.transfer[0]).not.toBe(output);
    expect(worker.posts[1]?.message).toMatchObject({
      output: worker.posts[1]?.transfer[0],
    });
    worker.emit({ id: 2, progress: PROGRESS, type: "progress" });
    await worker.closePostedOutput(2);
    worker.emit({
      id: 2,
      operation: "transcode",
      type: "result",
      value: RESULT,
    });
    const converted = await transcode;
    expect(onProgress).toHaveBeenCalledWith(PROGRESS);
    expect(Object.isFrozen(onProgress.mock.calls[0]?.[0])).toBe(true);
    expect(converted).toEqual(RESULT);
    expect(converted).not.toBe(RESULT);
    expect(Object.isFrozen(converted)).toBe(true);
    expect(Object.isFrozen(converted.preset)).toBe(true);
    expect(output.locked).toBe(false);
    engine.terminate();
  });

  it("probes concrete input support through the Worker and freezes results", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const input = { blob: new Blob(["audio"]), name: "candidate.mp3" };
    const supported = engine.probeInputSupport(input, {
      inputReadBytes: 65_536,
    });

    expect(worker.posts[0]).toMatchObject({
      message: {
        id: 1,
        input,
        options: { inputReadBytes: 65_536 },
        type: "probeInputSupport",
      },
      transfer: [],
    });
    worker.emit({
      id: 1,
      operation: "probeInputSupport",
      type: "result",
      value: SUPPORTED_INPUT,
    });
    const supportedResult = await supported;
    expect(supportedResult).toEqual(SUPPORTED_INPUT);
    if (supportedResult.status !== "supported") {
      throw new Error("Expected supported input result.");
    }
    expect(supportedResult).not.toBe(SUPPORTED_INPUT);
    expect(Object.isFrozen(supportedResult)).toBe(true);
    expect(Object.isFrozen(supportedResult.inspection)).toBe(true);
    expect(Object.isFrozen(supportedResult.inspection.notes)).toBe(true);
    expect(Object.isFrozen(supportedResult.inspection.sourceEncoding)).toBe(
      true,
    );

    const { sourceEncoding, ...legacyInspection } = INSPECTION;
    expect(sourceEncoding).toBeDefined();
    const legacy = engine.probeInputSupport(input);
    worker.emit({
      id: 2,
      operation: "probeInputSupport",
      type: "result",
      value: {
        inspection: legacyInspection,
        status: "supported",
      },
    });
    const legacyResult = await legacy;
    expect(legacyResult.inspection?.sourceEncoding).toEqual({
      kind: "unknown",
    });
    expect(Object.isFrozen(legacyResult.inspection?.sourceEncoding)).toBe(true);

    const unsupported = engine.probeInputSupport(input);
    worker.emit({
      id: 3,
      operation: "probeInputSupport",
      type: "result",
      value: { inspection: null, status: "unsupported" },
    });
    await expect(unsupported).resolves.toEqual({
      inspection: null,
      status: "unsupported",
    });
    engine.terminate();
  });

  it("coalesces, freezes, and caches exact runtime output probes", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const target = {
      channels: 2,
      presetId: "wav-pcm16" as const,
      sampleRate: 48_000,
    };
    const first = engine.probeOutputSupport(target);
    const second = engine.probeOutputSupport(target);
    await flushMicrotasks();

    expect(worker.posts).toEqual([
      {
        message: { id: 1, target, type: "probeOutputSupport" },
        transfer: [],
      },
    ]);
    worker.emit({
      id: 1,
      operation: "probeOutputSupport",
      type: "result",
      value: SUPPORTED_OUTPUT,
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(SUPPORTED_OUTPUT);
    expect(firstResult).toBe(secondResult);
    expect(firstResult).not.toBe(SUPPORTED_OUTPUT);
    expect(Object.isFrozen(firstResult)).toBe(true);
    await expect(engine.probeOutputSupport(target)).resolves.toBe(firstResult);
    expect(worker.posts).toHaveLength(1);
    engine.terminate();
  });

  it("returns static output mismatches without posting to the Worker", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);

    await expect(
      engine.probeOutputSupport({
        channels: 2,
        presetId: "mp3-320kbps",
        sampleRate: 24_000,
      }),
    ).resolves.toMatchObject({
      reason: "sample-rate",
      status: "unsupported-configuration",
    });
    expect(worker.posts).toHaveLength(0);
    engine.terminate();
  });

  it("cancels output-probe subscribers independently and aborts shared work last", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const target = {
      channels: 2,
      presetId: "wav-pcm16" as const,
      sampleRate: 48_000,
    };
    const firstController = new AbortController();
    const first = engine.probeOutputSupport(target, {
      signal: firstController.signal,
    });
    const retained = engine.probeOutputSupport(target);
    const firstAssertion = expect(first).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
    });
    await flushMicrotasks();
    firstController.abort("first stopped");
    await firstAssertion;
    expect(worker.posts).toHaveLength(1);

    worker.emit({
      id: 1,
      operation: "probeOutputSupport",
      type: "result",
      value: SUPPORTED_OUTPUT,
    });
    await expect(retained).resolves.toMatchObject({ status: "supported" });

    const otherTarget = { ...target, sampleRate: 44_100 };
    const lastController = new AbortController();
    const last = engine.probeOutputSupport(otherTarget, {
      signal: lastController.signal,
    });
    const lastAssertion = expect(last).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
    });
    await flushMicrotasks();
    lastController.abort("last stopped");
    await lastAssertion;
    expect(worker.posts.at(-1)?.message).toEqual({ id: 2, type: "cancel" });
    worker.emit({
      error: {
        code: "OPERATION_ABORTED",
        message: "last stopped",
        name: "AudioTranscoderError",
      },
      id: 2,
      type: "error",
    });
    await Promise.resolve();
    engine.terminate();
  });

  it("rejects output-probe queue errors and never serves cached support after termination", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, { maxQueued: 0 });
    const active = engine.inspect({ blob: new Blob(["active"]) });

    await expect(
      engine.probeOutputSupport({
        channels: 2,
        presetId: "wav-pcm16",
        sampleRate: 48_000,
      }),
    ).rejects.toMatchObject({ code: "QUEUE_CAPACITY_EXCEEDED" });
    worker.emit({
      id: 1,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await active;

    const probe = engine.probeOutputSupport({
      channels: 2,
      presetId: "wav-pcm16",
      sampleRate: 48_000,
    });
    await flushMicrotasks();
    worker.emit({
      id: 2,
      operation: "probeOutputSupport",
      type: "result",
      value: SUPPORTED_OUTPUT,
    });
    await probe;
    engine.terminate();
    await expect(
      engine.probeOutputSupport({
        channels: 2,
        presetId: "wav-pcm16",
        sampleRate: 48_000,
      }),
    ).rejects.toMatchObject({ code: "WORKER_TERMINATED" });
    expect(worker.posts).toHaveLength(2);
  });

  it("returns the capability manifest supplied for a custom Worker runtime", () => {
    const worker = new WorkerStub();
    const capabilities = {
      ...AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      limits: {
        ...AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits,
        recommendedConcurrency: 2,
      },
    };
    const engine = createAudioTranscoderStreamWorkerEngine({
      capabilities,
      runtime: "custom",
      workerFactory: () => worker as unknown as Worker,
    });

    worker.emit({
      state: {
        assetName: "ignored-custom-runtime-state",
        error: null,
        loadedBytes: 0,
        phase: "idle",
        totalBytes: null,
      },
      type: "asset-state",
    });
    expect(engine.getCapabilities()).toBe(capabilities);
    expect(worker.terminateCalls).toBe(0);
    engine.terminate();
  });

  it("keeps custom entries for the default runtime type-safe", () => {
    type Factory = () => Worker;

    expectTypeOf<{}>().not.toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<{
      workerFactory: Factory;
    }>().not.toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<{
      codecAssets: typeof TEST_CODEC_ASSETS;
      workerFactory: Factory;
    }>().toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<{
      runtime: "custom";
      capabilities: AudioTranscoderStreamCapabilities;
      workerFactory: Factory;
    }>().toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<{
      capabilities: AudioTranscoderStreamCapabilities;
    }>().not.toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<{
      capabilities: AudioTranscoderStreamCapabilities;
      workerFactory: Factory;
    }>().not.toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<{
      runtime: "custom";
      capabilities: AudioTranscoderStreamCapabilities;
    }>().not.toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<{
      runtime: "custom";
      workerFactory: Factory;
    }>().not.toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<
      AudioTranscoderStreamWorkerRuntimeOptions<Factory>
    >().toMatchTypeOf<
      | AudioTranscoderCustomStreamWorkerRuntimeOptions<Factory>
      | AudioTranscoderDefaultStreamWorkerRuntimeOptions<Factory>
    >();
  });

  it("uses built-in capabilities with a custom default-runtime entry", () => {
    const worker = new WorkerStub();
    const workerFactory = vi.fn(() => worker as unknown as Worker);
    const engine = createAudioTranscoderStreamWorkerEngine({
      codecAssets: TEST_CODEC_ASSETS,
      workerFactory,
    });

    expect(workerFactory).toHaveBeenCalledOnce();
    expect(engine.getCapabilities()).toBe(AUDIO_TRANSCODER_STREAM_CAPABILITIES);
    engine.terminate();
  });

  it("configures explicit asset sources and reports verified loading state", async () => {
    const worker = new WorkerStub();
    const onStateChange = vi.fn();
    const engine = createAudioTranscoderStreamWorkerEngine({
      codecAssets: {
        fallbackSources: [{ baseUrl: "/codec-fallback", kind: "self-hosted" }],
        onStateChange,
        source: { baseUrl: "/codec-primary", kind: "self-hosted" },
      },
      workerFactory: () => worker as unknown as Worker,
    });

    expect(worker.configurations).toEqual([
      {
        codecAssets: {
          fallbackSources: [
            { baseUrl: "/codec-fallback", kind: "self-hosted" },
          ],
          source: { baseUrl: "/codec-primary", kind: "self-hosted" },
        },
        type: "configure",
      },
    ]);
    worker.emit({ type: "configured" });
    worker.emit({
      state: {
        assetName: "aac",
        error: null,
        loadedBytes: 4,
        phase: "ready",
        totalBytes: 4,
      },
      type: "asset-state",
    });
    worker.emit({
      state: {
        assetName: "ogg-opus",
        error: { code: "INTEGRITY_MISMATCH", message: "digest mismatch" },
        loadedBytes: 4,
        phase: "error",
        totalBytes: 4,
      },
      type: "asset-state",
    });

    expect(onStateChange).toHaveBeenCalledTimes(2);
    expect(onStateChange.mock.calls[0]?.[0]).toEqual({
      assetName: "aac",
      error: null,
      loadedBytes: 4,
      phase: "ready",
      totalBytes: 4,
    });
    expect(onStateChange.mock.calls[1]?.[0]).toMatchObject({
      assetName: "ogg-opus",
      error: { code: "INTEGRITY_MISMATCH", message: "digest mismatch" },
      phase: "error",
    });
    expect(Object.isFrozen(onStateChange.mock.calls[1]?.[0])).toBe(true);
    engine.terminate();
    await engine.dispose();
  });

  it("snapshots an exact jsDelivr asset source for Worker configuration", async () => {
    const worker = new WorkerStub();
    const engine = createAudioTranscoderStreamWorkerEngine({
      codecAssets: {
        source: {
          kind: "jsdelivr",
          packageName: "@echovisionlab/audio-transcoder-codecs",
          packageVersion: "1.2.3",
        },
      },
      workerFactory: () => worker as unknown as Worker,
    });

    expect(worker.configurations).toEqual([
      {
        codecAssets: {
          source: {
            kind: "jsdelivr",
            packageName: "@echovisionlab/audio-transcoder-codecs",
            packageVersion: "1.2.3",
          },
        },
        type: "configure",
      },
    ]);
    await engine.dispose();
  });

  it("snapshots an exact jsDelivr GitHub asset source for Worker configuration", async () => {
    const worker = new WorkerStub();
    const engine = createAudioTranscoderStreamWorkerEngine({
      codecAssets: {
        source: {
          basePath: "codec-assets",
          kind: "jsdelivr-github",
          repository: "echovisionlab/audio-transcoder",
          tag: "v1.2.3",
        },
      },
      workerFactory: () => worker as unknown as Worker,
    });

    expect(worker.configurations).toEqual([
      {
        codecAssets: {
          source: {
            basePath: "codec-assets",
            kind: "jsdelivr-github",
            repository: "echovisionlab/audio-transcoder",
            tag: "v1.2.3",
          },
        },
        type: "configure",
      },
    ]);
    await engine.dispose();
  });

  it("isolates asset-state observers and terminates on configuration errors", async () => {
    const worker = new WorkerStub();
    const engine = createAudioTranscoderStreamWorkerEngine({
      codecAssets: {
        onStateChange() {
          throw new Error("observer failure");
        },
        source: TEST_CODEC_ASSETS.source,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    const inspection = engine.inspect({ blob: new Blob(["audio"]) });
    worker.emit({
      state: {
        assetName: "aac",
        error: null,
        loadedBytes: 0,
        phase: "downloading",
        totalBytes: null,
      },
      type: "asset-state",
    });
    worker.emit({
      error: {
        code: "INVALID_CONFIGURATION",
        message: "asset ABI mismatch",
        name: "AudioTranscoderError",
      },
      type: "configuration-error",
    });

    await expect(inspection).rejects.toMatchObject({
      code: "WORKER_FAILURE",
      message: expect.stringContaining("asset ABI mismatch"),
    });
    expect(worker.terminateCalls).toBe(1);
  });

  it.each([new Error("clone failed"), "clone rejected"])(
    "fails construction if Worker configuration cannot be posted %#",
    (failure) => {
      const worker = new WorkerStub();
      worker.throwOnConfigure = failure;

      expect(() =>
        createAudioTranscoderStreamWorkerEngine({
          codecAssets: TEST_CODEC_ASSETS,
          workerFactory: () => worker as unknown as Worker,
        }),
      ).toThrow(
        expect.objectContaining({
          code: "WORKER_FAILURE",
          message: expect.stringContaining(
            failure instanceof Error ? failure.message : String(failure),
          ),
        }),
      );
      expect(worker.terminateCalls).toBe(1);
    },
  );

  it("rejects invalid runtime and capability combinations from JavaScript", () => {
    const workerFactory = vi.fn(() => new WorkerStub() as unknown as Worker);
    const nonErrorSource = Object.defineProperty({}, "kind", {
      get() {
        throw "non-error source failure";
      },
    });
    const capabilities = {
      ...AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      codecRuntime: {
        ...AUDIO_TRANSCODER_STREAM_CAPABILITIES.codecRuntime,
        encoderAdapter: "custom-runtime",
      },
    };
    const invalidOptions: unknown[] = [
      null,
      1,
      { runtime: "unknown" },
      { workerFactory: 1 },
      { codecAssets: null, workerFactory },
      { codecAssets: { source: undefined }, workerFactory },
      { codecAssets: { source: nonErrorSource }, workerFactory },
      {
        codecAssets: {
          source: {
            kind: "jsdelivr",
            packageName: 1,
            packageVersion: "1.2.3",
          },
        },
        workerFactory,
      },
      {
        codecAssets: {
          source: {
            basePath: "codec-assets",
            kind: "jsdelivr-github",
            repository: 1,
            tag: "v1.2.3",
          },
        },
        workerFactory,
      },
      {
        codecAssets: {
          source: {
            basePath: 1,
            kind: "jsdelivr-github",
            repository: "echovisionlab/audio-transcoder",
            tag: "v1.2.3",
          },
        },
        workerFactory,
      },
      {
        codecAssets: {
          source: {
            basePath: "codec-assets",
            kind: "jsdelivr-github",
            repository: "echovisionlab/audio-transcoder",
            tag: 1,
          },
        },
        workerFactory,
      },
      {
        codecAssets: {
          source: {
            kind: "jsdelivr",
            packageName: "@echovisionlab/audio-transcoder-codecs",
            packageVersion: 1,
          },
        },
        workerFactory,
      },
      {
        codecAssets: { source: { baseUrl: 1, kind: "self-hosted" } },
        workerFactory,
      },
      {
        codecAssets: { source: { kind: "unknown" } },
        workerFactory,
      },
      {
        codecAssets: { onStateChange: 1, source: TEST_CODEC_ASSETS.source },
        workerFactory,
      },
      {
        codecAssets: { fallbackSources: {}, source: TEST_CODEC_ASSETS.source },
        workerFactory,
      },
      { capabilities, workerFactory },
      { capabilities, runtime: "default", workerFactory },
      { capabilities, runtime: "custom" },
      { runtime: "custom", workerFactory },
      { capabilities: null, runtime: "custom", workerFactory },
      { capabilities: {}, runtime: "custom", workerFactory },
      { capabilities: { limits: null }, runtime: "custom", workerFactory },
      { capabilities: { limits: 1 }, runtime: "custom", workerFactory },
      {
        capabilities,
        codecAssets: TEST_CODEC_ASSETS,
        runtime: "custom",
        workerFactory,
      },
    ];

    for (const options of invalidOptions) {
      expect(() =>
        createAudioTranscoderStreamWorkerEngine(
          options as CreateAudioTranscoderStreamWorkerEngineOptions,
        ),
      ).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    }
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it("waits for the destination close before settling or draining", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    let finishClose = (): void => undefined;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const output = new WritableStream({ close: () => closeGate });
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      output,
    );
    const next = engine.inspect({ blob: new Blob(["b"]) });
    const close = worker.closePostedOutput(1);
    worker.emit({
      id: 1,
      operation: "transcode",
      type: "result",
      value: RESULT,
    });
    worker.emit({
      id: 1,
      operation: "transcode",
      type: "result",
      value: RESULT,
    });
    const settled = vi.fn();
    void result.then(settled, settled);
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(1);
    finishClose();
    await close;
    await expect(result).resolves.toMatchObject({ bytesWritten: 64 });
    expect(worker.posts[1]?.message).toMatchObject({ id: 2, type: "inspect" });
    worker.emit({
      id: 2,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await next;
    engine.terminate();
  });

  it("forwards output writes and rejects destination write failures", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const writes: AudioStreamOutputChunk[] = [];
    const successful = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      new WritableStream({
        write: (chunk) => {
          writes.push(chunk);
        },
      }),
    );
    const chunk: AudioStreamOutputChunk = {
      data: new Uint8Array([1, 2, 3]),
      position: 4,
      type: "write",
    };
    await worker.writePostedOutput(1, chunk);
    await worker.closePostedOutput(1);
    worker.emit({
      id: 1,
      operation: "transcode",
      type: "result",
      value: RESULT,
    });
    await successful;
    expect(writes).toEqual([chunk]);

    const writeError = new Error("destination write failed");
    const failed = engine.transcode(
      { blob: new Blob(["b"]) },
      { presetId: "wav-pcm16" },
      new WritableStream({
        write() {
          throw writeError;
        },
      }),
    );
    await expect(worker.writePostedOutput(2, chunk)).rejects.toBe(writeError);
    worker.emit({
      id: 2,
      operation: "transcode",
      type: "result",
      value: RESULT,
    });
    await expect(failed).rejects.toBe(writeError);
    engine.terminate();
  });

  it("propagates destination close failures", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const closeError = new AudioTranscoderError(
      "RESOURCE_LIMIT_EXCEEDED",
      "destination close failed",
    );
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      new WritableStream({
        close() {
          throw closeError;
        },
      }),
    );

    await worker.closePostedOutput(1);
    worker.emit({
      id: 1,
      operation: "transcode",
      type: "result",
      value: RESULT,
    });
    await expect(result).rejects.toBe(closeError);
    engine.terminate();
  });

  it("restores a local destination error from its code-less Worker clone", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const writeError = new AudioTranscoderError(
      "RESOURCE_LIMIT_EXCEEDED",
      "destination quota exceeded",
    );
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      new WritableStream<AudioStreamOutputChunk>({
        write() {
          throw writeError;
        },
      }),
    );

    await expect(
      worker.writePostedOutput(1, {
        data: new Uint8Array([1]),
        position: 0,
        type: "write",
      }),
    ).rejects.toBe(writeError);
    worker.emit({
      error: { message: writeError.message, name: "Error" },
      id: 1,
      type: "error",
    });

    await expect(result).rejects.toBe(writeError);
    await engine.dispose();
  });

  it("restores a primitive destination reason from its Worker representation", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const writeReason = "destination quota exceeded";
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      new WritableStream<AudioStreamOutputChunk>({
        write() {
          throw writeReason;
        },
      }),
    );

    await expect(
      worker.writePostedOutput(1, {
        data: new Uint8Array([1]),
        position: 0,
        type: "write",
      }),
    ).rejects.toBe(writeReason);
    worker.emit({
      error: { message: writeReason, name: "Error" },
      id: 1,
      type: "error",
    });

    await expect(result).rejects.toBe(writeReason);
    await engine.dispose();
  });

  it("restores the original opaque destination rejection from its Worker clone", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const writeReason = { message: "destination quota exceeded" };
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      new WritableStream<AudioStreamOutputChunk>({
        write() {
          throw writeReason;
        },
      }),
    );

    await expect(
      worker.writePostedOutput(1, {
        data: new Uint8Array([1]),
        position: 0,
        type: "write",
      }),
    ).rejects.toBe(writeReason);
    worker.emit({
      error: { message: writeReason.message, name: "Error" },
      id: 1,
      type: "error",
    });

    await expect(result).rejects.toBe(writeReason);
    await engine.dispose();
  });

  it("preserves a classified target-size Worker error across the client boundary", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const result = engine.inspect({ blob: new Blob(["a"]) });

    worker.emit({
      error: {
        code: "UNSUPPORTED_OUTPUT",
        message: "RIFF cannot represent this output",
        name: "AudioTranscoderError",
        reason: "target-size-limit",
      },
      id: 1,
      type: "error",
    });

    await expect(result).rejects.toMatchObject({
      code: "UNSUPPORTED_OUTPUT",
      message: "RIFF cannot represent this output",
      name: "AudioTranscoderError",
      reason: "target-size-limit",
    });
    await engine.dispose();
  });

  it("preserves unknown Worker Error diagnostics without inventing a classification", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const result = engine.inspect({ blob: new Blob(["a"]) });
    const stack = "TypeError: codec failed\n    at worker-codec.js:4:2";

    worker.emit({
      error: {
        message: "codec failed",
        name: "TypeError",
        stack,
      },
      id: 1,
      type: "error",
    });

    await expect(result).rejects.toMatchObject({
      message: "codec failed",
      name: "TypeError",
      stack,
    });
    await result.catch((error: unknown) => {
      expect(error).not.toHaveProperty("code");
      expect(error).not.toHaveProperty("reason");
    });
    await engine.dispose();
  });

  it("rejects invalid, locked, and pre-aborted transcode outputs", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    await expect(
      engine.transcode(
        { blob: new Blob(["a"]) },
        { presetId: "wav-pcm16" },
        {} as WritableStream<AudioStreamOutputChunk>,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });

    const locked = new WritableStream<AudioStreamOutputChunk>();
    const writer = locked.getWriter();
    await expect(
      engine.transcode(
        { blob: new Blob(["a"]) },
        { presetId: "wav-pcm16" },
        locked,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    writer.releaseLock();

    const controller = new AbortController();
    controller.abort("already stopped");
    const untouched = new WritableStream<AudioStreamOutputChunk>();
    await expect(
      engine.transcode(
        { blob: new Blob(["a"]) },
        { presetId: "wav-pcm16" },
        untouched,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      message: "already stopped",
    });
    expect(untouched.locked).toBe(false);
    expect(worker.posts).toHaveLength(0);
    engine.terminate();
  });

  it("rejects transcode after termination without locking its destination", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const abort = vi.fn();
    const output = new WritableStream<AudioStreamOutputChunk>({ abort });
    engine.terminate();

    await expect(
      engine.transcode(
        { blob: new Blob(["a"]) },
        { presetId: "wav-pcm16" },
        output,
      ),
    ).rejects.toMatchObject({ code: "WORKER_TERMINATED" });
    expect(output.locked).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(0);
  });

  it("aborts bridged outputs on post failure and ignores abort cleanup errors", async () => {
    const worker = new WorkerStub();
    worker.throwNextOperation = true;
    const engine = createEngine(worker);
    const abortError = new Error("destination abort failed");
    const output = new WritableStream<AudioStreamOutputChunk>({
      abort() {
        throw abortError;
      },
    });
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      output,
    );

    await expect(result).rejects.toThrow("post failed");
    await flushMicrotasks();
    expect(output.locked).toBe(false);
    engine.terminate();
  });

  it("does not settle a failed post twice when disposal wins output cleanup", async () => {
    const worker = new WorkerStub();
    worker.throwNextOperation = true;
    const engine = createEngine(worker);
    const outputAbort = deferred<void>();
    const output = new WritableStream<AudioStreamOutputChunk>({
      abort: () => outputAbort.promise,
    });
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      output,
    );

    const disposal = engine.dispose();
    await expect(result).rejects.toMatchObject({ code: "WORKER_TERMINATED" });
    outputAbort.resolve();
    await disposal;
    expect(output.locked).toBe(false);
  });

  it("ignores late Worker-error settlement after disposal wins abort cleanup", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const abortGate = deferred<void>();
    const abort = vi.fn(() => abortGate.promise);
    const output = new WritableStream<AudioStreamOutputChunk>({ abort });
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      output,
    );
    worker.emit({
      error: { message: "Worker failed first", name: "Error" },
      id: 1,
      type: "error",
    });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());

    const disposal = engine.dispose();
    await expect(result).rejects.toMatchObject({ code: "WORKER_TERMINATED" });
    expect(output.locked).toBe(false);
    abortGate.resolve();
    await disposal;
  });

  it("releases a closed bridge on termination and ignores late settlement", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const closed = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      new WritableStream(),
    );
    await worker.closePostedOutput(1);
    engine.terminate();
    await expect(closed).rejects.toMatchObject({ code: "WORKER_TERMINATED" });

    const failureWorker = new WorkerStub();
    const failureEngine = createEngine(failureWorker);
    const failed = failureEngine.transcode(
      { blob: new Blob(["b"]) },
      { presetId: "wav-pcm16" },
      new WritableStream(),
    );
    failureWorker.emit({
      id: 1,
      operation: "transcode",
      type: "result",
      value: RESULT,
    });
    failureWorker.emitError("worker failed after result");
    await expect(failed).rejects.toMatchObject({ code: "WORKER_FAILURE" });
  });

  it("aborts after Worker-side close when termination wins before result", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const abort = vi.fn();
    const close = vi.fn();
    const output = new WritableStream<AudioStreamOutputChunk>({ abort, close });
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      output,
    );
    await worker.closePostedOutput(1);

    engine.terminate();
    await expect(result).rejects.toMatchObject({ code: "WORKER_TERMINATED" });
    expect(abort).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(output.locked).toBe(false);
  });

  it("lets destination close win after a Worker result starts commit", async () => {
    const firstWorker = new WorkerStub();
    const secondWorker = new WorkerStub();
    const { engine } = createReplacingEngine([firstWorker, secondWorker]);
    const closeGate = deferred<void>();
    const controller = new AbortController();
    const abort = vi.fn();
    const output = new WritableStream<AudioStreamOutputChunk>({
      abort,
      close: () => closeGate.promise,
    });
    const active = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      output,
      { signal: controller.signal },
    );
    const queued = engine.inspect({ blob: new Blob(["b"]) });
    const closing = firstWorker.closePostedOutput(1);
    firstWorker.emit({
      id: 1,
      operation: "transcode",
      type: "result",
      value: RESULT,
    });
    await flushMicrotasks();
    expect(secondWorker.posts).toHaveLength(0);

    controller.abort("stop stuck destination close");

    expect(abort).not.toHaveBeenCalled();
    expect(output.locked).toBe(true);
    expect(firstWorker.terminateCalls).toBe(0);
    expect(secondWorker.posts).toHaveLength(0);
    closeGate.resolve();
    await closing;
    await expect(active).resolves.toMatchObject({ bytesWritten: 64 });
    expect(output.locked).toBe(false);
    expect(firstWorker.posts[1]?.message).toMatchObject({
      id: 2,
      type: "inspect",
    });
    firstWorker.emit({
      id: 2,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await queued;
    await engine.dispose();
  });

  it("waits for an irreversible commit when disposal starts", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const closeGate = deferred<void>();
    const close = vi.fn(() => closeGate.promise);
    const output = new WritableStream<AudioStreamOutputChunk>({ close });
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      output,
    );
    await worker.closePostedOutput(1);
    worker.emit({
      id: 1,
      operation: "transcode",
      type: "result",
      value: RESULT,
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    const disposal = engine.dispose();
    const settled = vi.fn();
    void Promise.all([result, disposal]).then(settled, settled);
    await flushMicrotasks();

    expect(settled).not.toHaveBeenCalled();
    expect(output.locked).toBe(true);
    expect(worker.terminateCalls).toBe(1);
    closeGate.resolve();
    await expect(result).resolves.toMatchObject({ bytesWritten: 64 });
    await disposal;
    expect(output.locked).toBe(false);
  });

  it("keeps a coded Worker error primary when it matches a destination failure", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const writeError = new AudioTranscoderError(
      "RESOURCE_LIMIT_EXCEEDED",
      "write failed first",
    );
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      new WritableStream<AudioStreamOutputChunk>({
        write() {
          throw writeError;
        },
      }),
    );
    await expect(
      worker.writePostedOutput(1, {
        data: new Uint8Array([1]),
        position: 0,
        type: "write",
      }),
    ).rejects.toBe(writeError);
    worker.emit({
      error: {
        code: "INVALID_AUDIO_DATA",
        message: writeError.message,
        name: "AudioTranscoderError",
      },
      id: 1,
      type: "error",
    });

    await expect(result).rejects.toMatchObject({
      code: "INVALID_AUDIO_DATA",
      message: writeError.message,
    });
    await engine.dispose();
  });

  it("restores the original classified destination error when code and reason match", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const writeError = new AudioTranscoderError(
      "RESOURCE_LIMIT_EXCEEDED",
      "destination capacity exceeded",
      { reason: "output-storage-limit" },
    );
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      new WritableStream<AudioStreamOutputChunk>({
        write() {
          throw writeError;
        },
      }),
    );
    await expect(
      worker.writePostedOutput(1, {
        data: new Uint8Array([1]),
        position: 0,
        type: "write",
      }),
    ).rejects.toBe(writeError);
    worker.emit({
      error: {
        code: writeError.code,
        message: writeError.message,
        name: writeError.name,
        reason: "output-storage-limit",
      },
      id: 1,
      type: "error",
    });

    await expect(result).rejects.toBe(writeError);
    await engine.dispose();
  });

  it("keeps a Worker error primary when its message differs from the destination failure", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const writeError = new Error("destination write failed");
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      new WritableStream<AudioStreamOutputChunk>({
        write() {
          throw writeError;
        },
      }),
    );
    await expect(
      worker.writePostedOutput(1, {
        data: new Uint8Array([1]),
        position: 0,
        type: "write",
      }),
    ).rejects.toBe(writeError);
    worker.emit({
      error: {
        message: "worker conversion failed",
        name: "Error",
      },
      id: 1,
      type: "error",
    });

    await expect(result).rejects.toMatchObject({
      message: "worker conversion failed",
      name: "Error",
    });
    await engine.dispose();
  });

  it("keeps a classified Worker error primary over an unclassified destination failure", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const writeError = new Error("shared failure message");
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      new WritableStream<AudioStreamOutputChunk>({
        write() {
          throw writeError;
        },
      }),
    );
    await expect(
      worker.writePostedOutput(1, {
        data: new Uint8Array([1]),
        position: 0,
        type: "write",
      }),
    ).rejects.toBe(writeError);
    worker.emit({
      error: {
        code: "INVALID_AUDIO_DATA",
        message: writeError.message,
        name: "AudioTranscoderError",
      },
      id: 1,
      type: "error",
    });

    await expect(result).rejects.toMatchObject({
      code: "INVALID_AUDIO_DATA",
      message: writeError.message,
    });
    await engine.dispose();
  });

  it("keeps a code-less Worker error primary after a transferred-stream abort", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const remoteAbort = new AudioTranscoderError(
      "RESOURCE_LIMIT_EXCEEDED",
      "remote stream aborted",
    );
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      new WritableStream<AudioStreamOutputChunk>(),
    );

    await worker.abortPostedOutput(1, remoteAbort);
    worker.emit({
      error: { message: remoteAbort.message, name: "Error" },
      id: 1,
      type: "error",
    });

    const rejection = await result.catch((error: unknown) => error);
    expect(rejection).not.toBe(remoteAbort);
    expect(rejection).toMatchObject({
      message: remoteAbort.message,
      name: "Error",
    });
    await engine.dispose();
  });

  it("aborts a queued transcode without posting or retaining its output", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const active = engine.inspect({ blob: new Blob(["a"]) });
    const controller = new AbortController();
    const abort = vi.fn();
    const output = new WritableStream<AudioStreamOutputChunk>({ abort });
    const queued = engine.transcode(
      { blob: new Blob(["b"]) },
      { presetId: "wav-pcm16" },
      output,
      { signal: controller.signal },
    );
    controller.abort("remove output");

    await expect(queued).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      message: "remove output",
    });
    await flushMicrotasks();
    expect(abort).toHaveBeenCalledOnce();
    expect(output.locked).toBe(false);
    expect(worker.posts).toHaveLength(1);
    worker.emit({
      id: 1,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await active;
    engine.terminate();
  });

  it.each([
    [
      {
        code: "UNSUPPORTED_INPUT" as const,
        message: "no codec",
        name: "AudioTranscoderError",
      },
      "AudioTranscoderError",
    ],
    [{ message: "plain error", name: "TypeError" }, "TypeError"],
  ])("deserializes worker errors %#", async (error, name) => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const result = engine.inspect({ blob: new Blob(["x"]) });
    worker.emit({ error, id: 1, type: "error" });
    await expect(result).rejects.toMatchObject({
      message: error.message,
      name,
    });
    engine.terminate();
  });

  it("aborts and unlocks output before draining after a Worker error", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const abort = vi.fn();
    const output = new WritableStream<AudioStreamOutputChunk>({ abort });
    const failed = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      output,
    );
    const next = engine.inspect({ blob: new Blob(["b"]) });

    worker.emit({
      error: { message: "codec failed", name: "Error" },
      id: 1,
      type: "error",
    });

    await expect(failed).rejects.toMatchObject({ message: "codec failed" });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0]?.[0]).toMatchObject({ message: "codec failed" });
    expect(output.locked).toBe(false);
    expect(worker.posts[1]?.message).toMatchObject({ id: 2, type: "inspect" });
    worker.emit({
      id: 2,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await next;
    engine.terminate();
  });

  it("keeps the Worker error primary when destination abort also fails", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const output = new WritableStream<AudioStreamOutputChunk>({
      abort() {
        throw new Error("destination abort failed");
      },
    });
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      output,
    );

    worker.emit({
      error: { message: "codec failed", name: "Error" },
      id: 1,
      type: "error",
    });

    await expect(result).rejects.toMatchObject({ message: "codec failed" });
    expect(output.locked).toBe(false);
    engine.terminate();
  });

  it("rejects pre-aborted and queued-aborted jobs without posting them", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const pre = new AbortController();
    pre.abort("already stopped");
    await expect(
      engine.inspect({ blob: new Blob(["x"]) }, { signal: pre.signal }),
    ).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      message: "already stopped",
    });

    const active = engine.inspect({ blob: new Blob(["a"]) });
    const queuedController = new AbortController();
    const queued = engine.inspect(
      { blob: new Blob(["b"]) },
      { signal: queuedController.signal },
    );
    queuedController.abort("remove queued");
    await expect(queued).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      message: "remove queued",
    });
    expect(worker.posts).toHaveLength(1);
    worker.emit({
      id: 1,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await active;
    engine.terminate();
  });

  it("retires an unresponsive Worker and drains queued work on a configured replacement", async () => {
    const firstWorker = new WorkerStub();
    const secondWorker = new WorkerStub();
    const { engine, workerFactory } = createReplacingEngine([
      firstWorker,
      secondWorker,
    ]);
    const controller = new AbortController();
    const active = engine.inspect(
      { blob: new Blob(["a"]) },
      { signal: controller.signal },
    );
    const activeRejection = expect(active).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      message: "stop running",
    });
    const next = engine.inspect({ blob: new Blob(["b"]) });
    controller.abort("stop running");

    await activeRejection;
    expect(firstWorker.posts[1]?.message).toEqual({ id: 1, type: "cancel" });
    expect(firstWorker.terminateCalls).toBe(1);
    expect(secondWorker.configurations).toHaveLength(1);
    expect(secondWorker.postTypes).toEqual(["configure", "inspect"]);
    expect(secondWorker.posts[0]?.message).toMatchObject({
      id: 2,
      type: "inspect",
    });
    expect(workerFactory).toHaveBeenCalledTimes(2);

    firstWorker.emit({ id: 1, progress: PROGRESS, type: "progress" });
    firstWorker.emit({
      error: { message: "worker canceled", name: "Error" },
      id: 1,
      type: "error",
    });
    secondWorker.emit({
      id: 2,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await next;
    await engine.dispose();
    expect(secondWorker.terminateCalls).toBe(1);
  });

  it("snapshots codec asset sources for replacement Worker generations", async () => {
    const firstWorker = new WorkerStub();
    const secondWorker = new WorkerStub();
    const workers = [firstWorker, secondWorker];
    const source: { baseUrl: string; kind: "self-hosted" } = {
      baseUrl: "/codec-primary/",
      kind: "self-hosted",
    };
    const fallback: { baseUrl: string; kind: "self-hosted" } = {
      baseUrl: "/codec-fallback/",
      kind: "self-hosted",
    };
    const fallbackSources = [fallback];
    let workerIndex = 0;
    const engine = createAudioTranscoderStreamWorkerEngine({
      codecAssets: { fallbackSources, source },
      maxQueued: 1,
      workerFactory() {
        return workers[workerIndex++] as unknown as Worker;
      },
    });

    source.baseUrl = "/mutated-primary";
    fallback.baseUrl = "/mutated-fallback";
    fallbackSources.push({
      baseUrl: "/new-fallback",
      kind: "self-hosted",
    });

    const controller = new AbortController();
    const input = { blob: new Blob(["snapshot"]) };
    const active = engine.inspect(input, { signal: controller.signal });
    const queued = engine.inspect(input);
    controller.abort("replace snapshot Worker");

    await expect(active).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(firstWorker.configurations).toEqual([
      {
        codecAssets: {
          fallbackSources: [
            { baseUrl: "/codec-fallback", kind: "self-hosted" },
          ],
          source: { baseUrl: "/codec-primary", kind: "self-hosted" },
        },
        type: "configure",
      },
    ]);
    expect(secondWorker.configurations).toEqual(firstWorker.configurations);
    secondWorker.emit({
      id: 2,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await queued;
    await engine.dispose();
  });

  it("aborts and unlocks output without waiting for an unresponsive Worker", async () => {
    const firstWorker = new WorkerStub();
    const secondWorker = new WorkerStub();
    const { engine } = createReplacingEngine([firstWorker, secondWorker]);
    const controller = new AbortController();
    const destinationAbort = deferred<void>();
    const abort = vi.fn((_reason: unknown) => destinationAbort.promise);
    const output = new WritableStream<AudioStreamOutputChunk>({ abort });
    const active = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      output,
      { signal: controller.signal },
    );
    const activeRejection = expect(active).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      message: "stop transcode",
    });
    const next = engine.inspect({ blob: new Blob(["b"]) });

    controller.abort("stop transcode");
    await activeRejection;

    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0]?.[0]).toMatchObject({
      code: "OPERATION_ABORTED",
      message: "stop transcode",
    });
    expect(output.locked).toBe(false);
    expect(firstWorker.posts[1]?.message).toEqual({ id: 1, type: "cancel" });
    expect(firstWorker.terminateCalls).toBe(1);
    expect(secondWorker.posts[0]?.message).toMatchObject({
      id: 2,
      type: "inspect",
    });
    secondWorker.emit({
      id: 2,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await next;
    destinationAbort.resolve();
    await engine.dispose();
  });

  it("ignores late failures from a retired Worker generation", async () => {
    const firstWorker = new WorkerStub();
    const secondWorker = new WorkerStub();
    const { engine } = createReplacingEngine([firstWorker, secondWorker]);
    const controller = new AbortController();
    const active = engine.inspect(
      { blob: new Blob(["a"]) },
      { signal: controller.signal },
    );
    const activeRejection = expect(active).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      message: "stop running",
    });
    const queued = engine.inspect({ blob: new Blob(["b"]) });
    controller.abort("stop running");
    firstWorker.emitError("retired Worker crashed late");
    firstWorker.emitMessageError();

    await activeRejection;
    expect(secondWorker.posts[0]?.message).toMatchObject({
      id: 2,
      type: "inspect",
    });
    secondWorker.emit({
      id: 2,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await expect(queued).resolves.toMatchObject(INSPECTION);
    expect(firstWorker.terminateCalls).toBe(1);
    await engine.dispose();
  });

  it.each([
    new Error("replacement factory failed"),
    "replacement factory failed",
  ])(
    "fails all queued work when replacement Worker creation fails %#",
    async (failure) => {
      const firstWorker = new WorkerStub();
      const workerFactory = vi
        .fn<() => Worker>()
        .mockReturnValueOnce(firstWorker as unknown as Worker)
        .mockImplementationOnce(() => {
          throw failure;
        });
      const engine = createAudioTranscoderStreamWorkerEngine({
        codecAssets: TEST_CODEC_ASSETS,
        maxQueued: 2,
        workerFactory,
      });
      const controller = new AbortController();
      const input = { blob: new Blob(["a"]) };
      const active = engine.inspect(input, { signal: controller.signal });
      const firstQueued = engine.inspect(input);
      const secondQueued = engine.inspect(input);
      const activeRejection = expect(active).rejects.toMatchObject({
        code: "OPERATION_ABORTED",
        message: "replace failed Worker",
      });
      const firstQueuedRejection = expect(firstQueued).rejects.toMatchObject({
        code: "WORKER_FAILURE",
        message: expect.stringContaining("replacement factory failed"),
      });
      const secondQueuedRejection = expect(secondQueued).rejects.toMatchObject({
        code: "WORKER_FAILURE",
        message: expect.stringContaining("replacement factory failed"),
      });

      controller.abort("replace failed Worker");

      await Promise.all([
        activeRejection,
        firstQueuedRejection,
        secondQueuedRejection,
      ]);
      expect(firstWorker.terminateCalls).toBe(1);
      expect(workerFactory).toHaveBeenCalledTimes(2);
      await expect(engine.inspect(input)).rejects.toMatchObject({
        code: "WORKER_TERMINATED",
      });
      await engine.dispose();
    },
  );

  it("fails replacement work without waiting for destination abort cleanup", async () => {
    const firstWorker = new WorkerStub();
    const workerFactory = vi
      .fn<() => Worker>()
      .mockReturnValueOnce(firstWorker as unknown as Worker)
      .mockImplementationOnce(() => {
        throw new Error("replacement factory failed");
      });
    const engine = createAudioTranscoderStreamWorkerEngine({
      codecAssets: TEST_CODEC_ASSETS,
      maxQueued: 2,
      workerFactory,
    });
    const controller = new AbortController();
    const input = { blob: new Blob(["a"]) };
    const destinationAbort = deferred<void>();
    const abort = vi.fn(() => destinationAbort.promise);
    const output = new WritableStream<AudioStreamOutputChunk>({ abort });
    const active = engine.inspect(input, { signal: controller.signal });
    const transcode = engine.transcode(
      input,
      { presetId: "wav-pcm16" },
      output,
    );
    const queued = engine.inspect(input);
    const activeRejection = expect(active).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
    });
    const transcodeRejection = expect(transcode).rejects.toMatchObject({
      code: "WORKER_FAILURE",
      message: expect.stringContaining("replacement factory failed"),
    });
    const queuedRejection = expect(queued).rejects.toMatchObject({
      code: "WORKER_FAILURE",
      message: expect.stringContaining("replacement factory failed"),
    });

    controller.abort("replace failed Worker");

    await Promise.all([activeRejection, transcodeRejection, queuedRejection]);
    expect(abort).toHaveBeenCalledOnce();
    expect(output.locked).toBe(false);
    expect(firstWorker.terminateCalls).toBe(1);

    const disposal = engine.dispose();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await flushMicrotasks();
    expect(disposed).toBe(false);
    destinationAbort.resolve();
    await disposal;
  });

  it("fails queued work when replacement Worker configuration fails", async () => {
    const firstWorker = new WorkerStub();
    const replacementWorker = new WorkerStub();
    replacementWorker.throwOnConfigure = new Error("replacement config failed");
    const { engine } = createReplacingEngine([firstWorker, replacementWorker]);
    const controller = new AbortController();
    const input = { blob: new Blob(["a"]) };
    const active = engine.inspect(input, { signal: controller.signal });
    const queued = engine.inspect(input);
    const activeRejection = expect(active).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
    });
    const queuedRejection = expect(queued).rejects.toMatchObject({
      code: "WORKER_FAILURE",
      message: expect.stringContaining("replacement config failed"),
    });

    controller.abort("replacement config stopped");

    await Promise.all([activeRejection, queuedRejection]);
    expect(firstWorker.terminateCalls).toBe(1);
    expect(replacementWorker.terminateCalls).toBe(1);
    expect(replacementWorker.posts).toHaveLength(0);
    await engine.dispose();
  });

  it("cancels when a progress listener fails, even if cancel posting fails", async () => {
    const worker = new WorkerStub();
    worker.throwOnCancel = true;
    const engine = createEngine(worker);
    const listenerError = new Error("UI failed");
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      new WritableStream(),
      {
        onProgress() {
          throw listenerError;
        },
      },
    );

    worker.emit({ id: 1, progress: PROGRESS, type: "progress" });
    worker.emit({ id: 1, progress: PROGRESS, type: "progress" });
    await worker.abortPostedOutput(1, listenerError);
    worker.emit({
      id: 1,
      operation: "transcode",
      type: "result",
      value: RESULT,
    });
    await expect(result).rejects.toBe(listenerError);
    engine.terminate();
  });

  it("does not cancel twice when a progress listener aborts and then throws", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const controller = new AbortController();
    const result = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      new WritableStream(),
      {
        onProgress() {
          controller.abort("listener stopped");
          throw new Error("late listener failure");
        },
        signal: controller.signal,
      },
    );

    worker.emit({ id: 1, progress: PROGRESS, type: "progress" });
    await worker.abortPostedOutput(1, "listener stopped");
    worker.emit({
      id: 1,
      operation: "transcode",
      type: "result",
      value: RESULT,
    });
    await expect(result).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      message: "listener stopped",
    });
    expect(
      worker.posts.filter(({ message }) => message.type === "cancel"),
    ).toHaveLength(1);
    engine.terminate();
  });

  it("recovers from synchronous post failures and drains the next job", async () => {
    const worker = new WorkerStub();
    worker.throwNextOperation = true;
    const engine = createEngine(worker);
    const failed = engine.inspect({ blob: new Blob(["a"]) });
    const next = engine.inspect({ blob: new Blob(["b"]) });

    await expect(failed).rejects.toThrow("post failed");
    expect(worker.posts[0]?.message).toMatchObject({ id: 2, type: "inspect" });
    worker.emit({
      id: 2,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await next;
    engine.terminate();
  });

  it.each(["error", "messageerror"] as const)(
    "fails active and queued work on worker %s",
    async (failureType) => {
      const worker = new WorkerStub();
      const engine = createEngine(worker);
      const active = engine.inspect({ blob: new Blob(["a"]) });
      const queued = engine.inspect({ blob: new Blob(["b"]) });
      if (failureType === "error") {
        worker.emitError("stream crashed");
      } else {
        worker.emitMessageError();
      }

      await expect(active).rejects.toMatchObject({ code: "WORKER_FAILURE" });
      await expect(queued).rejects.toMatchObject({ code: "WORKER_FAILURE" });
      expect(worker.terminateCalls).toBe(1);
      await expect(
        engine.inspect({ blob: new Blob(["c"]) }),
      ).rejects.toMatchObject({ code: "WORKER_TERMINATED" });
      worker.emitError("late failure");
    },
  );

  it("uses a fallback message for message-less Worker errors", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const active = engine.inspect({ blob: new Blob(["a"]) });
    worker.emitError("");
    await expect(active).rejects.toMatchObject({
      code: "WORKER_FAILURE",
      message: "Audio stream worker failed.",
    });
  });

  it("hard-bounds waiting work and releases capacity after queued cancellation", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, { maxQueued: 1 });
    const active = engine.inspect({ blob: new Blob(["a"]) });
    const controller = new AbortController();
    const queued = engine.inspect(
      { blob: new Blob(["b"]) },
      { signal: controller.signal },
    );
    const abort = vi.fn();
    const rejectedOutput = new WritableStream<AudioStreamOutputChunk>({
      abort,
    });

    await expect(
      engine.transcode(
        { blob: new Blob(["c"]) },
        { presetId: "wav-pcm16" },
        rejectedOutput,
      ),
    ).rejects.toMatchObject({
      code: "QUEUE_CAPACITY_EXCEEDED",
      message:
        "Audio stream Worker queue is full (maxQueued: 1; active operation excluded).",
    });
    expect(rejectedOutput.locked).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(1);

    controller.abort("remove queued");
    const replacement = engine.inspect({ blob: new Blob(["d"]) });
    await expect(queued).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      message: "remove queued",
    });
    worker.emit({
      id: 1,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await active;
    await flushMicrotasks();
    expect(worker.posts[1]?.message).toMatchObject({ id: 3, type: "inspect" });
    worker.emit({
      id: 3,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await replacement;
    await engine.dispose();
  });

  it("ignores a detached queued-abort callback after cancellation", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const active = engine.inspect({ blob: new Blob(["a"]) });
    const abort = createRetainedAbortSignal();
    const queued = engine.inspect(
      { blob: new Blob(["b"]) },
      { signal: abort.signal },
    );

    abort.abort("remove queued");
    await expect(queued).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    abort.invokeDetachedListener();
    worker.emit({
      id: 1,
      operation: "inspect",
      type: "result",
      value: INSPECTION,
    });
    await active;
    await engine.dispose();
  });

  it("awaits active and queued output aborts during idempotent disposal", async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, { maxQueued: 1 });
    const firstAbort = deferred<void>();
    const secondAbort = deferred<void>();
    const firstOutput = new WritableStream<AudioStreamOutputChunk>({
      abort: () => firstAbort.promise,
    });
    const secondOutput = new WritableStream<AudioStreamOutputChunk>({
      abort: () => secondAbort.promise,
    });
    const active = engine.transcode(
      { blob: new Blob(["a"]) },
      { presetId: "wav-pcm16" },
      firstOutput,
    );
    const queued = engine.transcode(
      { blob: new Blob(["b"]) },
      { presetId: "wav-pcm16" },
      secondOutput,
    );

    const disposal = engine.dispose();
    expect(engine.dispose()).toBe(disposal);
    engine.terminate();
    expect(worker.terminateCalls).toBe(1);
    await expect(active).rejects.toMatchObject({ code: "WORKER_TERMINATED" });
    await expect(queued).rejects.toMatchObject({ code: "WORKER_TERMINATED" });
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await flushMicrotasks();
    expect(disposed).toBe(false);
    expect(firstOutput.locked).toBe(false);
    expect(secondOutput.locked).toBe(false);

    firstAbort.resolve();
    await flushMicrotasks();
    expect(firstOutput.locked).toBe(false);
    expect(secondOutput.locked).toBe(false);
    expect(disposed).toBe(false);

    secondAbort.resolve();
    await disposal;
    expect(firstOutput.locked).toBe(false);
    expect(secondOutput.locked).toBe(false);
    expect(disposed).toBe(true);
  });

  it.each([-1, 1.5, 65, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maxQueued %s before creating a Worker",
    (maxQueued) => {
      const workerFactory = vi.fn();
      expect(() =>
        createAudioTranscoderStreamWorkerEngine({
          codecAssets: TEST_CODEC_ASSETS,
          maxQueued,
          workerFactory,
        }),
      ).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
      expect(workerFactory).not.toHaveBeenCalled();
    },
  );

  it("accepts queue-capacity boundaries", async () => {
    const minimum = createEngine(new WorkerStub(), { maxQueued: 0 });
    const maximum = createEngine(new WorkerStub(), { maxQueued: 64 });

    await Promise.all([minimum.dispose(), maximum.dispose()]);
  });

  it("uses default queue limits for a legacy capability manifest", async () => {
    const capabilities = {
      ...AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      limits: {
        ...AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits,
        queue: undefined,
      },
    } as unknown as typeof AUDIO_TRANSCODER_STREAM_CAPABILITIES;
    const engine = createEngine(new WorkerStub(), {
      capabilities,
      runtime: "custom",
    });

    expect(engine.getCapabilities()).toBe(capabilities);
    await engine.dispose();
  });

  it("terminates idempotently with and without pending work", async () => {
    const idleWorker = new WorkerStub();
    const idle = createEngine(idleWorker);
    idle.terminate();
    idle.terminate();
    await idle.dispose();
    expect(idleWorker.terminateCalls).toBe(1);

    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const active = engine.inspect({ blob: new Blob(["a"]) });
    const queued = engine.inspect({ blob: new Blob(["b"]) });
    engine.terminate();
    const disposal = engine.dispose();
    await expect(active).rejects.toMatchObject({ code: "WORKER_TERMINATED" });
    await expect(queued).rejects.toMatchObject({ code: "WORKER_TERMINATED" });
    await disposal;
  });

  it("uses the native module Worker and fails clearly without Workers", () => {
    const worker = new WorkerStub();
    const WorkerConstructor = vi.fn(function WorkerConstructor(
      _url: URL,
      _options: WorkerOptions,
    ) {
      return worker;
    });
    vi.stubGlobal("Worker", WorkerConstructor);
    const engine = createAudioTranscoderStreamWorkerEngine({
      codecAssets: TEST_CODEC_ASSETS,
    });
    expect(WorkerConstructor).toHaveBeenCalledWith(expect.any(URL), {
      name: "audio-stream-transcoder",
      type: "module",
    });
    engine.terminate();

    vi.stubGlobal("Worker", undefined);
    expect(() =>
      createAudioTranscoderStreamWorkerEngine({
        codecAssets: TEST_CODEC_ASSETS,
      }),
    ).toThrow(expect.objectContaining({ code: "WORKER_UNAVAILABLE" }));
  });
});

interface WorkerPost {
  readonly message: AudioStreamWorkerRequest;
  readonly transfer: readonly Transferable[];
}

class WorkerStub {
  readonly listeners = {
    error: [] as ((event: ErrorEvent) => void)[],
    message: [] as ((event: MessageEvent<AudioStreamWorkerResponse>) => void)[],
    messageerror: [] as (() => void)[],
  };
  readonly posts: WorkerPost[] = [];
  readonly postTypes: AudioStreamWorkerRequest["type"][] = [];
  readonly configurations: AudioStreamWorkerRequest[] = [];
  terminateCalls = 0;
  throwNextOperation = false;
  throwOnCancel = false;
  throwOnConfigure: unknown | undefined;

  addEventListener(type: string, listener: EventListener): void {
    if (type === "message") {
      this.listeners.message.push(
        listener as unknown as (
          event: MessageEvent<AudioStreamWorkerResponse>,
        ) => void,
      );
    } else if (type === "error") {
      this.listeners.error.push(
        listener as unknown as (event: ErrorEvent) => void,
      );
    } else {
      this.listeners.messageerror.push(listener as unknown as () => void);
    }
  }

  emit(message: AudioStreamWorkerResponse): void {
    for (const listener of this.listeners.message) {
      listener({ data: message } as MessageEvent<AudioStreamWorkerResponse>);
    }
  }

  emitError(message: string): void {
    for (const listener of this.listeners.error) {
      listener({ message } as ErrorEvent);
    }
  }

  emitMessageError(): void {
    for (const listener of this.listeners.messageerror) {
      listener();
    }
  }

  postMessage(
    message: AudioStreamWorkerRequest,
    transfer: Transferable[] = [],
  ): void {
    this.postTypes.push(message.type);
    if (message.type === "configure") {
      if (this.throwOnConfigure !== undefined) {
        throw this.throwOnConfigure;
      }
      this.configurations.push(message);
      return;
    }
    if (message.type === "cancel" && this.throwOnCancel) {
      throw new Error("cancel failed");
    }
    if (message.type !== "cancel" && this.throwNextOperation) {
      this.throwNextOperation = false;
      throw new Error("post failed");
    }
    this.posts.push({ message, transfer });
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  async abortPostedOutput(id: number, reason: unknown): Promise<void> {
    const writer = this.postedOutput(id).getWriter();
    try {
      await writer.abort(reason);
    } finally {
      writer.releaseLock();
    }
  }

  async closePostedOutput(id: number): Promise<void> {
    const writer = this.postedOutput(id).getWriter();
    try {
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  }

  async writePostedOutput(
    id: number,
    chunk: AudioStreamOutputChunk,
  ): Promise<void> {
    const writer = this.postedOutput(id).getWriter();
    try {
      await writer.write(chunk);
    } finally {
      writer.releaseLock();
    }
  }

  private postedOutput(id: number): WritableStream<AudioStreamOutputChunk> {
    const post = this.posts.find(
      ({ message }) => message.type === "transcode" && message.id === id,
    );
    if (post?.message.type !== "transcode") {
      throw new Error(`No transcode output was posted for operation ${id}.`);
    }
    return post.message.output;
  }
}

function createEngine(worker: WorkerStub, options: EngineHarnessOptions = {}) {
  const workerFactory = () => worker as unknown as Worker;
  return options.runtime === "custom"
    ? createAudioTranscoderStreamWorkerEngine({ ...options, workerFactory })
    : createAudioTranscoderStreamWorkerEngine({
        ...options,
        codecAssets: TEST_CODEC_ASSETS,
        workerFactory,
      });
}

function createReplacingEngine(workers: readonly WorkerStub[]) {
  let index = 0;
  const workerFactory = vi.fn(() => {
    const worker = workers[index];
    index += 1;
    if (worker === undefined) {
      throw new Error("No replacement Worker was configured for this test.");
    }
    return worker as unknown as Worker;
  });
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: TEST_CODEC_ASSETS,
    workerFactory,
  });
  return { engine, workerFactory };
}

type EngineHarnessOptions =
  | {
      readonly capabilities: AudioTranscoderStreamCapabilities;
      readonly maxQueued?: number;
      readonly runtime: "custom";
    }
  | {
      readonly capabilities?: never;
      readonly maxQueued?: number;
      readonly runtime?: "default";
    };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createRetainedAbortSignal() {
  let aborted = false;
  let activeListener: (() => void) | undefined;
  let detachedListener: (() => void) | undefined;
  let reason: unknown;
  const signal = {
    addEventListener(
      _type: string,
      listener: EventListenerOrEventListenerObject,
    ) {
      activeListener =
        typeof listener === "function"
          ? () => listener.call(signal, new Event("abort"))
          : () => listener.handleEvent(new Event("abort"));
    },
    get aborted() {
      return aborted;
    },
    get reason() {
      return reason;
    },
    removeEventListener() {
      detachedListener = activeListener;
      activeListener = undefined;
    },
  } as unknown as AbortSignal;
  return {
    abort(abortReason: unknown): void {
      aborted = true;
      reason = abortReason;
      activeListener?.();
    },
    invokeDetachedListener(): void {
      detachedListener?.();
    },
    signal,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}
