import { AudioTranscoderError } from "../../errors.js";
import { createOperationAbortedError } from "../../engine/operation-errors.js";
import { raceWithOperationAbort } from "../abortable-operation.js";
import type { AudioStreamOutputChunk } from "../contracts.js";
import type {
  AudioStreamEncoder,
  AudioStreamEncoderConfiguration,
} from "./contracts.js";
import {
  createOggOpusWasmInstantiator,
  type OggOpusWasmLoader,
  type OggOpusWasmExports,
  type OggOpusWasmInstantiator,
} from "./ogg-opus-wasm-runtime.js";

export const OGG_OPUS_SAMPLE_RATE = 48_000;
export const OGG_OPUS_CHANNELS = Object.freeze({ maximum: 2, minimum: 1 });
export const OGG_OPUS_BITRATE_BPS = Object.freeze({
  maximum: 512_000,
  minimum: 500,
});
export const OGG_OPUS_FIXED_SERIAL = 0x4155_4430;
export const OGG_OPUS_MAX_PAGE_BYTES = 65_307;

export type OggOpusStreamEncoderFactory = (
  configuration: AudioStreamEncoderConfiguration,
  bitrateBps: number,
) => Promise<AudioStreamEncoder>;

/** Creates an encoder factory backed by an explicit raw-WASM loader. */
export function createOggOpusStreamEncoderFactory(
  loadWasm: OggOpusWasmLoader,
): OggOpusStreamEncoderFactory {
  return createEncoderFactory(createOggOpusWasmInstantiator(loadWasm));
}

