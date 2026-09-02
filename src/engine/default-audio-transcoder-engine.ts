import type {
  AudioInput,
  AudioInspection,
  AudioOperationOptions,
  AudioTranscoderCapabilities,
  AudioTranscoderEngine,
  AudioTranscoderEngineInfo,
  DecodedAudio,
  EncodedAudio,
  PcmAudio,
} from './contracts.js';
import { CodecRegistry } from '../codecs/codec-registry.js';
import {
  assertWholeBufferDecodeEstimateWithinLimit,
  assertWholeBufferInputWithinLimit,
  assertWholeBufferPcmWithinLimit,
} from './buffer-policy.js';
import { createProgressPhase, emitFinalProgress } from './progress.js';

export class DefaultAudioTranscoderEngine implements AudioTranscoderEngine {
  readonly #info: AudioTranscoderEngineInfo;
  readonly #registry: CodecRegistry;

  constructor(info: AudioTranscoderEngineInfo, registry: CodecRegistry) {
    this.#info = Object.freeze({ ...info });
    this.#registry = registry;
  }

  async decode(
    input: AudioInput,
    options: AudioOperationOptions = {},
  ): Promise<DecodedAudio> {
    assertWholeBufferInputWithinLimit(input, options);
    const phase = createProgressPhase({
      operation: 'decode',
      operationOptions: options,
      phase: 'decode',
      phaseCount: 1,
      phaseIndex: 0,
    });
    phase.start();
    const decoded = await this.#registry.decode(
      input,
      phase.context,
      (estimate) =>
        assertWholeBufferDecodeEstimateWithinLimit(estimate, options),
    );
    assertWholeBufferPcmWithinLimit(decoded, options);
    phase.complete();
    return decoded;
  }

  async encode(
    audio: PcmAudio,
    presetId: string,
    options: AudioOperationOptions = {},
  ): Promise<EncodedAudio> {
    assertWholeBufferPcmWithinLimit(audio, options);
    const phase = createProgressPhase({
      operation: 'encode',
      operationOptions: options,
      phase: 'encode',
      phaseCount: 1,
      phaseIndex: 0,
    });
    phase.start();
    const encoded = await this.#registry.encode(
      audio,
      presetId,
      phase.context,
    );
    phase.complete();
    return encoded;
  }

  getCapabilities(): AudioTranscoderCapabilities {
    return this.#registry.getCapabilities();
  }

  getInfo(): AudioTranscoderEngineInfo {
    return this.#info;
  }

  getVersion(): string {
    return this.#info.version;
  }

  inspect(input: AudioInput): AudioInspection {
    return this.#registry.inspect(input);
  }

  async transcode(
    input: AudioInput,
    presetId: string,
    options: AudioOperationOptions = {},
  ): Promise<EncodedAudio> {
    assertWholeBufferInputWithinLimit(input, options);
    const decodePhase = createProgressPhase({
      operation: 'transcode',
      operationOptions: options,
      phase: 'decode',
      phaseCount: 2,
      phaseIndex: 0,
    });
    decodePhase.start();
    const decoded = await this.#registry.decode(
      input,
      decodePhase.context,
      (estimate) =>
        assertWholeBufferDecodeEstimateWithinLimit(estimate, options),
    );
    assertWholeBufferPcmWithinLimit(decoded, options);
    decodePhase.complete();

    const encodePhase = createProgressPhase({
      operation: 'transcode',
      operationOptions: options,
      phase: 'encode',
      phaseCount: 2,
      phaseIndex: 1,
    });
    encodePhase.start();
    const encoded = await this.#registry.encode(
      decoded,
      presetId,
      encodePhase.context,
    );
    encodePhase.complete();
    emitFinalProgress('transcode', options);
    return encoded;
  }
}
