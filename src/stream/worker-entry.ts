import { exposeDefaultAudioTranscoderStreamWorker } from './default-worker-host.js';
import type { AudioTranscoderStreamWorkerScope } from './expose-worker.js';

exposeDefaultAudioTranscoderStreamWorker(
  globalThis as unknown as AudioTranscoderStreamWorkerScope,
);
