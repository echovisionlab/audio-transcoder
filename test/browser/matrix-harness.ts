import {
  AUDIO_TRANSCODER_STREAM_CAPABILITIES,
  AudioTranscoderError,
  createAudioTranscoderOutputSession,
  createSelfHostedRuntimeAssetSource,
  createAudioTranscoderStreamWorkerPool,
  createAudioTranscoderStreamWorkerEngine,
  type AudioStreamInput,
  type AudioStreamOutput,
  type AudioStreamOutputChunk,
  type AudioStreamOutputPresetId,
  type AudioStreamTarget,
  type AudioTranscoderStreamWorkerEngine,
} from '@echovisionlab/audio-transcoder';
import { discardPendingOutputAfterFailure } from '../../examples/vite/src/output-store.js';

const MATRIX_FRAMES = 8_192;
const INPUT_FIXTURE_FRAMES = 44_100;
const SAMPLE_RATE = 44_100;
const CHANNELS = 2;
const CHUNK_BYTES = 64 * 1024;
const INPUT_PROBE_DEADLINE_MS = 15_000;
const BROWSER_CODEC_ASSETS = Object.freeze({
  source: createSelfHostedRuntimeAssetSource(
    new URL('/.artifacts/codec-assets-package/', window.location.href).href,
  ),
});
const MP3_ACCEPTED_MATRIX = [
  [
    'mp3-128kbps',
    [16_000, 22_050, 24_000, 32_000, 44_100, 48_000],
  ],
  ['mp3-192kbps', [32_000, 44_100, 48_000]],
  ['mp3-256kbps', [32_000, 44_100, 48_000]],
  ['mp3-320kbps', [32_000, 44_100, 48_000]],
] as const;
const MP3_REJECTED_SAMPLE_RATES = [
  8_000,
  11_025,
  12_000,
  16_000,
  22_050,
  24_000,
] as const;
const MP3_HIGH_BITRATE_PRESETS = [
  'mp3-192kbps',
  'mp3-256kbps',
  'mp3-320kbps',
] as const;
const MP3_128KBPS_REJECTED_SAMPLE_RATES = [8_000, 11_025, 12_000] as const;
const AAC_PRESETS = [
  'aac-96kbps',
  'aac-128kbps',
  'aac-192kbps',
  'aac-256kbps',
] as const;
const AAC_SAMPLE_RATES = [32_000, 44_100, 48_000] as const;
const OGG_OPUS_PRESETS = [
  'ogg-opus-64kbps',
  'ogg-opus-96kbps',
  'ogg-opus-128kbps',
  'ogg-opus-192kbps',
] as const;

type OutputFormat = 'aac' | 'aiff' | 'flac' | 'mp3' | 'ogg' | 'wav';

interface BrowserMatrixResult {
  readonly aacFrames: number | null;
  readonly aacObjectType: number | null;
  readonly aiffFormBytes: number | null;
  readonly aiffFrames: number | null;
  readonly aiffSoundBytes: number | null;
  readonly bitDepth: number | null;
  readonly bitrate: number | null;
  readonly bytesWritten: number;
  readonly channels: number;
  readonly closedBeforeResolved: boolean;
  readonly finalSize: number;
  readonly flacAudioFrame: boolean | null;
  readonly flacTotalSamples: number | null;
  readonly expectedTotalSamples: number;
  readonly format: OutputFormat;
  readonly formatTag: number | null;
  readonly maxChunkBytes: number;
  readonly mp3Frames: number | null;
  readonly mp3FrameBitrates: readonly number[] | null;
  readonly mp3SeekHeader: 'Info' | 'Xing' | null;
  readonly mp3SeekHeaderFrames: number | null;
  readonly oggEos: boolean | null;
  readonly oggFinalGranule: number | null;
  readonly oggPages: number | null;
  readonly oggPreSkip: number | null;
  readonly oggSerial: number | null;
  readonly presetId: AudioStreamOutputPresetId;
  readonly progress: readonly number[];
  readonly resultDetailsFormat: OutputFormat;
  readonly resultFormat: OutputFormat;
  readonly resultPresetId: string;
  readonly resultRf64: boolean | null;
  readonly sampleRate: number;
  readonly wavBlockAlign: number | null;
  readonly wavByteRate: number | null;
  readonly wavDataBytes: number | null;
  readonly wavDataEndsAtFileEnd: boolean | null;
  readonly wavDataChunks: number | null;
  readonly wavFmtBytes: number | null;
  readonly wavFmtChunks: number | null;
  readonly wavFrames: number | null;
  readonly wavRiffBytes: number | null;
  readonly writes: number;
  readonly workerResources: readonly string[];
}

interface BrowserConstraintRejection {
  readonly channels: number;
  readonly errorCode: string;
  readonly presetId: AudioStreamOutputPresetId;
  readonly sampleRate: number;
  readonly writes: number;
}

interface BrowserFlacMatrixResult {
  readonly accepted: readonly BrowserMatrixResult[];
  readonly advertisedSampleRates: readonly number[];
  readonly invalid: readonly BrowserConstraintRejection[];
  readonly resourcesBeforeAcceptedEncoding: readonly string[];
}

interface BrowserWavMatrixResult {
  readonly accepted: readonly BrowserMatrixResult[];
  readonly invalid: readonly BrowserConstraintRejection[];
}

interface BrowserAiffMatrixResult {
  readonly accepted: readonly BrowserMatrixResult[];
  readonly invalid: readonly BrowserConstraintRejection[];
}

interface BrowserAacMatrixResult {
  readonly accepted: readonly BrowserMatrixResult[];
  readonly invalid: readonly BrowserConstraintRejection[];
  readonly resourcesBeforeAcceptedEncoding: readonly string[];
}

interface BrowserOggOpusMatrixResult {
  readonly accepted: readonly BrowserMatrixResult[];
  readonly invalid: readonly BrowserConstraintRejection[];
  readonly resourcesBeforeAcceptedEncoding: readonly string[];
}

interface BrowserFlacProbeBudgetResult {
  readonly adequateErrorCode: string | null;
  readonly adequateStatus: string | null;
  readonly fixtureBytes: number;
  readonly lowBudgetBytes: number;
  readonly lowBudgetErrorCode: string | null;
  readonly lowBudgetStatus: string | null;
  readonly probeDeadlineFired: boolean;
  readonly transcodeBytesWritten: number;
  readonly transcodeClosed: boolean;
  readonly transcodeErrorCode: string | null;
  readonly transcodeFormat: OutputFormat | null;
  readonly transcodeAttempted: boolean;
  readonly transcodeWrites: number;
  readonly workersAfterDeadline: number | null;
  readonly recoveryStatus: string | null;
  readonly recoveryWorkers: number | null;
}

interface BrowserOutputSupportProbeResult {
  readonly aac: { readonly code: string; readonly status: string };
  readonly aiff: { readonly code: string; readonly status: string };
  readonly disposed: boolean;
  readonly flac: { readonly code: string; readonly status: string };
  readonly invalidMp3: { readonly code: string; readonly status: string };
  readonly invalidAac: { readonly code: string; readonly status: string };
  readonly invalidOgg: { readonly code: string; readonly status: string };
  readonly mp3: { readonly code: string; readonly status: string };
  readonly ogg: { readonly code: string; readonly status: string };
  readonly outputArtifactsCreated: number;
  readonly resourcesAfterFlac: readonly string[];
  readonly resourcesAfterAiff: readonly string[];
  readonly resourcesAfterAac: readonly string[];
  readonly resourcesAfterInvalidMp3: readonly string[];
  readonly resourcesAfterInvalidAac: readonly string[];
  readonly resourcesAfterInvalidOgg: readonly string[];
  readonly resourcesAfterMp3: readonly string[];
  readonly resourcesAfterOgg: readonly string[];
  readonly resourcesAfterWav: readonly string[];
  readonly wav: { readonly code: string; readonly status: string };
}

interface BrowserStressResult {
  readonly bytesWritten: number;
  readonly closed: boolean;
  readonly maxChunkBytes: number;
  readonly progressEvents: number;
  readonly writes: number;
}

interface BrowserMp3ConstraintMatrixResult {
  readonly accepted: readonly BrowserMatrixResult[];
  readonly invalid: readonly {
    readonly errorCode: string;
    readonly presetId: AudioStreamOutputPresetId;
    readonly sampleRate: number;
  }[];
  readonly resourcesBeforeAcceptedEncoding: readonly string[];
}

interface InputCapabilitySummary {
  readonly extensionHints: readonly string[];
  readonly id: string;
  readonly path: 'built-in-pcm' | 'runtime-probed';
}

interface InputProbeFixtureResult {
  readonly capabilityId: string | null;
  readonly capabilityPath: 'built-in-pcm' | 'runtime-probed' | null;
  readonly container: string | null;
  readonly decodeSupport: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly errorName: string | null;
  readonly fixture: 'aiff' | 'caf' | 'flac' | 'mp3' | 'unknown' | 'wav';
  readonly probeStatus:
    | 'recognized-unsupported'
    | 'supported'
    | 'unsupported';
  readonly transcodeSucceeded: boolean;
}

interface InputProbeMatrixResult {
  readonly advertised: readonly InputCapabilitySummary[];
  readonly fixtures: readonly InputProbeFixtureResult[];
}

interface OutputSessionSmokeResult {
  readonly artifactSize: number;
  readonly artifactStorage: 'memory' | 'opfs';
  readonly bitDepth: number;
  readonly bytesWritten: number;
  readonly channels: number;
  readonly createAfterDisposeCode: string;
  readonly maximumArtifactBytes: number | null;
  readonly mimeType: string;
  readonly name: string;
  readonly namespaceEntriesAfterDispose: number | null;
  readonly pendingStorage: 'memory' | 'opfs';
  readonly sampleRate: number;
  readonly storage: 'memory' | 'opfs';
}

