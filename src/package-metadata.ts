import {
  GENERATED_PACKAGE_NAME,
  GENERATED_PACKAGE_VERSION,
} from './generated/package-metadata.js';
import type { AudioTranscoderEngineInfo } from './engine/contracts.js';

export const AUDIO_TRANSCODER_PACKAGE = GENERATED_PACKAGE_NAME;
export const AUDIO_TRANSCODER_VERSION = GENERATED_PACKAGE_VERSION;

export const packageEngineInfo: AudioTranscoderEngineInfo = Object.freeze({
  name: AUDIO_TRANSCODER_PACKAGE,
  version: AUDIO_TRANSCODER_VERSION,
});