function createEncoderFactory(
  instantiateWasm: OggOpusWasmInstantiator,
): OggOpusStreamEncoderFactory {
  return async (configuration, bitrateBps) => {
    validateConfiguration(configuration, bitrateBps);
    throwIfAborted(configuration.signal);

    let wasm: OggOpusWasmExports;
    try {
      wasm = await raceWithOperationAbort(
        instantiateWasm(configuration.signal),
        configuration.signal,
      );
    } catch (error) {
      throwIfAborted(configuration.signal);
      throw workerFailure("initialize", error);
    }
    throwIfAborted(configuration.signal);
    if (wasm.wasm_ogg_opus_max_page_bytes() !== OGG_OPUS_MAX_PAGE_BYTES) {
      throw new AudioTranscoderError(
        "WORKER_FAILURE",
        "The runtime-asset Ogg Opus encoder reported an unexpected Ogg page bound.",
      );
    }

    const createdHandle = wasm.wasm_ogg_opus_create(
      configuration.channels,
      bitrateBps,
    );
    if (createdHandle === 0) {
      throw wasmFailure("create", wasm.wasm_ogg_opus_last_create_error());
    }

    let handle = createdHandle;
    let writer: WritableStreamDefaultWriter<AudioStreamOutputChunk>;
    try {
      writer = configuration.writable.getWriter();
    } catch (error) {
      wasm.wasm_ogg_opus_destroy(handle);
      throw error;
    }

    const pcmCapacityFrames = wasm.wasm_ogg_opus_pcm_capacity_frames();
    const pcmPointer = wasm.wasm_ogg_opus_pcm(handle);
    if (pcmCapacityFrames < 1 || pcmPointer === 0) {
      wasm.wasm_ogg_opus_destroy(handle);
      await writer.abort("Invalid Ogg Opus PCM bridge.").catch(() => undefined);
      writer.releaseLock();
      throw new AudioTranscoderError(
        "WORKER_FAILURE",
        "The runtime-asset Ogg Opus encoder exposed an invalid PCM bridge.",
      );
    }

    let activeWrite = false;
    let bytesWritten = 0;
    let framesWritten = 0;
    let finalizeAttempt: Promise<void> | null = null;
    let settlement: Promise<void> | null = null;
    let state:
      | "canceled"
      | "finalized"
      | "finalizing"
      | "pending"
      | "started"
      | "starting" = "pending";

    const destroy = (): void => {
      if (handle !== 0) {
        const releasedHandle = handle;
        handle = 0;
        wasm.wasm_ogg_opus_destroy(releasedHandle);
      }
    };

    const releaseWriter = (): void => {
      if (configuration.writable.locked) writer.releaseLock();
    };

    const abortWriter = (reason: unknown): Promise<void> => {
      settlement ??= writer.abort(reason).finally(releaseWriter);
      return settlement.catch(() => undefined);
    };

    const assertRunning = (): void => {
      throwIfAborted(configuration.signal);
      if (state === "canceled" || state === "finalized" || handle === 0) {
        throw invalidState("continue", state, activeWrite);
      }
    };

    const writePage = async (page: Uint8Array<ArrayBuffer>): Promise<void> => {
      for (
        let offset = 0;
        offset < page.byteLength;
        offset += configuration.outputChunkBytes
      ) {
        assertRunning();
        const data = page.slice(
          offset,
          Math.min(offset + configuration.outputChunkBytes, page.byteLength),
        );
        await writer.write({ data, position: bytesWritten, type: "write" });
        bytesWritten += data.byteLength;
        assertRunning();
      }
    };

    const pullAvailablePages = async (): Promise<void> => {
      for (;;) {
        assertRunning();
        const result = wasm.wasm_ogg_opus_pull_page(handle);
        if (result === 0) return;
        if (result < 0) throw wasmFailure("pull an Ogg page", result);
        const pagePointer = wasm.wasm_ogg_opus_page(handle);
        const pageLength = wasm.wasm_ogg_opus_page_length(handle);
        if (
          pagePointer === 0 ||
          pageLength < 27 ||
          pageLength > OGG_OPUS_MAX_PAGE_BYTES
        ) {
          throw new AudioTranscoderError(
            "WORKER_FAILURE",
            "The runtime-asset Ogg Opus encoder exposed an invalid Ogg page.",
          );
        }
        // Copy before awaiting: another WASM allocation can replace memory.buffer.
        const page = Uint8Array.from(
          new Uint8Array(wasm.memory.buffer, pagePointer, pageLength),
        );
        await writePage(page);
      }
    };

    const cancel = async (reason?: unknown): Promise<void> => {
      if (state === "finalized") return;
      state = "canceled";
      destroy();
      await abortWriter(reason);
    };

    return {
      cancel,
      finalize(): Promise<void> {
        if (finalizeAttempt !== null) return finalizeAttempt;
        finalizeAttempt = (async () => {
          if (state !== "started" || activeWrite) {
            throw invalidState("finalize", state, activeWrite);
          }
          state = "finalizing";
          try {
            throwIfAborted(configuration.signal);
            const result = wasm.wasm_ogg_opus_drain(handle);
            if (result !== 0) throw wasmFailure("drain", result);
            await pullAvailablePages();
            if (wasm.wasm_ogg_opus_eos_seen(handle) !== 1) {
              throw new AudioTranscoderError(
                "WORKER_FAILURE",
                "The runtime-asset Ogg Opus encoder did not emit a validated EOS page.",
              );
            }
            throwIfAborted(configuration.signal);
            settlement = writer.close().finally(releaseWriter);
            await settlement;
            destroy();
            state = "finalized";
          } catch (error) {
            state = "canceled";
            destroy();
            await abortWriter(error);
            throw error;
          }
        })();
        return finalizeAttempt;
      },
      getBytesWritten: () => bytesWritten,
      async start(): Promise<void> {
        if (state !== "pending")
          throw invalidState("start", state, activeWrite);
        state = "starting";
        try {
          await pullAvailablePages();
          state = "started";
        } catch (error) {
          state = "canceled";
          destroy();
          await abortWriter(error);
          throw error;
        }
      },
      async write(samples, frameOffset): Promise<void> {
        if (state !== "started" || activeWrite) {
          throw invalidState("write", state, activeWrite);
        }
        throwIfAborted(configuration.signal);
        if (samples.length % configuration.channels !== 0) {
          throw new AudioTranscoderError(
            "INVALID_AUDIO_DATA",
            "Ogg Opus samples must contain complete interleaved frames.",
          );
        }
        if (
          !Number.isSafeInteger(frameOffset) ||
          frameOffset !== framesWritten
        ) {
          throw new AudioTranscoderError(
            "INVALID_CONFIGURATION",
            `Ogg Opus frameOffset must be the next sequential frame (${framesWritten}).`,
          );
        }

        const frameCount = samples.length / configuration.channels;
        if (!Number.isSafeInteger(framesWritten + frameCount)) {
          throw new AudioTranscoderError(
            "UNSUPPORTED_OUTPUT",
            "Ogg Opus output exceeds the safe JavaScript frame-count limit.",
            { reason: "target-size-limit" },
          );
        }
        activeWrite = true;
        try {
          let sourceFrame = 0;
          while (sourceFrame < frameCount) {
            assertRunning();
            const frames = Math.min(
              pcmCapacityFrames,
              frameCount - sourceFrame,
            );
            const firstSample = sourceFrame * configuration.channels;
            const sampleCount = frames * configuration.channels;
            new Float32Array(wasm.memory.buffer, pcmPointer, sampleCount).set(
              samples.subarray(firstSample, firstSample + sampleCount),
            );
            const result = wasm.wasm_ogg_opus_write(handle, frames);
            if (result !== 0) throw wasmFailure("encode PCM", result);
            sourceFrame += frames;
            framesWritten += frames;
            await pullAvailablePages();
          }
        } catch (error) {
          state = "canceled";
          destroy();
          await abortWriter(error);
          throw error;
        } finally {
          activeWrite = false;
        }
      },
    };
  };
}