interface OpfsAbortSmokeResult {
  readonly code: string;
  readonly originalPreserved: boolean;
  readonly size: number;
}

interface DestinationFailureResult {
  readonly code: string;
  readonly message: string;
  readonly name: string;
  readonly reason: string | null;
}

interface OutputLimitPreflightResult extends DestinationFailureResult {
  readonly writes: number;
}

interface WorkerErrorDiagnosticsResult {
  readonly arbitrary: {
    readonly message: string;
    readonly name: string;
    readonly stack: string | null;
  };
  readonly known: DestinationFailureResult;
  readonly unknown: {
    readonly hasCode: boolean;
    readonly hasReason: boolean;
    readonly message: string;
    readonly name: string;
    readonly stack: string | null;
  };
}

interface DemoCleanupFailureResult {
  readonly cleanupObserved: boolean;
  readonly discardAttempts: number;
  readonly primaryPreserved: boolean;
  readonly retrySucceeded: boolean;
}

declare global {
  interface Window {
    runAacConstraintMatrix(): Promise<BrowserAacMatrixResult>;
    runAiffConstraintMatrix(): Promise<BrowserAiffMatrixResult>;
    runAudioStreamMatrix(): Promise<readonly BrowserMatrixResult[]>;
    runBoundedStreamStress(): Promise<BrowserStressResult>;
    runDemoCleanupFailureRegression(): Promise<DemoCleanupFailureResult>;
    runDestinationFailureRegression(): Promise<DestinationFailureResult>;
    runFlacConstraintMatrix(): Promise<BrowserFlacMatrixResult>;
    runFlacProbeBudgetRegression(): Promise<BrowserFlacProbeBudgetResult>;
    runInputProbeMatrix(): Promise<InputProbeMatrixResult>;
    runMp3ConstraintMatrix(): Promise<BrowserMp3ConstraintMatrixResult>;
    runOggOpusConstraintMatrix(): Promise<BrowserOggOpusMatrixResult>;
    runOpfsAbortSmoke(): Promise<OpfsAbortSmokeResult>;
    runOutputLimitPreflight(): Promise<OutputLimitPreflightResult>;
    runOutputSupportProbe(): Promise<BrowserOutputSupportProbeResult>;
    runOutputSessionSmoke(): Promise<OutputSessionSmokeResult>;
    runWorkerErrorDiagnostics(): Promise<WorkerErrorDiagnosticsResult>;
    runWavConstraintMatrix(): Promise<BrowserWavMatrixResult>;
    runSingleOutputPreset(
      presetId: AudioStreamOutputPresetId,
    ): Promise<BrowserMatrixResult>;
  }
}

window.runAudioStreamMatrix = async () => {
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
  });
  const results: BrowserMatrixResult[] = [];

  try {
    for (const preset of AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputPresets) {
      results.push(
        await transcodePreset(
          engine,
          preset.id,
          preset.id.startsWith('ogg-opus-') ? 48_000 : SAMPLE_RATE,
        ),
      );
    }
  } finally {
    await engine.dispose();
  }

  return results;
};

window.runFlacConstraintMatrix = async () => {
  let worker: Worker | undefined;
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
    workerFactory: () => {
      worker = new Worker(new URL('./instrumented-worker.ts', import.meta.url), {
        type: 'module',
      });
      return worker;
    },
  });
  const format = AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputFormats.find(
    ({ id }) => id === 'flac',
  );
  if (format === undefined) {
    throw new Error('Public capabilities do not advertise FLAC output.');
  }
  const constraint = format.presets[0]?.target.sampleRate;
  if (constraint?.kind !== 'discrete') {
    throw new Error('Public FLAC capabilities must advertise discrete sample rates.');
  }
  const advertisedSampleRates = [...constraint.values];
  const invalidTargets = [
    { channels: 1, sampleRate: 7_999 },
    { channels: 1, sampleRate: 384_001 },
    { channels: 1, sampleRate: 12_345 },
    { channels: 0, sampleRate: advertisedSampleRates[0]! },
    { channels: 9, sampleRate: advertisedSampleRates[0]! },
  ] as const;

  try {
    const invalid: BrowserConstraintRejection[] = [];
    for (const presetId of ['flac-16bit', 'flac-24bit'] as const) {
      for (const target of invalidTargets) {
        invalid.push(await rejectTarget(engine, presetId, target));
      }
    }
    const resourcesBeforeAcceptedEncoding = await readWorkerResourceEntries(worker!);
    const accepted: BrowserMatrixResult[] = [];
    for (const presetId of ['flac-16bit', 'flac-24bit'] as const) {
      for (const sampleRate of advertisedSampleRates) {
        for (const channels of [1, 8] as const) {
          accepted.push(
            await transcodePreset(engine, presetId, sampleRate, channels, 1_024),
          );
        }
      }
    }
    return {
      accepted,
      advertisedSampleRates,
      invalid,
      resourcesBeforeAcceptedEncoding,
    };
  } finally {
    await engine.dispose();
  }
};

window.runWavConstraintMatrix = async () => {
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
  });
  try {
    const invalid: BrowserConstraintRejection[] = [];
    const invalidTargets = [
      { channels: 1, sampleRate: 7_999 },
      { channels: 1, sampleRate: 384_001 },
      { channels: 0, sampleRate: 8_000 },
      { channels: 33, sampleRate: 8_000 },
    ] as const;
    for (const presetId of [
      'wav-pcm16',
      'wav-pcm24',
      'wav-pcm32',
      'wav-float32',
    ] as const) {
      for (const target of invalidTargets) {
        invalid.push(await rejectTarget(engine, presetId, target));
      }
    }
    const accepted: BrowserMatrixResult[] = [];
    for (const presetId of [
      'wav-pcm16',
      'wav-pcm24',
      'wav-pcm32',
      'wav-float32',
    ] as const) {
      for (const sampleRate of [8_000, 384_000] as const) {
        for (const channels of [1, 32] as const) {
          accepted.push(
            await transcodePreset(engine, presetId, sampleRate, channels, 1_024),
          );
        }
      }
    }
    return { accepted, invalid };
  } finally {
    await engine.dispose();
  }
};

window.runAiffConstraintMatrix = async () => {
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
  });
  try {
    const invalid: BrowserConstraintRejection[] = [];
    const invalidTargets = [
      { channels: 1, sampleRate: 7_999 },
      { channels: 1, sampleRate: 384_001 },
      { channels: 0, sampleRate: 8_000 },
      { channels: 33, sampleRate: 8_000 },
    ] as const;
    for (const presetId of ['aiff-pcm16', 'aiff-pcm24'] as const) {
      for (const target of invalidTargets) {
        invalid.push(await rejectTarget(engine, presetId, target));
      }
    }
    const accepted: BrowserMatrixResult[] = [];
    for (const presetId of ['aiff-pcm16', 'aiff-pcm24'] as const) {
      for (const sampleRate of [8_000, 384_000] as const) {
        for (const channels of [1, 32] as const) {
          accepted.push(
            await transcodePreset(engine, presetId, sampleRate, channels, 1_024),
          );
        }
      }
    }
    return { accepted, invalid };
  } finally {
    await engine.dispose();
  }
};

window.runAacConstraintMatrix = async () => {
  let worker: Worker | undefined;
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
    workerFactory: () => {
      worker = new Worker(new URL('./instrumented-worker.ts', import.meta.url), {
        type: 'module',
      });
      return worker;
    },
  });
  try {
    const invalid: BrowserConstraintRejection[] = [];
    const invalidTargets = [
      { channels: 1, sampleRate: 31_999 },
      { channels: 1, sampleRate: 48_001 },
      { channels: 1, sampleRate: 24_000 },
      { channels: 1, sampleRate: 40_000 },
      { channels: 0, sampleRate: 32_000 },
      { channels: 3, sampleRate: 32_000 },
    ] as const;
    for (const presetId of AAC_PRESETS) {
      for (const target of invalidTargets) {
        invalid.push(await rejectTarget(engine, presetId, target));
      }
    }
    const resourcesBeforeAcceptedEncoding = await readWorkerResourceEntries(
      worker!,
    );
    const accepted: BrowserMatrixResult[] = [];
    for (const presetId of AAC_PRESETS) {
      for (const sampleRate of AAC_SAMPLE_RATES) {
        for (const channels of [1, 2] as const) {
          accepted.push(
            await transcodePreset(engine, presetId, sampleRate, channels, 2_057),
          );
        }
      }
    }
    return { accepted, invalid, resourcesBeforeAcceptedEncoding };
  } finally {
    await engine.dispose();
  }
};

window.runOggOpusConstraintMatrix = async () => {
  let worker: Worker | undefined;
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
    workerFactory: () => {
      worker = new Worker(new URL('./instrumented-worker.ts', import.meta.url), {
        type: 'module',
      });
      return worker;
    },
  });
  try {
    const invalid: BrowserConstraintRejection[] = [];
    const invalidTargets = [
      { channels: 1, sampleRate: 47_999 },
      { channels: 1, sampleRate: 48_001 },
      { channels: 1, sampleRate: 44_100 },
      { channels: 0, sampleRate: 48_000 },
      { channels: 3, sampleRate: 48_000 },
    ] as const;
    for (const presetId of OGG_OPUS_PRESETS) {
      for (const target of invalidTargets) {
        invalid.push(await rejectTarget(engine, presetId, target));
      }
    }
    const resourcesBeforeAcceptedEncoding = await readWorkerResourceEntries(
      worker!,
    );
    const accepted: BrowserMatrixResult[] = [];
    for (const presetId of OGG_OPUS_PRESETS) {
      for (const channels of [1, 2] as const) {
        accepted.push(
          await transcodePreset(engine, presetId, 48_000, channels, 48_137),
        );
      }
    }
    return { accepted, invalid, resourcesBeforeAcceptedEncoding };
  } finally {
    await engine.dispose();
  }
};

