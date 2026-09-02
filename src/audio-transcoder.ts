import type { AudioTranscoderEngineInfo } from './engine/contracts.js';
import { createAudioTranscoderEngine } from './engine/factory.js';

export const audioTranscoder = createAudioTranscoderEngine();

export function getVersion(): string {
  return audioTranscoder.getVersion();
}

export function getEngineInfo(): AudioTranscoderEngineInfo {
  return audioTranscoder.getInfo();
}
