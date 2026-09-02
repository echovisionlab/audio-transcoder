import type {
  AudioStreamInput,
  AudioStreamInputSupportResult,
  AudioStreamInspection,
  AudioStreamOperationOptions,
  AudioStreamOutput,
  AudioStreamOutputChunk,
  AudioStreamOutputProbeOptions,
  AudioStreamOutputProbeTarget,
  AudioStreamOutputSupportResult,
  AudioStreamTarget,
  AudioStreamTranscodeResult,
  AudioTranscoderStreamWorkerEngine,
  AudioTranscoderStreamWorkerRuntimeOptions,
  CreateAudioTranscoderStreamWorkerEngineOptions,
} from "./contracts.js";
import type {
  AudioStreamWorkerRequest,
  AudioStreamWorkerResponse,
  StreamWorkerOperationOptions,
} from "./protocol.js";
import {
  createOperationAbortedError,
  createWorkerTerminatedError,
} from "../engine/operation-errors.js";
import { AudioTranscoderError } from "../errors.js";
import { packageEngineInfo } from "../package-metadata.js";
import {
  deserializeWorkerError,
  serializeWorkerError,
} from "../worker/serialized-error.js";
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from "./capabilities.js";
import type { AudioTranscoderStreamCapabilities } from "./capabilities.js";
import {
  createAudioStreamOutputProbeCoordinator,
  probeAudioStreamOutputSupport,
} from "./output-support-probe.js";
import {
  createJsDelivrGitHubRuntimeAssetSource,
  createJsDelivrRuntimeAssetSource,
  createSelfHostedRuntimeAssetSource,
  RuntimeAssetError,
  type RuntimeAssetLoadState,
  type RuntimeAssetSource,
  type RuntimeAssetStateListener,
} from "../assets/runtime-asset-provider.js";

type StreamOperation =
  "inspect" | "probeInputSupport" | "probeOutputSupport" | "transcode";
type StreamResult =
  | AudioStreamInputSupportResult
  | AudioStreamInspection
  | AudioStreamOutputSupportResult
  | AudioStreamTranscodeResult;

interface QueuedOperation {
  abortListener: (() => void) | undefined;
  cancelRequested: boolean;
  commitStarted: boolean;
  readonly id: number;
  readonly onProgress: AudioStreamOperationOptions["onProgress"];
  readonly outputBridge: OutputBridge | undefined;
  posted: boolean;
  readonly reject: (reason: unknown) => void;
  readonly request: AudioStreamWorkerRequest;
  readonly resolve: (value: StreamResult) => void;
  settling: boolean;
  readonly signal: AbortSignal | undefined;
  readonly transfer: Transferable[];
}

type OutputBridgeFailureOrigin =
  | "client-abort"
  | "destination-close"
  | "destination-write"
  | "transferred-stream-abort";

interface OutputBridgeFailure {
  readonly origin: OutputBridgeFailureOrigin;
  readonly reason: unknown;
  readonly status: "failed";
}

type OutputBridgeSettlement =
  | OutputBridgeFailure
  | { readonly reason: undefined; readonly status: "closed" };

type OutputBridgeReadiness = OutputBridgeFailure | { readonly status: "ready" };

interface OutputBridge {
  abort(reason: unknown): Promise<void>;
  commit(): Promise<OutputBridgeSettlement>;
  readonly completion: Promise<OutputBridgeSettlement>;
  readonly ready: Promise<OutputBridgeReadiness>;
  readonly stream: AudioStreamOutput;
}