window.runFlacProbeBudgetRegression = async () => {
  const pool = createAudioTranscoderStreamWorkerPool({
    codecAssets: BROWSER_CODEC_ASSETS,
    concurrency: 1,
    idleTimeoutMs: null,
    maxQueued: 1,
  });
  try {
    const fixture = createConventionalFlacProbeFixture();
    const input = { blob: fixture, name: 'probe-budget.flac' };
    const lowBudgetBytes =
      AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.buffers.minimumBytes;
    let lowBudgetErrorCode: string | null = null;
    let lowBudgetStatus: string | null = null;
    try {
      const lowBudget = await pool.probeInputSupport(input, {
        inputReadBytes: lowBudgetBytes,
      });
      lowBudgetStatus = lowBudget.status;
    } catch (error) {
      lowBudgetErrorCode = errorCode(error);
    }
    const probeController = new AbortController();
    let probeDeadlineFired = false;
    const probeDeadline = setTimeout(() => {
      probeDeadlineFired = true;
      probeController.abort('input probe deadline');
    }, INPUT_PROBE_DEADLINE_MS);
    let adequateErrorCode: string | null = null;
    let adequateStatus: string | null = null;
    try {
      const adequate = await pool.probeInputSupport(input, {
        signal: probeController.signal,
      });
      adequateStatus = adequate.status;
    } catch (error) {
      adequateErrorCode = errorCode(error);
    } finally {
      clearTimeout(probeDeadline);
    }
    const sink = new SeekableMemorySink();
    let transcodeBytesWritten = 0;
    let transcodeErrorCode: string | null = null;
    let transcodeFormat: OutputFormat | null = null;
    let workersAfterDeadline: number | null = null;
    let recoveryStatus: string | null = null;
    let recoveryWorkers: number | null = null;
    const transcodeAttempted = adequateErrorCode === null;
    if (transcodeAttempted) {
      try {
        const result = await pool.transcode(
          input,
          {
            channels: 1,
            dither: 'none',
            presetId: 'wav-pcm16',
            sampleRate: SAMPLE_RATE,
          },
          sink.stream,
        );
        await sink.waitForClose();
        transcodeBytesWritten = result.bytesWritten;
        transcodeFormat = result.format;
      } catch (error) {
        transcodeErrorCode = errorCode(error);
      }
    } else if (adequateErrorCode === 'OPERATION_ABORTED') {
      workersAfterDeadline = pool.getQueueSnapshot().workers;
      const recovery = await pool.probeInputSupport(cafInput(1_024));
      recoveryStatus = recovery.status;
      recoveryWorkers = pool.getQueueSnapshot().workers;
    }
    return {
      adequateErrorCode,
      adequateStatus,
      fixtureBytes: fixture.size,
      lowBudgetBytes,
      lowBudgetErrorCode,
      lowBudgetStatus,
      probeDeadlineFired,
      transcodeBytesWritten,
      transcodeClosed: sink.closed,
      transcodeErrorCode,
      transcodeFormat,
      transcodeAttempted,
      transcodeWrites: sink.writes,
      workersAfterDeadline,
      recoveryStatus,
      recoveryWorkers,
    };
  } finally {
    await pool.dispose();
  }
};

window.runOutputSupportProbe = async () => {
  let worker: Worker | undefined;
  let disposed = false;
  let outputArtifactsCreated = 0;
  let probeResult: Omit<BrowserOutputSupportProbeResult, 'disposed'> | undefined;
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
    workerFactory: () => {
      worker = new Worker(new URL('./instrumented-worker.ts', import.meta.url), {
        type: 'module',
      });
      return worker;
    },
  });

  try {
    const invalidMp3 = await engine.probeOutputSupport({
      channels: 2,
      presetId: 'mp3-192kbps',
      sampleRate: 24_000,
    });
    const resourcesAfterInvalidMp3 = await readWorkerResourceEntries(worker!);
    const invalidAac = await engine.probeOutputSupport({
      channels: 2,
      presetId: 'aac-128kbps',
      sampleRate: 24_000,
    });
    const resourcesAfterInvalidAac = await readWorkerResourceEntries(worker!);
    const invalidOgg = await engine.probeOutputSupport({
      channels: 2,
      presetId: 'ogg-opus-128kbps',
      sampleRate: SAMPLE_RATE,
    });
    const resourcesAfterInvalidOgg = await readWorkerResourceEntries(worker!);
    const wav = await engine.probeOutputSupport({
      channels: 2,
      presetId: 'wav-pcm16',
      sampleRate: SAMPLE_RATE,
    });
    const resourcesAfterWav = await readWorkerResourceEntries(worker!);
    const aiff = await engine.probeOutputSupport({
      channels: 2,
      presetId: 'aiff-pcm16',
      sampleRate: SAMPLE_RATE,
    });
    const resourcesAfterAiff = await readWorkerResourceEntries(worker!);
    const aac = await engine.probeOutputSupport({
      channels: 2,
      presetId: 'aac-128kbps',
      sampleRate: SAMPLE_RATE,
    });
    const resourcesAfterAac = await readWorkerResourceEntries(worker!);
    const ogg = await engine.probeOutputSupport({
      channels: 2,
      presetId: 'ogg-opus-128kbps',
      sampleRate: 48_000,
    });
    const resourcesAfterOgg = await readWorkerResourceEntries(worker!);
    const mp3 = await engine.probeOutputSupport({
      channels: 2,
      presetId: 'mp3-128kbps',
      sampleRate: SAMPLE_RATE,
    });
    const resourcesAfterMp3 = await readWorkerResourceEntries(worker!);
    const flac = await engine.probeOutputSupport({
      channels: 2,
      presetId: 'flac-16bit',
      sampleRate: SAMPLE_RATE,
    });
    const resourcesAfterFlac = await readWorkerResourceEntries(worker!);

    // These public probes accept only exact targets; this harness has no output
    // sink, session, or artifact creation site that could increment the counter.
    probeResult = {
      aac: { code: aac.code, status: aac.status },
      aiff: { code: aiff.code, status: aiff.status },
      flac: { code: flac.code, status: flac.status },
      invalidAac: { code: invalidAac.code, status: invalidAac.status },
      invalidMp3: { code: invalidMp3.code, status: invalidMp3.status },
      invalidOgg: { code: invalidOgg.code, status: invalidOgg.status },
      mp3: { code: mp3.code, status: mp3.status },
      ogg: { code: ogg.code, status: ogg.status },
      outputArtifactsCreated,
      resourcesAfterAac,
      resourcesAfterAiff,
      resourcesAfterFlac,
      resourcesAfterInvalidAac,
      resourcesAfterInvalidMp3,
      resourcesAfterInvalidOgg,
      resourcesAfterMp3,
      resourcesAfterOgg,
      resourcesAfterWav,
      wav: { code: wav.code, status: wav.status },
    };
  } finally {
    await engine.dispose();
    disposed = true;
  }

  if (probeResult === undefined) {
    throw new Error('Output support probes did not complete.');
  }
  return { ...probeResult, disposed };
};

window.runSingleOutputPreset = async (presetId) => {
  let worker: Worker | undefined;
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
    workerFactory: () => {
      worker = new Worker(new URL('./instrumented-worker.ts', import.meta.url), {
        type: 'module',
      });
      return worker;
    },
  });
  try {
    const result = await transcodePreset(
      engine,
      presetId,
      presetId.startsWith('ogg-opus-') ? 48_000 : SAMPLE_RATE,
    );
    return {
      ...result,
      workerResources: await readWorkerResourceEntries(worker!),
    };
  } finally {
    await engine.dispose();
  }
};

window.runMp3ConstraintMatrix = async () => {
  let worker: Worker | undefined;
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
    workerFactory: () => {
      worker = new Worker(new URL('./instrumented-worker.ts', import.meta.url), {
        type: 'module',
      });
      return worker;
    },
  });
  const invalid: Array<{
    errorCode: string;
    presetId: AudioStreamOutputPresetId;
    sampleRate: number;
  }> = [];

  try {
    for (const sampleRate of MP3_128KBPS_REJECTED_SAMPLE_RATES) {
      try {
        await transcodePreset(engine, 'mp3-128kbps', sampleRate);
        invalid.push({
          errorCode: 'NO_ERROR',
          presetId: 'mp3-128kbps',
          sampleRate,
        });
      } catch (error) {
        invalid.push({
          errorCode: errorCode(error),
          presetId: 'mp3-128kbps',
          sampleRate,
        });
      }
    }
    for (const presetId of MP3_HIGH_BITRATE_PRESETS) {
      for (const sampleRate of MP3_REJECTED_SAMPLE_RATES) {
        try {
          await transcodePreset(engine, presetId, sampleRate);
          invalid.push({ errorCode: 'NO_ERROR', presetId, sampleRate });
        } catch (error) {
          invalid.push({ errorCode: errorCode(error), presetId, sampleRate });
        }
      }
    }

    const resourcesBeforeAcceptedEncoding = await readWorkerResourceEntries(
      worker!,
    );
    const accepted: BrowserMatrixResult[] = [];
    for (const [presetId, sampleRates] of MP3_ACCEPTED_MATRIX) {
      for (const sampleRate of sampleRates) {
        accepted.push(await transcodePreset(engine, presetId, sampleRate));
      }
    }

    return { accepted, invalid, resourcesBeforeAcceptedEncoding };
  } finally {
    await engine.dispose();
  }
};

