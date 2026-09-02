import { DefaultAudioTranscoderEngine } from './default-audio-transcoder-engine.js';
import type {
  AudioTranscoderEngine,
  CreateAudioTranscoderEngineOptions,
} from './contracts.js';
import { packageEngineInfo } from '../package-metadata.js';
import {
  BUILT_IN_DECODERS,
  BUILT_IN_ENCODERS,
  BUILT_IN_INSPECTORS,
} from '../codecs/built-ins.js';
import { CodecRegistry } from '../codecs/codec-registry.js';
import { AudioTranscoderError } from '../errors.js';

/** Creates an inline engine with built-in codecs and optional plugins. */
export function createAudioTranscoderEngine(
  options: CreateAudioTranscoderEngineOptions = {},
): AudioTranscoderEngine {
  const plugins = options.plugins ?? [];
  assertUniquePluginIds(plugins);

  const registry = new CodecRegistry({
    inspectors: [
      ...plugins.flatMap(({ inspectors }) => inspectors ?? []),
      ...BUILT_IN_INSPECTORS,
    ],
    decoders: [
      ...plugins.flatMap(({ decoders }) => decoders ?? []),
      ...BUILT_IN_DECODERS,
    ],
    encoders: [
      ...plugins.flatMap(({ encoders }) => encoders ?? []),
      ...BUILT_IN_ENCODERS,
    ],
  });

  return new DefaultAudioTranscoderEngine(packageEngineInfo, registry);
}

function assertUniquePluginIds(
  plugins: NonNullable<CreateAudioTranscoderEngineOptions['plugins']>,
): void {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) {
      throw new AudioTranscoderError(
        'DUPLICATE_REGISTRATION',
        `Duplicate plugin id "${plugin.id}".`,
      );
    }
    ids.add(plugin.id);
  }
}