/** Creates a serial, bounded-memory module Worker for streaming operations. */
export function createAudioTranscoderStreamWorkerEngine(
  options: CreateAudioTranscoderStreamWorkerEngineOptions,
): AudioTranscoderStreamWorkerEngine {
  const runtime = resolveAudioTranscoderStreamWorkerRuntime(options);
  const { capabilities, workerFactory } = runtime;
  const maxQueued = resolveMaxQueued(options.maxQueued, capabilities);
  const outputProbeCoordinator = createAudioStreamOutputProbeCoordinator();
  const queue: QueuedOperation[] = [];
  const pendingOutputCleanups = new Set<Promise<void>>();
  let active: QueuedOperation | undefined;
  let disposal: Promise<void> | undefined;
  let nextOperationId = 1;
  let terminated = false;
  let worker: Worker | undefined;
  let workerGeneration = 0;

  const detachAbort = (operation: QueuedOperation): void => {
    if (operation.abortListener !== undefined) {
      operation.signal?.removeEventListener("abort", operation.abortListener);
      operation.abortListener = undefined;
    }
  };

  const drain = (): void => {
    if (terminated || active !== undefined) {
      return;
    }
    const operation = queue.shift();
    if (operation === undefined) {
      return;
    }
    active = operation;
    operation.posted = true;
    const replacingWorker = worker === undefined;
    try {
      ensureWorker().postMessage(operation.request, operation.transfer);
    } catch (error) {
      operation.settling = true;
      detachAbort(operation);
      const cleanup = trackOutputBridgeAbort(operation, error);
      if (replacingWorker && active === operation) {
        const workerError = replacementWorkerError(error);
        active = undefined;
        operation.reject(workerError);
        void beginDisposal(workerError);
      } else {
        void cleanup.then(() => {
          if (active === operation) {
            active = undefined;
            operation.reject(error);
            drain();
          }
        });
      }
    }
  };

  const trackOutputBridgeAbort = (
    operation: QueuedOperation,
    reason: unknown,
  ): Promise<void> => {
    const cleanup = waitForOutputBridgeAbort(operation, reason);
    pendingOutputCleanups.add(cleanup);
    void cleanup.then(() => pendingOutputCleanups.delete(cleanup));
    return cleanup;
  };

  const rejectAll = async (error: AudioTranscoderError): Promise<void> => {
    const committedOperation =
      active?.commitStarted === true ? active : undefined;
    const operations =
      active === undefined
        ? queue.splice(0)
        : committedOperation === undefined
          ? [active, ...queue.splice(0)]
          : queue.splice(0);
    if (committedOperation === undefined) {
      active = undefined;
    }
    const cleanups: Promise<void>[] = [];
    for (const operation of operations) {
      detachAbort(operation);
      cleanups.push(trackOutputBridgeAbort(operation, error));
      operation.reject(error);
    }
    await Promise.all([
      ...cleanups,
      ...pendingOutputCleanups,
      ...(committedOperation?.outputBridge === undefined
        ? []
        : [committedOperation.outputBridge.completion.then(() => undefined)]),
    ]);
  };

  const beginDisposal = (error: AudioTranscoderError): Promise<void> => {
    if (disposal === undefined) {
      terminated = true;
      const retiringWorker = worker;
      worker = undefined;
      workerGeneration += 1;
      retiringWorker?.terminate();
      disposal = rejectAll(error);
      outputProbeCoordinator.clear(error);
    }
    return disposal;
  };

  const failWorker = (message: string): void => {
    void beginDisposal(new AudioTranscoderError("WORKER_FAILURE", message));
  };

  const attachWorkerListeners = (
    targetWorker: Worker,
    generation: number,
  ): void => {
    targetWorker.addEventListener(
      "message",
      (event: MessageEvent<AudioStreamWorkerResponse>) => {
        if (terminated || generation !== workerGeneration) {
          return;
        }
        const response = event.data;
        if (response.type === "configured") {
          return;
        }
        if (response.type === "asset-state") {
          if (runtime.runtime === "default") {
            try {
              runtime.onAssetStateChange?.(
                deserializeAssetState(response.state),
              );
            } catch {
              // Asset observers cannot interrupt Worker lifecycle or conversion.
            }
          }
          return;
        }
        if (response.type === "configuration-error") {
          const error = deserializeWorkerError(response.error);
          void beginDisposal(
            new AudioTranscoderError(
              "WORKER_FAILURE",
              `Audio stream Worker codec asset configuration failed: ${error.message}`,
            ),
          );
          return;
        }
        const operation = active;
        if (operation === undefined || response.id !== operation.id) {
          return;
        }
        if (response.type === "progress") {
          try {
            operation.onProgress?.(Object.freeze({ ...response.progress }));
          } catch (error) {
            cancelActive(operation, error);
          }
          return;
        }
        if (operation.settling) {
          return;
        }
        operation.settling = true;
        void (async () => {
          const operationError =
            response.type === "error"
              ? deserializeWorkerError(response.error)
              : undefined;
          let outputSettlement: OutputBridgeSettlement | undefined;
          if (response.type === "error") {
            await waitForOutputBridgeAbort(operation, operationError);
            outputSettlement = await operation.outputBridge?.completion;
          } else if (operation.outputBridge !== undefined) {
            const readiness = await operation.outputBridge.ready;
            if (active !== operation) {
              return;
            }
            if (readiness.status === "failed") {
              outputSettlement = readiness;
            } else {
              // The Worker has closed its side and returned success. From this
              // synchronous boundary onward, destination close is irreversible;
              // later cancellation or engine disposal waits for that result.
              detachAbort(operation);
              operation.commitStarted = true;
              outputSettlement = await operation.outputBridge.commit();
            }
          }
          if (active !== operation) {
            return;
          }
          detachAbort(operation);
          active = undefined;
          if (response.type === "error") {
            operation.reject(
              selectWorkerOperationError(operationError!, outputSettlement),
            );
          } else if (outputSettlement?.status === "failed") {
            operation.reject(outputSettlement.reason);
          } else {
            operation.resolve(freezeResult(response.operation, response.value));
          }
          drain();
        })();
      },
    );
    targetWorker.addEventListener("error", (event: ErrorEvent) => {
      if (!terminated && generation === workerGeneration) {
        failWorker(event.message || "Audio stream worker failed.");
      }
    });
    targetWorker.addEventListener("messageerror", () => {
      if (!terminated && generation === workerGeneration) {
        failWorker("Audio stream worker returned an unreadable message.");
      }
    });
  };

  const ensureWorker = (): Worker => {
    if (worker !== undefined) {
      return worker;
    }
    const nextWorker = createWorker(workerFactory);
    const generation = workerGeneration + 1;
    workerGeneration = generation;
    worker = nextWorker;
    attachWorkerListeners(nextWorker, generation);
    if (runtime.runtime === "default") {
      try {
        nextWorker.postMessage({
          codecAssets: runtime.codecAssets,
          type: "configure",
        } satisfies AudioStreamWorkerRequest);
      } catch (error) {
        worker = undefined;
        workerGeneration += 1;
        nextWorker.terminate();
        throw new AudioTranscoderError(
          "WORKER_FAILURE",
          `Failed to configure the audio stream Worker codec assets: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return nextWorker;
  };

  const enqueue = <T extends StreamResult>(
    operation: StreamOperation,
    createRequest: (id: number) => AudioStreamWorkerRequest,
    operationOptions: AudioStreamOperationOptions,
    transfer: Transferable[],
    outputBridge?: OutputBridge,
  ): Promise<T> => {
    const admissionError = getAdmissionError(operationOptions.signal);
    if (admissionError !== undefined) {
      return Promise.reject(admissionError);
    }
    const id = nextOperationId;
    nextOperationId += 1;

    return new Promise<T>((resolve, reject) => {
      const queued: QueuedOperation = {
        abortListener: undefined,
        cancelRequested: false,
        commitStarted: false,
        id,
        onProgress:
          operation === "transcode" ? operationOptions.onProgress : undefined,
        outputBridge,
        posted: false,
        reject,
        request: createRequest(id),
        resolve: (value) => resolve(value as T),
        settling: false,
        signal: operationOptions.signal,
        transfer,
      };
      const signal = operationOptions.signal;
      if (signal !== undefined) {
        queued.abortListener = (): void => {
          const error = createOperationAbortedError(signal);
          if (queued.posted) {
            cancelActive(queued, error);
          } else {
            const queueIndex = queue.indexOf(queued);
            if (queueIndex >= 0) {
              queue.splice(queueIndex, 1);
            }
            detachAbort(queued);
            void trackOutputBridgeAbort(queued, error);
            queued.reject(error);
          }
        };
        signal.addEventListener("abort", queued.abortListener, { once: true });
      }
      queue.push(queued);
      drain();
    });
  };

  const cancelActive = (operation: QueuedOperation, error: unknown): void => {
    if (
      operation.cancelRequested ||
      operation.commitStarted ||
      active !== operation
    ) {
      return;
    }
    operation.cancelRequested = true;
    operation.settling = true;
    detachAbort(operation);
    void trackOutputBridgeAbort(operation, error);
    const retiringWorker = worker;
    worker = undefined;
    workerGeneration += 1;
    try {
      retiringWorker?.postMessage({
        id: operation.id,
        type: "cancel",
      } satisfies AudioStreamWorkerRequest);
    } catch {
      // Termination below remains authoritative when cancel cannot be posted.
    } finally {
      retiringWorker?.terminate();
    }
    active = undefined;
    operation.reject(error);
    drain();
  };

  const getAdmissionError = (
    signal: AbortSignal | undefined,
  ): unknown | undefined => {
    if (terminated) {
      return createWorkerTerminatedError();
    }
    if (signal?.aborted) {
      return createOperationAbortedError(signal);
    }
    if (active !== undefined && queue.length >= maxQueued) {
      return new AudioTranscoderError(
        "QUEUE_CAPACITY_EXCEEDED",
        `Audio stream Worker queue is full (maxQueued: ${maxQueued}; active operation excluded).`,
      );
    }
    return undefined;
  };

  ensureWorker();

  return {
    dispose(): Promise<void> {
      return beginDisposal(createWorkerTerminatedError());
    },
    getCapabilities: () => capabilities,
    getInfo: () => packageEngineInfo,
    getVersion: () => packageEngineInfo.version,
    inspect(input, operationOptions = {}): Promise<AudioStreamInspection> {
      return enqueue(
        "inspect",
        (id) => ({
          id,
          input,
          options: workerOptions(operationOptions),
          type: "inspect",
        }),
        operationOptions,
        [],
      );
    },
    probeInputSupport(
      input,
      operationOptions = {},
    ): Promise<AudioStreamInputSupportResult> {
      return enqueue(
        "probeInputSupport",
        (id) => ({
          id,
          input,
          options: workerOptions(operationOptions),
          type: "probeInputSupport",
        }),
        operationOptions,
        [],
      );
    },
    async probeOutputSupport(
      target: AudioStreamOutputProbeTarget,
      operationOptions: AudioStreamOutputProbeOptions = {},
    ): Promise<AudioStreamOutputSupportResult> {
      if (terminated) {
        throw createWorkerTerminatedError();
      }
      return probeAudioStreamOutputSupport(
        capabilities,
        outputProbeCoordinator,
        target,
        operationOptions.signal,
        (resolvedTarget, signal) =>
          enqueue(
            "probeOutputSupport",
            (id) => ({
              id,
              target: resolvedTarget,
              type: "probeOutputSupport",
            }),
            { signal },
            [],
          ),
      );
    },
    terminate(): void {
      void beginDisposal(createWorkerTerminatedError());
    },
    transcode(
      input: AudioStreamInput,
      target: AudioStreamTarget,
      output: AudioStreamOutput,
      operationOptions: AudioStreamOperationOptions = {},
    ): Promise<AudioStreamTranscodeResult> {
      const admissionError = getAdmissionError(operationOptions.signal);
      if (admissionError !== undefined) {
        return Promise.reject(admissionError);
      }
      let bridge: OutputBridge;
      try {
        bridge = createOutputBridge(output);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueue(
        "transcode",
        (id) => ({
          id,
          input,
          options: workerOptions(operationOptions),
          output: bridge.stream,
          target,
          type: "transcode",
        }),
        operationOptions,
        [bridge.stream as unknown as Transferable],
        bridge,
      );
    },
  };
}

type ResolvedAudioTranscoderStreamWorkerRuntime<WorkerFactory> =
  | {
      readonly capabilities: AudioTranscoderStreamCapabilities;
      readonly runtime: "custom";
      readonly workerFactory: WorkerFactory;
    }
  | {
      readonly capabilities: typeof AUDIO_TRANSCODER_STREAM_CAPABILITIES;
      readonly codecAssets: import("./protocol.js").AudioStreamWorkerCodecAssetConfiguration;
      readonly onAssetStateChange:
        | import("../assets/runtime-asset-provider.js").RuntimeAssetStateListener
        | undefined;
      readonly runtime: "default";
      readonly workerFactory: WorkerFactory | undefined;
    };

/** @internal Shared by the Worker pool so both public factories enforce one contract. */
export function resolveAudioTranscoderStreamWorkerRuntime<WorkerFactory>(
  options: AudioTranscoderStreamWorkerRuntimeOptions<WorkerFactory>,
): ResolvedAudioTranscoderStreamWorkerRuntime<WorkerFactory> {
  if (options === null || typeof options !== "object") {
    throw new AudioTranscoderError(
      "INVALID_CONFIGURATION",
      "Stream Worker options must be an object.",
    );
  }

  const runtimeOptions = options as {
    readonly capabilities?: unknown;
    readonly codecAssets?: unknown;
    readonly runtime?: unknown;
    readonly workerFactory?: unknown;
  };
  const runtime = runtimeOptions.runtime ?? "default";
  if (runtime !== "custom" && runtime !== "default") {
    throw new AudioTranscoderError(
      "INVALID_CONFIGURATION",
      "Stream Worker runtime must be either 'default' or 'custom'.",
    );
  }
  if (
    runtimeOptions.workerFactory !== undefined &&
    typeof runtimeOptions.workerFactory !== "function"
  ) {
    throw new AudioTranscoderError(
      "INVALID_CONFIGURATION",
      "Stream Worker workerFactory must be a function.",
    );
  }

  if (runtime === "default") {
    if (runtimeOptions.capabilities !== undefined) {
      throw new AudioTranscoderError(
        "INVALID_CONFIGURATION",
        "Custom stream capabilities require runtime: 'custom' and a matching workerFactory.",
      );
    }
    const codecAssets = validateCodecAssetsConfiguration(
      runtimeOptions.codecAssets,
    );
    return {
      capabilities: AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      codecAssets: Object.freeze({
        ...(codecAssets.fallbackSources === undefined
          ? {}
          : { fallbackSources: codecAssets.fallbackSources }),
        source: codecAssets.source,
      }),
      onAssetStateChange: codecAssets.onStateChange,
      runtime,
      workerFactory: runtimeOptions.workerFactory as WorkerFactory | undefined,
    };
  }

  if (
    runtimeOptions.codecAssets !== undefined ||
    runtimeOptions.capabilities === null ||
    typeof runtimeOptions.capabilities !== "object" ||
    !("limits" in runtimeOptions.capabilities) ||
    runtimeOptions.capabilities.limits === null ||
    typeof runtimeOptions.capabilities.limits !== "object"
  ) {
    throw new AudioTranscoderError(
      "INVALID_CONFIGURATION",
      "Custom stream runtime requires a capability manifest and workerFactory.",
    );
  }
  if (typeof runtimeOptions.workerFactory !== "function") {
    throw new AudioTranscoderError(
      "INVALID_CONFIGURATION",
      "Custom stream runtime requires a capability manifest and workerFactory.",
    );
  }

  return {
    capabilities:
      runtimeOptions.capabilities as AudioTranscoderStreamCapabilities,
    runtime,
    workerFactory: runtimeOptions.workerFactory as WorkerFactory,
  };
}

function validateCodecAssetsConfiguration(
  value: unknown,
): import("../assets/audio-codec-assets.js").AudioTranscoderCodecAssetsConfiguration {
  if (value === null || typeof value !== "object") {
    throw new AudioTranscoderError(
      "INVALID_CONFIGURATION",
      "The default stream Worker requires an explicit codecAssets configuration.",
    );
  }
  const configuration = value as {
    readonly fallbackSources?: unknown;
    readonly onStateChange?: unknown;
    readonly source?: unknown;
  };
  const onStateChange = configuration.onStateChange;
  if (onStateChange !== undefined && typeof onStateChange !== "function") {
    throw new AudioTranscoderError(
      "INVALID_CONFIGURATION",
      "codecAssets.onStateChange must be a function when provided.",
    );
  }
  const stateListener = onStateChange as RuntimeAssetStateListener | undefined;
  const fallbackSources = configuration.fallbackSources;
  if (fallbackSources !== undefined && !Array.isArray(fallbackSources)) {
    throw new AudioTranscoderError(
      "INVALID_CONFIGURATION",
      "codecAssets.fallbackSources must be an array when provided.",
    );
  }
  try {
    const source = snapshotRuntimeAssetSource(configuration.source);
    const fallbackSnapshot =
      fallbackSources === undefined
        ? undefined
        : Object.freeze(fallbackSources.map(snapshotRuntimeAssetSource));
    return Object.freeze({
      ...(fallbackSnapshot === undefined
        ? {}
        : { fallbackSources: fallbackSnapshot }),
      ...(stateListener === undefined ? {} : { onStateChange: stateListener }),
      source,
    });
  } catch (error) {
    throw new AudioTranscoderError(
      "INVALID_CONFIGURATION",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function snapshotRuntimeAssetSource(value: unknown): RuntimeAssetSource {
  if (value === null || typeof value !== "object") {
    throw new Error("Runtime asset source must be an object.");
  }
  const source = value as {
    readonly baseUrl?: unknown;
    readonly kind?: unknown;
    readonly basePath?: unknown;
    readonly packageName?: unknown;
    readonly packageVersion?: unknown;
    readonly repository?: unknown;
    readonly tag?: unknown;
  };
  switch (source.kind) {
    case "jsdelivr":
      if (
        typeof source.packageName !== "string" ||
        typeof source.packageVersion !== "string"
      ) {
        throw new Error(
          "jsDelivr runtime asset source requires a package name and exact version.",
        );
      }
      return createJsDelivrRuntimeAssetSource(
        source.packageName,
        source.packageVersion,
      );
    case "jsdelivr-github":
      if (
        typeof source.repository !== "string" ||
        typeof source.tag !== "string" ||
        typeof source.basePath !== "string"
      ) {
        throw new Error(
          "jsDelivr GitHub runtime asset source requires a repository, exact tag, and base path.",
        );
      }
      return createJsDelivrGitHubRuntimeAssetSource(
        source.repository,
        source.tag,
        source.basePath,
      );
    case "self-hosted":
      if (typeof source.baseUrl !== "string") {
        throw new Error(
          "Self-hosted runtime asset source requires a base URL.",
        );
      }
      return createSelfHostedRuntimeAssetSource(source.baseUrl);
    default:
      throw new Error("Unsupported runtime asset source kind.");
  }
}

function deserializeAssetState(
  state: import("./protocol.js").AudioStreamWorkerAssetLoadState,
): RuntimeAssetLoadState {
  return Object.freeze({
    ...state,
    error:
      state.error === null
        ? null
        : new RuntimeAssetError(state.error.code, state.error.message),
  });
}

async function waitForOutputBridgeAbort(
  operation: QueuedOperation,
  reason: unknown,
): Promise<void> {
  try {
    await operation.outputBridge?.abort(reason);
  } catch {
    // The operation error remains primary when destination cleanup also fails.
  }
}

function selectWorkerOperationError(
  workerError: Error,
  outputSettlement: OutputBridgeSettlement | undefined,
): unknown {
  if (
    outputSettlement?.status === "failed" &&
    isDestinationFailure(outputSettlement.origin) &&
    isStructuredCloneOf(workerError, outputSettlement.reason)
  ) {
    return outputSettlement.reason;
  }
  return workerError;
}

function isDestinationFailure(origin: OutputBridgeFailureOrigin): boolean {
  return origin === "destination-close" || origin === "destination-write";
}

function isStructuredCloneOf(
  workerError: Error,
  localReason: unknown,
): boolean {
  const serializedLocal = serializeWorkerError(localReason);
  if (serializedLocal.message !== workerError.message) {
    return false;
  }
  if (workerError instanceof AudioTranscoderError) {
    return (
      localReason instanceof AudioTranscoderError &&
      serializedLocal.code === workerError.code &&
      serializedLocal.reason === workerError.reason
    );
  }
  return (
    serializedLocal.name === workerError.name ||
    localReason instanceof AudioTranscoderError
  );
}

function resolveMaxQueued(
  value: number | undefined,
  capabilities:
    | typeof AUDIO_TRANSCODER_STREAM_CAPABILITIES
    | {
        readonly limits: {
          readonly queue?: {
            readonly defaultMaximumQueued: number;
            readonly maximumQueued: number;
          };
        };
      },
): number {
  const defaultLimits = AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.queue;
  const runtimeLimits = capabilities.limits.queue ?? defaultLimits;
  const maximum = Math.min(
    runtimeLimits.maximumQueued,
    defaultLimits.maximumQueued,
  );
  const resolved = value ?? runtimeLimits.defaultMaximumQueued;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new AudioTranscoderError(
      "INVALID_CONFIGURATION",
      `Stream Worker maxQueued must be an integer from 0 to ${maximum}.`,
    );
  }
  return resolved;
}

function createOutputBridge(output: AudioStreamOutput): OutputBridge {
  if (!(output instanceof WritableStream) || output.locked) {
    throw new AudioTranscoderError(
      "INVALID_CONFIGURATION",
      "Streaming output must be an unlocked WritableStream.",
    );
  }

  const writer = output.getWriter();
  let abortPromise: Promise<void> | undefined;
  let readinessState: OutputBridgeReadiness | undefined;
  let settled = false;
  let resolveReady!: (readiness: OutputBridgeReadiness) => void;
  let resolveCompletion!: (settlement: OutputBridgeSettlement) => void;
  const ready = new Promise<OutputBridgeReadiness>((resolve) => {
    resolveReady = resolve;
  });
  const completion = new Promise<OutputBridgeSettlement>((resolve) => {
    resolveCompletion = resolve;
  });

  const setReadiness = (readiness: OutputBridgeReadiness): void => {
    if (readinessState === undefined) {
      readinessState = readiness;
      resolveReady(readiness);
    }
  };
  const settle = (settlement: OutputBridgeSettlement): void => {
    settled = true;
    writer.releaseLock();
    resolveCompletion(settlement);
  };
  const fail = (reason: unknown, origin: OutputBridgeFailureOrigin): void => {
    const failure = { origin, reason, status: "failed" } as const;
    setReadiness(failure);
    settle(failure);
  };
  const abortOnce = (
    reason: unknown,
    origin: Extract<
      OutputBridgeFailureOrigin,
      "client-abort" | "transferred-stream-abort"
    >,
  ): Promise<void> => {
    if (settled) {
      return Promise.resolve();
    }
    const aborting = writer.abort(reason);
    // Releasing ownership does not need to wait for a non-cooperative sink's
    // abort hook. Disposal still tracks the hook's eventual settlement.
    fail(reason, origin);
    return aborting;
  };
  const abort = (reason: unknown): Promise<void> => {
    abortPromise ??= abortOnce(reason, "client-abort");
    return abortPromise;
  };
  const abortTransferredStream = (reason: unknown): Promise<void> => {
    abortPromise ??= abortOnce(reason, "transferred-stream-abort");
    return abortPromise;
  };
  const commit = (): Promise<OutputBridgeSettlement> => {
    const closing = writer.close();
    return closing.then(
      () => {
        settle({ reason: undefined, status: "closed" });
        return completion;
      },
      (error: unknown) => {
        fail(error, "destination-close");
        return completion;
      },
    );
  };

  const stream = new WritableStream<AudioStreamOutputChunk>({
    abort: abortTransferredStream,
    close() {
      setReadiness({ status: "ready" });
    },
    async write(chunk) {
      try {
        await writer.write(chunk);
      } catch (error) {
        fail(error, "destination-write");
        throw error;
      }
    },
  });

  return { abort, commit, completion, ready, stream };
}

function createWorker(workerFactory: (() => Worker) | undefined): Worker {
  if (workerFactory !== undefined) {
    return workerFactory();
  }
  if (typeof Worker === "undefined") {
    throw new AudioTranscoderError(
      "WORKER_UNAVAILABLE",
      "Web Workers are unavailable in this environment.",
    );
  }
  return new Worker(new URL("./worker-entry.js", import.meta.url), {
    name: "audio-stream-transcoder",
    type: "module",
  });
}

function replacementWorkerError(error: unknown): AudioTranscoderError {
  if (
    error instanceof AudioTranscoderError &&
    error.code === "WORKER_FAILURE"
  ) {
    return error;
  }
  return new AudioTranscoderError(
    "WORKER_FAILURE",
    `Failed to replace the audio stream Worker: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function workerOptions(
  options: AudioStreamOperationOptions,
): StreamWorkerOperationOptions {
  return {
    ...(options.inputReadBytes === undefined
      ? {}
      : { inputReadBytes: options.inputReadBytes }),
    ...(options.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.outputChunkBytes === undefined
      ? {}
      : { outputChunkBytes: options.outputChunkBytes }),
    ...(options.pcmChunkBytes === undefined
      ? {}
      : { pcmChunkBytes: options.pcmChunkBytes }),
  };
}

function freezeResult(
  operation: StreamOperation,
  result: StreamResult,
): StreamResult {
  if (operation === "transcode") {
    const transcodeResult = result as AudioStreamTranscodeResult;
    return Object.freeze({
      ...transcodeResult,
      details: Object.freeze({ ...transcodeResult.details }),
      preset: Object.freeze({
        ...transcodeResult.preset,
      }),
    }) as AudioStreamTranscodeResult;
  }
  if (operation === "probeInputSupport") {
    const support = result as AudioStreamInputSupportResult;
    return Object.freeze({
      ...support,
      inspection:
        support.inspection === null
          ? null
          : freezeInspection(support.inspection),
    }) as AudioStreamInputSupportResult;
  }
  if (operation === "probeOutputSupport") {
    return Object.freeze({
      ...(result as AudioStreamOutputSupportResult),
    }) as AudioStreamOutputSupportResult;
  }
  return freezeInspection(result as AudioStreamInspection);
}

function freezeInspection(
  inspection: AudioStreamInspection,
): AudioStreamInspection {
  return Object.freeze({
    ...inspection,
    notes: Object.freeze([...inspection.notes]),
    sourceEncoding: Object.freeze({
      ...(inspection.sourceEncoding ?? { kind: "unknown" as const }),
    }),
  });
}