window.runInputProbeMatrix = async () => {
  const capabilities = AUDIO_TRANSCODER_STREAM_CAPABILITIES;
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
  });

  try {
    const source = cafInput(INPUT_FIXTURE_FRAMES);
    const mp3 = await encodeFixture(engine, source, 'mp3-128kbps');
    const flac = await encodeFixture(engine, source, 'flac-16bit');
    const fixtures: readonly Fixture[] = [
      {
        capabilityId: 'caf-lpcm',
        input: source,
        name: 'caf',
      },
      {
        capabilityId: 'aiff-pcm',
        input: {
          blob: createPcm16Aiff(INPUT_FIXTURE_FRAMES),
          name: 'matrix.aiff',
        },
        name: 'aiff',
      },
      {
        capabilityId: 'wave',
        input: {
          blob: createPcm16Wav(INPUT_FIXTURE_FRAMES),
          name: 'matrix.wav',
        },
        name: 'wav',
      },
      {
        capabilityId: 'mp3',
        input: { blob: mp3, name: 'matrix.mp3' },
        name: 'mp3',
      },
      {
        capabilityId: 'flac',
        input: { blob: flac, name: 'matrix.flac' },
        name: 'flac',
      },
      {
        capabilityId: null,
        input: {
          blob: new Blob(['not an audio container'], {
            type: 'application/octet-stream',
          }),
          name: 'unknown.bin',
        },
        name: 'unknown',
      },
    ];

    const results: InputProbeFixtureResult[] = [];
    for (const fixture of fixtures) {
      results.push(await probeFixture(engine, fixture));
    }

    return {
      advertised: capabilities.inputFormats.map((format) => ({
        extensionHints: [...format.extensionHints],
        id: format.id,
        path: format.path,
      })),
      fixtures: results,
    };
  } finally {
    await engine.dispose();
  }
};

window.runBoundedStreamStress = async () => {
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
  });
  const sink = new SlowSeekableDiscardSink();
  let progressEvents = 0;

  try {
    const result = await engine.transcode(
      cafInput(2_000_000),
      {
        channels: 1,
        dither: 'none',
        presetId: 'wav-pcm24',
        sampleRate: SAMPLE_RATE,
      },
      sink.stream,
      {
        inputReadBytes: CHUNK_BYTES,
        onProgress: () => {
          progressEvents += 1;
        },
        outputChunkBytes: CHUNK_BYTES,
        pcmChunkBytes: CHUNK_BYTES,
      },
    );
    return {
      bytesWritten: result.bytesWritten,
      closed: sink.closed,
      maxChunkBytes: sink.maxChunkBytes,
      progressEvents,
      writes: sink.writes,
    };
  } finally {
    await engine.dispose();
  }
};

window.runDestinationFailureRegression = async () => {
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
  });
  const destinationError = new AudioTranscoderError(
    'RESOURCE_LIMIT_EXCEEDED',
    'browser destination quota exceeded',
    { reason: 'output-storage-limit' },
  );

  try {
    await engine.transcode(
      cafInput(MATRIX_FRAMES),
      {
        channels: 1,
        dither: 'none',
        presetId: 'wav-pcm16',
        sampleRate: SAMPLE_RATE,
      },
      new WritableStream<AudioStreamOutputChunk>({
        write() {
          throw destinationError;
        },
      }),
      {
        inputReadBytes: CHUNK_BYTES,
        outputChunkBytes: CHUNK_BYTES,
        pcmChunkBytes: CHUNK_BYTES,
      },
    );
    return { code: 'NO_ERROR', message: '', name: '', reason: null };
  } catch (error) {
    return {
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : typeof error,
      reason: errorReason(error),
    };
  } finally {
    await engine.dispose();
  }
};

window.runOutputLimitPreflight = async () => {
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
  });
  const sink = new SeekableMemorySink();

  try {
    await engine.transcode(
      cafInput(MATRIX_FRAMES),
      {
        channels: 1,
        dither: 'none',
        presetId: 'wav-pcm24',
        sampleRate: SAMPLE_RATE,
      },
      sink.stream,
      {
        maxOutputBytes: 1,
        outputChunkBytes: CHUNK_BYTES,
      },
    );
    return {
      code: 'NO_ERROR',
      message: '',
      name: '',
      reason: null,
      writes: sink.writes,
    };
  } catch (error) {
    return {
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : typeof error,
      reason: errorReason(error),
      writes: sink.writes,
    };
  } finally {
    await engine.dispose();
  }
};

window.runWorkerErrorDiagnostics = async () => {
  const engine = createAudioTranscoderStreamWorkerEngine({
    codecAssets: BROWSER_CODEC_ASSETS,
    workerFactory: () =>
      new Worker(new URL('./diagnostic-worker.ts', import.meta.url), {
        type: 'module',
      }),
  });

  try {
    const known = await captureWorkerDiagnostic(engine, 'known');
    const unknown = await captureWorkerDiagnostic(engine, 'unknown');
    const arbitrary = await captureWorkerDiagnostic(engine, 'arbitrary');

    return {
      arbitrary: {
        message: arbitrary.message,
        name: arbitrary.name,
        stack: arbitrary.stack ?? null,
      },
      known: {
        code: errorCode(known),
        message: known.message,
        name: known.name,
        reason: errorReason(known),
      },
      unknown: {
        hasCode: 'code' in unknown,
        hasReason: 'reason' in unknown,
        message: unknown.message,
        name: unknown.name,
        stack: unknown.stack ?? null,
      },
    };
  } finally {
    await engine.dispose();
  }
};

window.runDemoCleanupFailureRegression = async () => {
  const primaryError = new Error('transcode failed');
  const cleanupError = new Error('OPFS removal failed');
  const originalConsoleError = console.error;
  let cleanupObserved = false;
  let discardAttempts = 0;
  let handledError: unknown;
  let retrySucceeded = false;
  const pending = {
    async discard() {
      discardAttempts += 1;
      if (discardAttempts === 1) {
        throw cleanupError;
      }
    },
  } as unknown as NonNullable<
    Parameters<typeof discardPendingOutputAfterFailure>[0]
  >;

  console.error = (message?: unknown, details?: unknown): void => {
    cleanupObserved =
      message ===
        'Output cleanup failed; output-session disposal will retry it.' &&
      details !== null &&
      typeof details === 'object' &&
      'cleanupError' in details &&
      details.cleanupError === cleanupError &&
      'primaryError' in details &&
      details.primaryError === primaryError;
  };
  try {
    try {
      throw primaryError;
    } catch (error) {
      await discardPendingOutputAfterFailure(pending, error);
      handledError = error;
    }
    await pending.discard();
    retrySucceeded = true;
  } finally {
    console.error = originalConsoleError;
  }

  return {
    cleanupObserved,
    discardAttempts,
    primaryPreserved: handledError === primaryError,
    retrySucceeded,
  };
};

window.runOutputSessionSmoke = async () => {
  const namespace = `matrix-${crypto.randomUUID()}`;
  const session = createAudioTranscoderOutputSession({
    memoryLimitBytes: 2 * 1024 * 1024,
    namespace,
  });
  let engine: AudioTranscoderStreamWorkerEngine | undefined =
    createAudioTranscoderStreamWorkerEngine({
      codecAssets: BROWSER_CODEC_ASSETS,
    });
  let pending: Awaited<ReturnType<typeof session.create>> | undefined;
  let artifact:
    | Awaited<ReturnType<NonNullable<typeof pending>['complete']>>
    | undefined;

  try {
    const storage = await session.getStorageMode();
    pending = await session.create({
      maxMemoryArtifactBytes: 1024 * 1024,
    });
    const maximumArtifactBytes = pending.maxOutputBytes ?? null;
    const result = await engine.transcode(
      cafInput(MATRIX_FRAMES),
      {
        channels: 1,
        dither: 'none',
        presetId: 'wav-pcm24',
        sampleRate: SAMPLE_RATE,
      },
      pending.stream,
      {
        ...(maximumArtifactBytes === null
          ? {}
          : { maxOutputBytes: maximumArtifactBytes }),
        outputChunkBytes: CHUNK_BYTES,
      },
    );

    await engine.dispose();
    engine = undefined;
    artifact = await pending.complete({
      mimeType: 'audio/wav',
      name: 'session-output.wav',
    });
    const header = inspectWav(
      new Uint8Array(await artifact.blob.arrayBuffer()),
    );
    const artifactSize = artifact.size;
    const artifactStorage = artifact.storage;
    const mimeType = artifact.mimeType;
    const name = artifact.name;
    const pendingStorage = pending.storage;

    await artifact.dispose();
    await artifact.dispose();
    artifact = undefined;
    await session.dispose();
    await session.dispose();

    let createAfterDisposeCode = 'NO_ERROR';
    try {
      await session.create();
    } catch (error) {
      createAfterDisposeCode = errorCode(error);
    }

    return {
      artifactSize,
      artifactStorage,
      bitDepth: header.bitDepth,
      bytesWritten: result.bytesWritten,
      channels: header.channels,
      createAfterDisposeCode,
      maximumArtifactBytes,
      mimeType,
      name,
      namespaceEntriesAfterDispose:
        storage === 'opfs' ? await countNamespaceEntries(namespace) : null,
      pendingStorage,
      sampleRate: header.sampleRate,
      storage,
    };
  } finally {
    await engine?.dispose().catch(() => undefined);
    await artifact?.dispose().catch(() => undefined);
    await pending?.discard().catch(() => undefined);
    await session.dispose().catch(() => undefined);
  }
};