function validateConfiguration(
  configuration: AudioStreamEncoderConfiguration,
  bitrateBps: number,
): void {
  if (
    !Number.isSafeInteger(configuration.channels) ||
    configuration.channels < OGG_OPUS_CHANNELS.minimum ||
    configuration.channels > OGG_OPUS_CHANNELS.maximum ||
    configuration.sampleRate !== OGG_OPUS_SAMPLE_RATE
  ) {
    throw new AudioTranscoderError(
      "UNSUPPORTED_OUTPUT",
      "Ogg Opus output requires 1-2 channels at 48000 Hz.",
    );
  }
  if (
    !Number.isSafeInteger(bitrateBps) ||
    bitrateBps < OGG_OPUS_BITRATE_BPS.minimum ||
    bitrateBps > OGG_OPUS_BITRATE_BPS.maximum
  ) {
    throw new AudioTranscoderError(
      "INVALID_CONFIGURATION",
      `Ogg Opus bitrate must be an integer from ${OGG_OPUS_BITRATE_BPS.minimum} to ${OGG_OPUS_BITRATE_BPS.maximum} bps.`,
    );
  }
  if (
    !Number.isSafeInteger(configuration.outputChunkBytes) ||
    configuration.outputChunkBytes < 1
  ) {
    throw new AudioTranscoderError(
      "INVALID_CONFIGURATION",
      "outputChunkBytes must hold at least one Ogg byte.",
    );
  }
}

function invalidState(
  operation: string,
  state: string,
  activeWrite: boolean,
): AudioTranscoderError {
  return new AudioTranscoderError(
    "INVALID_CONFIGURATION",
    `Cannot ${operation} Ogg Opus output while the encoder is ${
      activeWrite ? "writing" : state
    }.`,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createOperationAbortedError(signal);
}

function wasmFailure(operation: string, code: number): AudioTranscoderError {
  return new AudioTranscoderError(
    "WORKER_FAILURE",
    `The runtime-asset Ogg Opus encoder failed to ${operation} (code ${code}).`,
  );
}

function workerFailure(
  operation: string,
  error: unknown,
): AudioTranscoderError {
  const reason = error instanceof Error ? error.message : String(error);
  return new AudioTranscoderError(
    "WORKER_FAILURE",
    `Failed to ${operation} the runtime-asset Ogg Opus encoder: ${reason}`,
  );
}
