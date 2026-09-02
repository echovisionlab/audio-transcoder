import { aiffDecoder, aiffEncoder, aiffInspector } from './aiff.js';
import { cafDecoder, cafInspector } from './caf.js';
import type {
  AudioDecoderAdapter,
  AudioEncoderAdapter,
  AudioInspectorAdapter,
} from './contracts.js';
import { flacInspector } from './flac.js';
import { mp3Inspector } from './mp3.js';
import { wavDecoder, wavEncoder, wavInspector } from './wav.js';

export const BUILT_IN_INSPECTORS: readonly AudioInspectorAdapter[] =
  Object.freeze([
    wavInspector,
    aiffInspector,
    cafInspector,
    flacInspector,
    mp3Inspector,
  ]);

export const BUILT_IN_DECODERS: readonly AudioDecoderAdapter[] = Object.freeze([
  wavDecoder,
  aiffDecoder,
  cafDecoder,
]);

export const BUILT_IN_ENCODERS: readonly AudioEncoderAdapter[] = Object.freeze([
  wavEncoder,
  aiffEncoder,
]);