window.runOpfsAbortSmoke = async () => {
  if (navigator.storage.getDirectory === undefined) {
    throw new Error('Origin private file system is unavailable.');
  }
  const name = 'audio-transcoder-browser-abort.wav';
  const original = new Uint8Array([0x64, 0x73, 0x75, 0x62]);
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, { create: true });
  const seed = await handle.createWritable();
  await seed.write(original);
  await seed.close();

  const output = await handle.createWritable();
  let engine: AudioTranscoderStreamWorkerEngine | undefined =
    createAudioTranscoderStreamWorkerEngine({
      codecAssets: BROWSER_CODEC_ASSETS,
    });
  const controller = new AbortController();
  let code = 'NO_ERROR';

  try {
    const operation = engine.transcode(
      cafInput(2_000_000),
      {
        channels: 1,
        dither: 'none',
        presetId: 'wav-pcm24',
        sampleRate: SAMPLE_RATE,
      },
      output,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort('browser cancellation'), 0);
    try {
      await operation;
    } catch (error) {
      code = errorCode(error);
    }

    await engine.dispose();
    engine = undefined;
    const file = await handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      code,
      originalPreserved:
        bytes.length === original.length &&
        bytes.every((value, index) => value === original[index]),
      size: bytes.length,
    };
  } finally {
    await engine?.dispose().catch(() => undefined);
    await root.removeEntry(name).catch(() => undefined);
  }
};

async function transcodePreset(
  engine: AudioTranscoderStreamWorkerEngine,
  presetId: AudioStreamOutputPresetId,
  targetSampleRate = SAMPLE_RATE,
  targetChannels = CHANNELS,
  fixtureFrames = MATRIX_FRAMES,
): Promise<BrowserMatrixResult> {
  const sink = new SeekableMemorySink();
  const progress: number[] = [];
  const result = await engine.transcode(
    cafInput(fixtureFrames, targetChannels, targetSampleRate),
    {
      channels: targetChannels,
      dither: 'none',
      presetId,
      sampleRate: targetSampleRate,
    } as AudioStreamTarget,
    sink.stream,
    {
      inputReadBytes: CHUNK_BYTES,
      onProgress: (event) => progress.push(event.progress),
      outputChunkBytes: CHUNK_BYTES,
      pcmChunkBytes: CHUNK_BYTES,
    },
  );
  const closedBeforeResolved = sink.closed;
  await sink.waitForClose();
  const bytes = sink.bytes();
  const format = result.format;

  let aacFrames: number | null = null;
  let aacObjectType: number | null = null;
  let aiffFormBytes: number | null = null;
  let aiffFrames: number | null = null;
  let aiffSoundBytes: number | null = null;
  let bitDepth: number | null = null;
  let bitrate: number | null = null;
  let channels = 0;
  let flacAudioFrame: boolean | null = null;
  let flacTotalSamples: number | null = null;
  let formatTag: number | null = null;
  let mp3Frames: number | null = null;
  let mp3FrameBitrates: readonly number[] | null = null;
  let mp3SeekHeader: 'Info' | 'Xing' | null = null;
  let mp3SeekHeaderFrames: number | null = null;
  let oggEos: boolean | null = null;
  let oggFinalGranule: number | null = null;
  let oggPages: number | null = null;
  let oggPreSkip: number | null = null;
  let oggSerial: number | null = null;
  let sampleRate = 0;
  let wavBlockAlign: number | null = null;
  let wavByteRate: number | null = null;
  let wavDataBytes: number | null = null;
  let wavDataEndsAtFileEnd: boolean | null = null;
  let wavDataChunks: number | null = null;
  let wavFmtBytes: number | null = null;
  let wavFmtChunks: number | null = null;
  let wavFrames: number | null = null;
  let wavRiffBytes: number | null = null;

  switch (format) {
    case 'aac': {
      const header = inspectAdts(bytes);
      aacFrames = header.frames;
      aacObjectType = header.objectType;
      channels = header.channels;
      sampleRate = header.sampleRate;
      break;
    }
    case 'aiff': {
      const header = inspectAiff(bytes);
      aiffFormBytes = header.formBytes;
      aiffFrames = header.frames;
      aiffSoundBytes = header.soundBytes;
      bitDepth = header.bitDepth;
      channels = header.channels;
      sampleRate = header.sampleRate;
      break;
    }
    case 'wav': {
      const header = inspectWav(bytes);
      bitDepth = header.bitDepth;
      channels = header.channels;
      formatTag = header.formatTag;
      sampleRate = header.sampleRate;
      wavBlockAlign = header.blockAlign;
      wavByteRate = header.byteRate;
      wavDataBytes = header.dataBytes;
      wavDataEndsAtFileEnd = header.dataEndsAtFileEnd;
      wavDataChunks = header.dataChunks;
      wavFmtBytes = header.fmtBytes;
      wavFmtChunks = header.fmtChunks;
      wavFrames = header.frames;
      wavRiffBytes = header.riffBytes;
      break;
    }
    case 'mp3': {
      const header = inspectMp3(bytes);
      bitrate = header.bitrate;
      channels = header.channels;
      mp3Frames = header.frames;
      mp3FrameBitrates = header.frameBitrates;
      mp3SeekHeader = header.seekHeader;
      mp3SeekHeaderFrames = header.seekHeaderFrames;
      sampleRate = header.sampleRate;
      break;
    }
    case 'flac': {
      const header = inspectFlac(bytes);
      bitDepth = header.bitDepth;
      channels = header.channels;
      flacAudioFrame = header.hasAudioFrame;
      flacTotalSamples = header.totalSamples;
      sampleRate = header.sampleRate;
      break;
    }
    case 'ogg': {
      const header = inspectOggOpus(bytes);
      channels = header.channels;
      oggEos = header.eos;
      oggFinalGranule = header.finalGranule;
      oggPages = header.pages;
      oggPreSkip = header.preSkip;
      oggSerial = header.serial;
      sampleRate = header.sampleRate;
      break;
    }
  }

  return {
    aacFrames,
    aacObjectType,
    aiffFormBytes,
    aiffFrames,
    aiffSoundBytes,
    bitDepth,
    bitrate,
    bytesWritten: result.bytesWritten,
    channels,
    closedBeforeResolved,
    finalSize: bytes.byteLength,
    flacAudioFrame,
    flacTotalSamples,
    expectedTotalSamples: fixtureFrames,
    format,
    formatTag,
    maxChunkBytes: sink.maxChunkBytes,
    mp3Frames,
    mp3FrameBitrates,
    mp3SeekHeader,
    mp3SeekHeaderFrames,
    oggEos,
    oggFinalGranule,
    oggPages,
    oggPreSkip,
    oggSerial,
    presetId,
    progress,
    resultDetailsFormat: result.details.format,
    resultFormat: result.format,
    resultPresetId: result.preset.id,
    resultRf64: result.format === 'wav' ? result.details.rf64 : null,
    sampleRate,
    wavBlockAlign,
    wavByteRate,
    wavDataBytes,
    wavDataEndsAtFileEnd,
    wavDataChunks,
    wavFmtBytes,
    wavFmtChunks,
    wavFrames,
    wavRiffBytes,
    writes: sink.writes,
    workerResources: [],
  };
}

async function rejectTarget(
  engine: AudioTranscoderStreamWorkerEngine,
  presetId: AudioStreamOutputPresetId,
  target: Readonly<{ channels: number; sampleRate: number }>,
): Promise<BrowserConstraintRejection> {
  const sink = new SeekableMemorySink();
  let code = 'NO_ERROR';
  try {
    await engine.transcode(
      cafInput(1_024),
      { ...target, dither: 'none', presetId } as AudioStreamTarget,
      sink.stream,
      {
        inputReadBytes: CHUNK_BYTES,
        outputChunkBytes: CHUNK_BYTES,
        pcmChunkBytes: CHUNK_BYTES,
      },
    );
  } catch (error) {
    code = errorCode(error);
  }
  return { ...target, errorCode: code, presetId, writes: sink.writes };
}

async function readWorkerResourceEntries(worker: Worker): Promise<readonly string[]> {
  const token = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.removeEventListener('message', onMessage);
      reject(new Error('Timed out reading Worker resource entries.'));
    }, 5_000);
    const onMessage = (event: MessageEvent<unknown>): void => {
      const value = event.data;
      if (
        value === null ||
        typeof value !== 'object' ||
        !('type' in value) ||
        value.type !== 'browser-matrix:resource-entries' ||
        !('token' in value) ||
        value.token !== token ||
        !('entries' in value) ||
        !Array.isArray(value.entries)
      ) {
        return;
      }
      clearTimeout(timeout);
      worker.removeEventListener('message', onMessage);
      resolve(value.entries.filter((entry): entry is string => typeof entry === 'string'));
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ token, type: 'browser-matrix:resource-entries' });
  });
}

interface Fixture {
  readonly capabilityId: string | null;
  readonly input: AudioStreamInput;
  readonly name: InputProbeFixtureResult['fixture'];
}

async function probeFixture(
  engine: AudioTranscoderStreamWorkerEngine,
  fixture: Fixture,
): Promise<InputProbeFixtureResult> {
  const capability =
    fixture.capabilityId === null
      ? undefined
      : AUDIO_TRANSCODER_STREAM_CAPABILITIES.inputFormats.find(
          ({ id }) => id === fixture.capabilityId,
        );
  const probe = await engine.probeInputSupport(fixture.input);
  const sink = new SeekableMemorySink();
  let transcodeSucceeded = false;
  let code: string | null = null;
  let errorMessage: string | null = null;
  let errorName: string | null = null;
  try {
    await engine.transcode(
      fixture.input,
      {
        channels: 1,
        dither: 'none',
        presetId: 'wav-pcm16',
        sampleRate: SAMPLE_RATE,
      },
      sink.stream,
      {
        inputReadBytes: CHUNK_BYTES,
        outputChunkBytes: CHUNK_BYTES,
        pcmChunkBytes: CHUNK_BYTES,
      },
    );
    await sink.waitForClose();
    transcodeSucceeded = true;
  } catch (error) {
    code = errorCode(error);
    errorMessage = error instanceof Error ? error.message : String(error);
    errorName = error instanceof Error ? error.name : null;
  }

  return {
    capabilityId: capability?.id ?? null,
    capabilityPath: capability?.path ?? null,
    container: probe.inspection?.container ?? null,
    decodeSupport: probe.inspection?.decodeSupport ?? null,
    errorCode: code,
    errorMessage,
    errorName,
    fixture: fixture.name,
    probeStatus: probe.status,
    transcodeSucceeded,
  };
}

async function encodeFixture(
  engine: AudioTranscoderStreamWorkerEngine,
  input: AudioStreamInput,
  presetId: 'flac-16bit' | 'mp3-128kbps',
): Promise<Blob> {
  const sink = new SeekableMemorySink();
  const result = await engine.transcode(
    input,
    {
      channels: CHANNELS,
      dither: 'none',
      presetId,
      sampleRate: SAMPLE_RATE,
    },
    sink.stream,
    {
      inputReadBytes: CHUNK_BYTES,
      outputChunkBytes: CHUNK_BYTES,
      pcmChunkBytes: CHUNK_BYTES,
    },
  );
  await sink.waitForClose();
  return new Blob([sink.bytes()], { type: result.preset.mimeType });
}

function createConventionalFlacProbeFixture(): Blob {
  const frames = 16_375;
  const header = [0xff, 0xf8, 0x79, 0x18, 0x00, 0x3f, 0xf6];
  header.push(flacCrc8(header));
  const frame = new Uint8Array(header.length + 2 + frames * CHANNELS * 2 + 2);
  frame.set(header);
  let frameOffset = header.length;
  for (let channel = 0; channel < CHANNELS; channel += 1) {
    frame[frameOffset++] = 0x02;
    for (let index = 0; index < frames; index += 1) {
      const sample = Math.round(sampleAt(index, channel) * 0x7fff);
      frame[frameOffset++] = (sample >> 8) & 0xff;
      frame[frameOffset++] = sample & 0xff;
    }
  }
  const frameCrc = flacCrc16(frame.subarray(0, -2));
  frame[frameOffset++] = frameCrc >>> 8;
  frame[frameOffset] = frameCrc & 0xff;

  const bytes = new Uint8Array(4 + 4 + 34 + frame.byteLength);
  bytes.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22]);
  const streamInfo = new DataView(bytes.buffer, 8, 34);
  streamInfo.setUint16(0, frames);
  streamInfo.setUint16(2, frames);
  streamInfo.setUint8(4, frame.byteLength >>> 16);
  streamInfo.setUint8(5, frame.byteLength >>> 8);
  streamInfo.setUint8(6, frame.byteLength);
  streamInfo.setUint8(7, frame.byteLength >>> 16);
  streamInfo.setUint8(8, frame.byteLength >>> 8);
  streamInfo.setUint8(9, frame.byteLength);
  const packed =
    (BigInt(SAMPLE_RATE) << 44n) |
    (BigInt(CHANNELS - 1) << 41n) |
    (15n << 36n) |
    BigInt(frames);
  streamInfo.setBigUint64(10, packed);
  bytes.set(frame, 42);
  return new Blob([bytes], { type: 'audio/flac' });
}

function flacCrc8(bytes: readonly number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc << 1) ^ ((crc & 0x80) === 0 ? 0 : 0x07)) & 0xff;
    }
  }
  return crc;
}

function flacCrc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc << 1) ^ ((crc & 0x8000) === 0 ? 0 : 0x8005)) & 0xffff;
    }
  }
  return crc;
}

function cafInput(
  frames: number,
  channels = CHANNELS,
  sampleRate = SAMPLE_RATE,
): AudioStreamInput {
  return {
    blob: createFloat32Caf(frames, channels, sampleRate),
    name: 'browser-matrix.caf',
  };
}

function createFloat32Caf(
  frames: number,
  channels: number,
  sampleRate: number,
): Blob {
  const bytesPerSample = 4;
  const payloadBytes = frames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(68 + payloadBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'caff');
  view.setUint16(4, 1, false);
  writeAscii(view, 8, 'desc');
  view.setBigInt64(12, 32n, false);
  view.setFloat64(20, sampleRate, false);
  writeAscii(view, 28, 'lpcm');
  // CAF LPCM flags: float (1); a clear endian bit means big-endian.
  view.setUint32(32, 1, false);
  view.setUint32(36, bytesPerSample * channels, false);
  view.setUint32(40, 1, false);
  view.setUint32(44, channels, false);
  view.setUint32(48, 32, false);
  writeAscii(view, 52, 'data');
  view.setBigInt64(56, BigInt(payloadBytes + 4), false);

  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      view.setFloat32(
        68 + (frame * channels + channel) * bytesPerSample,
        sampleAt(frame, channel),
        false,
      );
    }
  }

  return new Blob([buffer], { type: 'audio/x-caf' });
}

function createPcm16Wav(frames: number): Blob {
  const bytesPerSample = 2;
  const dataBytes = frames * CHANNELS * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * CHANNELS * bytesPerSample, true);
  view.setUint16(32, CHANNELS * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  writePcm16(view, 44, frames, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

function createPcm16Aiff(frames: number): Blob {
  const bytesPerSample = 2;
  const dataBytes = frames * CHANNELS * bytesPerSample;
  const buffer = new ArrayBuffer(54 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'FORM');
  view.setUint32(4, buffer.byteLength - 8, false);
  writeAscii(view, 8, 'AIFF');
  writeAscii(view, 12, 'COMM');
  view.setUint32(16, 18, false);
  view.setUint16(20, CHANNELS, false);
  view.setUint32(22, frames, false);
  view.setUint16(26, 16, false);
  writeSampleRate44100Extended80(view, 28);
  writeAscii(view, 38, 'SSND');
  view.setUint32(42, dataBytes + 8, false);
  view.setUint32(46, 0, false);
  view.setUint32(50, 0, false);
  writePcm16(view, 54, frames, false);
  return new Blob([buffer], { type: 'audio/aiff' });
}

function writePcm16(
  view: DataView,
  offset: number,
  frames: number,
  littleEndian: boolean,
): void {
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const sample = Math.max(-1, Math.min(1, sampleAt(frame, channel)));
      view.setInt16(
        offset + (frame * CHANNELS + channel) * 2,
        Math.round(sample * 0x7fff),
        littleEndian,
      );
    }
  }
}

function sampleAt(frame: number, channel: number): number {
  return 0.5 * Math.sin((2 * Math.PI * (frame + channel * 7)) / 31);
}

function writeSampleRate44100Extended80(view: DataView, offset: number): void {
  const bytes = [0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0] as const;
  for (let index = 0; index < bytes.length; index += 1) {
    view.setUint8(offset + index, bytes[index]);
  }
}

function inspectAdts(bytes: Uint8Array): {
  readonly channels: number;
  readonly frames: number;
  readonly objectType: number;
  readonly sampleRate: number;
} {
  const sampleRates = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050,
    16_000, 12_000, 11_025, 8_000, 7_350,
  ] as const;
  let channels: number | undefined;
  let frames = 0;
  let objectType: number | undefined;
  let offset = skipId3v2(bytes);
  let sampleRate: number | undefined;

  while (offset < bytes.byteLength) {
    if (
      offset + 7 > bytes.byteLength ||
      bytes[offset] !== 0xff ||
      (bytes[offset + 1]! & 0xf6) !== 0xf0
    ) {
      throw new Error(`Output ADTS frame ${frames} has an invalid sync header.`);
    }
    const protectionAbsent = (bytes[offset + 1]! & 1) === 1;
    const headerBytes = protectionAbsent ? 7 : 9;
    const frameObjectType = ((bytes[offset + 2]! >> 6) & 0x03) + 1;
    const sampleRateIndex = (bytes[offset + 2]! >> 2) & 0x0f;
    const frameSampleRate = sampleRates[sampleRateIndex];
    const frameChannels =
      ((bytes[offset + 2]! & 1) << 2) | (bytes[offset + 3]! >> 6);
    const frameBytes =
      ((bytes[offset + 3]! & 0x03) << 11) |
      (bytes[offset + 4]! << 3) |
      (bytes[offset + 5]! >> 5);
    const rawDataBlocks = (bytes[offset + 6]! & 0x03) + 1;
    if (
      frameSampleRate === undefined ||
      frameChannels === 0 ||
      rawDataBlocks !== 1 ||
      frameBytes <= headerBytes ||
      offset + frameBytes > bytes.byteLength
    ) {
      throw new Error(`Output ADTS frame ${frames} has invalid metadata.`);
    }
    if (
      (objectType !== undefined && objectType !== frameObjectType) ||
      (sampleRate !== undefined && sampleRate !== frameSampleRate) ||
      (channels !== undefined && channels !== frameChannels)
    ) {
      throw new Error('Output ADTS frames disagree on their audio configuration.');
    }
    objectType = frameObjectType;
    sampleRate = frameSampleRate;
    channels = frameChannels;
    frames += 1;
    offset += frameBytes;
  }
  if (
    frames === 0 ||
    offset !== bytes.byteLength ||
    objectType === undefined ||
    sampleRate === undefined ||
    channels === undefined
  ) {
    throw new Error('Output is not a complete ADTS stream.');
  }
  return { channels, frames, objectType, sampleRate };
}

function inspectOggOpus(bytes: Uint8Array): {
  readonly channels: number;
  readonly eos: boolean;
  readonly finalGranule: number;
  readonly pages: number;
  readonly preSkip: number;
  readonly sampleRate: number;
  readonly serial: number;
} {
  let channels: number | undefined;
  let eos = false;
  let finalGranule: bigint | undefined;
  let offset = 0;
  let pages = 0;
  let preSkip: number | undefined;
  let sampleRate: number | undefined;
  let serial: number | undefined;

  while (offset < bytes.byteLength) {
    if (
      offset + 27 > bytes.byteLength ||
      readAscii(bytes, offset, 4) !== 'OggS' ||
      bytes[offset + 4] !== 0
    ) {
      throw new Error(`Output Ogg page ${pages} has an invalid header.`);
    }
    const segments = bytes[offset + 26]!;
    const headerBytes = 27 + segments;
    if (offset + headerBytes > bytes.byteLength) {
      throw new Error(`Output Ogg page ${pages} has a truncated segment table.`);
    }
    let bodyBytes = 0;
    for (let index = 0; index < segments; index += 1) {
      bodyBytes += bytes[offset + 27 + index]!;
    }
    const pageBytes = headerBytes + bodyBytes;
    if (offset + pageBytes > bytes.byteLength) {
      throw new Error(`Output Ogg page ${pages} has a truncated body.`);
    }
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset,
      pageBytes,
    );
    if (
      view.getUint32(22, true) !==
      computeOggChecksum(bytes.subarray(offset, offset + pageBytes))
    ) {
      throw new Error(`Output Ogg page ${pages} has an invalid checksum.`);
    }
    const flags = bytes[offset + 5]!;
    const pageSerial = view.getUint32(14, true);
    const sequence = view.getUint32(18, true);
    if (sequence !== pages || (serial !== undefined && serial !== pageSerial)) {
      throw new Error('Output Ogg pages have an invalid sequence or serial number.');
    }
    if (pages === 0) {
      if ((flags & 0x02) === 0 || bodyBytes < 19) {
        throw new Error('Output Ogg stream is missing its BOS OpusHead packet.');
      }
      const bodyOffset = offset + headerBytes;
      if (readAscii(bytes, bodyOffset, 8) !== 'OpusHead') {
        throw new Error('Output Ogg stream does not begin with OpusHead.');
      }
      channels = bytes[bodyOffset + 9]!;
      preSkip = view.getUint16(headerBytes + 10, true);
      sampleRate = view.getUint32(headerBytes + 12, true);
      if (
        bytes[bodyOffset + 8] !== 1 ||
        channels < 1 ||
        channels > 2 ||
        bytes[bodyOffset + 18] !== 0
      ) {
        throw new Error('Output OpusHead has an unsupported channel mapping.');
      }
    } else if (pages === 1) {
      const bodyOffset = offset + headerBytes;
      if (
        (flags & 0x02) !== 0 ||
        bodyBytes < 8 ||
        readAscii(bytes, bodyOffset, 8) !== 'OpusTags'
      ) {
        throw new Error('Output Ogg stream is missing its OpusTags packet.');
      }
    } else if ((flags & 0x02) !== 0) {
      throw new Error('Output Ogg stream contains more than one BOS page.');
    }
    if (eos || ((flags & 0x04) !== 0 && offset + pageBytes !== bytes.byteLength)) {
      throw new Error('Output Ogg EOS page is not the final page.');
    }
    eos = (flags & 0x04) !== 0;
    finalGranule = view.getBigInt64(6, true);
    serial = pageSerial;
    pages += 1;
    offset += pageBytes;
  }
  if (
    pages < 3 ||
    !eos ||
    finalGranule === undefined ||
    finalGranule < 0n ||
    finalGranule > BigInt(Number.MAX_SAFE_INTEGER) ||
    preSkip === undefined ||
    sampleRate === undefined ||
    channels === undefined ||
    serial === undefined
  ) {
    throw new Error('Output is not a complete bounded Ogg Opus stream.');
  }
  return {
    channels,
    eos,
    finalGranule: Number(finalGranule),
    pages,
    preSkip,
    sampleRate,
    serial,
  };
}

function computeOggChecksum(page: Uint8Array): number {
  let checksum = 0;
  for (let index = 0; index < page.byteLength; index += 1) {
    const byte = index >= 22 && index < 26 ? 0 : page[index]!;
    checksum = (checksum ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum =
        ((checksum << 1) ^ ((checksum & 0x8000_0000) === 0 ? 0 : 0x04c1_1db7)) >>>
        0;
    }
  }
  return checksum;
}

function inspectAiff(bytes: Uint8Array): {
  readonly bitDepth: number;
  readonly channels: number;
  readonly formBytes: number;
  readonly frames: number;
  readonly sampleRate: number;
  readonly soundBytes: number;
} {
  if (
    readAscii(bytes, 0, 4) !== 'FORM' ||
    readAscii(bytes, 8, 4) !== 'AIFF' ||
    readAscii(bytes, 12, 4) !== 'COMM' ||
    readAscii(bytes, 38, 4) !== 'SSND'
  ) {
    throw new Error('Output is not a canonical AIFF file.');
  }
  const view = dataView(bytes);
  const formBytes = view.getUint32(4, false);
  const soundBytes = view.getUint32(42, false);
  if (formBytes + 8 !== bytes.byteLength) {
    throw new Error('Output AIFF FORM size is not finalized to the file size.');
  }
  if (view.getUint32(16, false) !== 18) {
    throw new Error('Output AIFF COMM chunk is not canonical.');
  }
  if (54 + soundBytes - 8 + ((soundBytes - 8) % 2) !== bytes.byteLength) {
    throw new Error('Output AIFF SSND size does not match the file size.');
  }
  return {
    bitDepth: view.getUint16(26, false),
    channels: view.getUint16(20, false),
    formBytes,
    frames: view.getUint32(22, false),
    sampleRate: readExtended80(view, 28),
    soundBytes,
  };
}

function readExtended80(view: DataView, offset: number): number {
  const signAndExponent = view.getUint16(offset, false);
  const exponent = signAndExponent & 0x7fff;
  if (exponent === 0) {
    return 0;
  }
  const sign = (signAndExponent & 0x8000) === 0 ? 1 : -1;
  const high = view.getUint32(offset + 2, false);
  const low = view.getUint32(offset + 6, false);
  const mantissa = high * 2 ** 32 + low;
  return sign * (mantissa / 2 ** 63) * 2 ** (exponent - 16_383);
}

function inspectWav(bytes: Uint8Array): {
  readonly bitDepth: number;
  readonly blockAlign: number;
  readonly byteRate: number;
  readonly channels: number;
  readonly dataBytes: number;
  readonly dataChunks: number;
  readonly dataEndsAtFileEnd: boolean;
  readonly fmtBytes: number;
  readonly fmtChunks: number;
  readonly formatTag: number;
  readonly frames: number;
  readonly riffBytes: number;
  readonly sampleRate: number;
} {
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('Output is not a RIFF/WAVE file.');
  }

  const view = dataView(bytes);
  const riffBytes = view.getUint32(4, true);
  if (riffBytes + 8 !== bytes.byteLength) {
    throw new Error('Output WAV RIFF size is not finalized to the file size.');
  }
  let format:
    | {
        readonly bitDepth: number;
        readonly blockAlign: number;
        readonly byteRate: number;
        readonly channels: number;
        readonly fmtBytes: number;
        readonly formatTag: number;
        readonly sampleRate: number;
      }
    | undefined;
  let dataBytes: number | undefined;
  let dataEndsAtFileEnd = false;
  let dataChunks = 0;
  let fmtChunks = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkBytes = view.getUint32(offset + 4, true);
    if (offset + 8 + chunkBytes > bytes.byteLength) {
      throw new Error(`WAV ${chunkId} chunk exceeds the file.`);
    }
    if (chunkId === 'fmt ') {
      fmtChunks += 1;
      if (chunkBytes !== 16 || fmtChunks !== 1) {
        throw new Error('Output WAV must contain one canonical 16-byte fmt chunk.');
      }
      format = {
        bitDepth: view.getUint16(offset + 22, true),
        blockAlign: view.getUint16(offset + 20, true),
        byteRate: view.getUint32(offset + 16, true),
        channels: view.getUint16(offset + 10, true),
        fmtBytes: chunkBytes,
        formatTag: view.getUint16(offset + 8, true),
        sampleRate: view.getUint32(offset + 12, true),
      };
    } else if (chunkId === 'data') {
      dataChunks += 1;
      if (dataChunks !== 1) {
        throw new Error('Output WAV contains multiple data chunks.');
      }
      dataBytes = chunkBytes;
      dataEndsAtFileEnd = offset + 8 + chunkBytes === bytes.byteLength;
    }
    offset += 8 + chunkBytes + (chunkBytes % 2);
  }
  if (format === undefined || dataBytes === undefined || dataBytes === 0) {
    throw new Error('Output WAV is missing a valid fmt or data chunk.');
  }
  if (format.blockAlign === 0 || dataBytes % format.blockAlign !== 0) {
    throw new Error('Output WAV data is not an exact number of sample frames.');
  }
  return {
    ...format,
    dataBytes,
    dataChunks,
    dataEndsAtFileEnd,
    fmtChunks,
    frames: dataBytes / format.blockAlign,
    riffBytes,
  };
}

function inspectMp3(bytes: Uint8Array): {
  readonly bitrate: number;
  readonly channels: number;
  readonly frames: number;
  readonly frameBitrates: readonly number[];
  readonly sampleRate: number;
  readonly seekHeader: 'Info' | 'Xing' | null;
  readonly seekHeaderFrames: number | null;
} {
  const start = skipId3v2(bytes);
  const first = findMp3Frame(bytes, start);
  if (first === null) {
    throw new Error('Output MP3 has no valid MPEG Layer III frame.');
  }

  const sideInfoBytes = first.version === 1
    ? first.channels === 1
      ? 17
      : 32
    : first.channels === 1
      ? 9
      : 17;
  const standardMarkerOffset =
    first.offset + 4 + (first.hasCrc ? 2 : 0) + sideInfoBytes;
  const markerOffset = findMp3SeekHeaderOffset(
    bytes,
    standardMarkerOffset,
    first.offset + first.frameBytes,
  );
  const marker = markerOffset === null ? '' : readAscii(bytes, markerOffset, 4);
  const seekHeader = marker === 'Info' || marker === 'Xing' ? marker : null;
  let seekHeaderFrames: number | null = null;
  if (
    seekHeader !== null &&
    markerOffset !== null &&
    markerOffset + 12 <= bytes.byteLength
  ) {
    const view = dataView(bytes);
    const flags = view.getUint32(markerOffset + 4, false);
    if ((flags & 1) !== 0) {
      seekHeaderFrames = view.getUint32(markerOffset + 8, false);
    }
  }

  let frames = 0;
  let offset = first.offset;
  let audioBitrate = seekHeader === null ? first.bitrate : null;
  const frameBitrates: number[] = [];
  while (offset + 4 <= bytes.byteLength) {
    const frame = parseMp3Frame(bytes, offset);
    if (
      frame === null ||
      frame.sampleRate !== first.sampleRate ||
      frame.channels !== first.channels ||
      offset + frame.frameBytes > bytes.byteLength
    ) {
      break;
    }
    frames += 1;
    frameBitrates.push(frame.bitrate);
    if (audioBitrate === null && frames > 1) {
      audioBitrate = frame.bitrate;
    }
    offset += frame.frameBytes;
  }
  if (frames === 0 || audioBitrate === null) {
    throw new Error('Output MP3 has no complete audio frame.');
  }

  return {
    bitrate: audioBitrate,
    channels: first.channels,
    frameBitrates,
    frames,
    sampleRate: first.sampleRate,
    seekHeader,
    seekHeaderFrames,
  };
}

function findMp3SeekHeaderOffset(
  bytes: Uint8Array,
  standardOffset: number,
  frameEnd: number,
): number | null {
  for (
    let offset = Math.max(0, standardOffset - 32);
    offset + 4 <= Math.min(frameEnd, bytes.byteLength);
    offset += 1
  ) {
    const marker = readAscii(bytes, offset, 4);
    if (marker === 'Info' || marker === 'Xing') {
      return offset;
    }
  }
  return null;
}

interface Mp3Frame {
  readonly bitrate: number;
  readonly channels: number;
  readonly frameBytes: number;
  readonly hasCrc: boolean;
  readonly offset: number;
  readonly sampleRate: number;
  readonly version: 1 | 2 | 2.5;
}

function findMp3Frame(bytes: Uint8Array, start: number): Mp3Frame | null {
  for (let offset = start; offset + 4 <= bytes.byteLength; offset += 1) {
    const frame = parseMp3Frame(bytes, offset);
    if (frame !== null && offset + frame.frameBytes <= bytes.byteLength) {
      return frame;
    }
  }
  return null;
}

function parseMp3Frame(bytes: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > bytes.byteLength) {
    return null;
  }
  const header = dataView(bytes).getUint32(offset, false);
  if ((header >>> 21) !== 0x7ff) {
    return null;
  }
  const versionBits = (header >>> 19) & 3;
  const layerBits = (header >>> 17) & 3;
  const bitrateIndex = (header >>> 12) & 0xf;
  const rateIndex = (header >>> 10) & 3;
  if (
    versionBits === 1 ||
    layerBits !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 0xf ||
    rateIndex === 3
  ) {
    return null;
  }
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const bitrateKbps = (version === 1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  )[bitrateIndex];
  if (bitrateKbps === undefined) {
    return null;
  }
  const baseRate = [44_100, 48_000, 32_000][rateIndex];
  if (baseRate === undefined) {
    return null;
  }
  const sampleRate = baseRate / (version === 1 ? 1 : version === 2 ? 2 : 4);
  const bitrate = bitrateKbps * 1_000;
  const padding = (header >>> 9) & 1;
  const frameBytes =
    Math.floor(((version === 1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  return {
    bitrate,
    channels: ((header >>> 6) & 3) === 3 ? 1 : 2,
    frameBytes,
    hasCrc: ((header >>> 16) & 1) === 0,
    offset,
    sampleRate,
    version,
  };
}

function skipId3v2(bytes: Uint8Array): number {
  if (readAscii(bytes, 0, 3) !== 'ID3' || bytes.byteLength < 10) {
    return 0;
  }
  const size =
    ((bytes[6]! & 0x7f) << 21) |
    ((bytes[7]! & 0x7f) << 14) |
    ((bytes[8]! & 0x7f) << 7) |
    (bytes[9]! & 0x7f);
  const footerBytes = (bytes[5]! & 0x10) === 0 ? 0 : 10;
  return 10 + size + footerBytes;
}

function inspectFlac(bytes: Uint8Array): {
  readonly bitDepth: number;
  readonly channels: number;
  readonly hasAudioFrame: boolean;
  readonly sampleRate: number;
  readonly totalSamples: number;
} {
  if (readAscii(bytes, 0, 4) !== 'fLaC') {
    throw new Error('Output is not a FLAC file.');
  }

  let offset = 4;
  let streamInfo:
    | {
        readonly bitDepth: number;
        readonly channels: number;
        readonly sampleRate: number;
        readonly totalSamples: number;
      }
    | undefined;
  let last = false;
  while (!last) {
    if (offset + 4 > bytes.byteLength) {
      throw new Error('FLAC metadata header is truncated.');
    }
    const header = bytes[offset]!;
    last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length =
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!;
    const dataOffset = offset + 4;
    if (dataOffset + length > bytes.byteLength) {
      throw new Error('FLAC metadata block exceeds the file.');
    }
    if (type === 0) {
      if (length !== 34 || streamInfo !== undefined) {
        throw new Error('FLAC STREAMINFO metadata is invalid.');
      }
      let packed = 0n;
      for (let index = 0; index < 8; index += 1) {
        packed = (packed << 8n) | BigInt(bytes[dataOffset + 10 + index]!);
      }
      streamInfo = {
        bitDepth: Number((packed >> 36n) & 0x1fn) + 1,
        channels: Number((packed >> 41n) & 0x7n) + 1,
        sampleRate: Number((packed >> 44n) & 0xfffffn),
        totalSamples: Number(packed & 0xf_ffff_ffffn),
      };
    }
    offset = dataOffset + length;
  }
  if (streamInfo === undefined || streamInfo.totalSamples === 0) {
    throw new Error('FLAC STREAMINFO was not finalized with a sample count.');
  }
  const hasAudioFrame =
    offset + 2 <= bytes.byteLength &&
    bytes[offset] === 0xff &&
    (bytes[offset + 1]! & 0xfc) === 0xf8;
  return { ...streamInfo, hasAudioFrame };
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) {
    return '';
  }
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function captureWorkerDiagnostic(
  engine: AudioTranscoderStreamWorkerEngine,
  name: 'arbitrary' | 'known' | 'unknown',
): Promise<Error> {
  try {
    await engine.inspect({
      blob: new Blob(['diagnostic']),
      name,
    });
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`Worker rejected with a non-Error value: ${String(error)}`);
  }
  throw new Error(`Worker diagnostic "${name}" unexpectedly succeeded.`);
}

function errorCode(error: unknown): string {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN_ERROR';
}

function errorReason(error: unknown): string | null {
  return typeof error === 'object' &&
    error !== null &&
    'reason' in error &&
    typeof error.reason === 'string'
    ? error.reason
    : null;
}

async function countNamespaceEntries(namespace: string): Promise<number> {
  const root = await navigator.storage.getDirectory();
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await root.getDirectoryHandle(namespace);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return 0;
    }
    throw error;
  }
  const iterable = directory as FileSystemDirectoryHandle & {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  };
  let count = 0;
  for await (const _entry of iterable.entries()) {
    count += 1;
  }
  return count;
}

class SeekableMemorySink {
  private data = new Uint8Array();
  private readonly resolveClosed: () => void;
  private readonly closedPromise: Promise<void>;
  closed = false;
  maxChunkBytes = 0;
  readonly stream: AudioStreamOutput;
  writes = 0;

  constructor() {
    let resolveClosed = (): void => undefined;
    this.closedPromise = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.resolveClosed = resolveClosed;
    this.stream = new WritableStream<AudioStreamOutputChunk>({
      close: () => {
        this.closed = true;
        this.resolveClosed();
      },
      write: ({ data, position, type }) => {
        if (
          type !== 'write' ||
          !Number.isSafeInteger(position) ||
          position < 0
        ) {
          throw new Error('Encoder emitted an invalid seekable write.');
        }
        this.maxChunkBytes = Math.max(this.maxChunkBytes, data.byteLength);
        this.writes += 1;
        const end = position + data.byteLength;
        if (end > this.data.byteLength) {
          const expanded = new Uint8Array(end);
          expanded.set(this.data);
          this.data = expanded;
        }
        this.data.set(data, position);
      },
    });
  }

  bytes(): Uint8Array<ArrayBuffer> {
    return this.data;
  }

  async waitForClose(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closedPromise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Output stream did not close.')),
            5_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
}

class SlowSeekableDiscardSink {
  closed = false;
  maxChunkBytes = 0;
  readonly stream: AudioStreamOutput;
  writes = 0;

  constructor() {
    const sink = this;
    this.stream = new WritableStream<AudioStreamOutputChunk>({
      close() {
        sink.closed = true;
      },
      async write({ data }) {
        sink.maxChunkBytes = Math.max(sink.maxChunkBytes, data.byteLength);
        sink.writes += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });
  }
}
