import { describe, expect, it } from 'vitest';
import type { AudioTranscoderPlugin } from '../codecs/contracts.js';
import type { AudioProgress } from './contracts.js';
import { createAudioTranscoderEngine } from './factory.js';
import {
  createProgressPhase,
  emitFinalProgress,
  throwIfOperationAborted,
} from './progress.js';

describe('audio operation progress', () => {
  it('reports immutable 0..1 progress quantized to three decimal places', () => {
    const events: AudioProgress[] = [];
    const phase = createProgressPhase({
      operation: 'decode',
      operationOptions: { onProgress: (progress) => events.push(progress) },
      phase: 'decode',
      phaseCount: 1,
      phaseIndex: 0,
    });

    phase.start();
    phase.context.reportProgress(1, 3);
    phase.context.reportProgress(2, 3);
    phase.complete();

    expect(events).toEqual([
      {
        completedFrames: null,
        operation: 'decode',
        phase: 'decode',
        progress: 0,
        totalFrames: null,
      },
      {
        completedFrames: 1,
        operation: 'decode',
        phase: 'decode',
        progress: 0.333,
        totalFrames: 3,
      },
      {
        completedFrames: 2,
        operation: 'decode',
        phase: 'decode',
        progress: 0.667,
        totalFrames: 3,
      },
      {
        completedFrames: 3,
        operation: 'decode',
        phase: 'decode',
        progress: 1,
        totalFrames: 3,
      },
    ]);
    expect(events.every(Object.isFrozen)).toBe(true);
  });

  it('maps decode and encode phases across a transcode operation', async () => {
    const plugin = progressPlugin();
    const engine = createAudioTranscoderEngine({ plugins: [plugin] });
    const events: AudioProgress[] = [];

    await engine.transcode(
      { data: new ArrayBuffer(1) },
      'progress-output',
      { onProgress: (progress) => events.push(progress) },
    );

    expect(events.map(({ phase, progress }) => [phase, progress])).toEqual([
      ['decode', 0],
      ['decode', 0.125],
      ['decode', 0.5],
      ['encode', 0.5],
      ['encode', 0.875],
      ['encode', 1],
      ['finalize', 1],
    ]);
  });

  it('does not emit duplicate completion after a codec reaches its total', () => {
    const events: AudioProgress[] = [];
    const phase = createProgressPhase({
      operation: 'encode',
      operationOptions: { onProgress: (progress) => events.push(progress) },
      phase: 'encode',
      phaseCount: 1,
      phaseIndex: 0,
    });

    phase.context.reportProgress(2, 2);
    phase.complete();

    expect(events).toHaveLength(1);
    expect(events[0]?.progress).toBe(1);
  });

  it.each([
    [0.5, 1],
    [0, 1.5],
    [0, 0],
    [-1, 1],
    [2, 1],
  ])('rejects invalid frame progress %s/%s', (completedFrames, totalFrames) => {
    const phase = createProgressPhase({
      operation: 'decode',
      operationOptions: {},
      phase: 'decode',
      phaseCount: 1,
      phaseIndex: 0,
    });

    expect(() =>
      phase.context.reportProgress(completedFrames, totalFrames),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PROGRESS' }));
  });

  it('rejects regressing codec progress', () => {
    const phase = createProgressPhase({
      operation: 'decode',
      operationOptions: {},
      phase: 'decode',
      phaseCount: 1,
      phaseIndex: 0,
    });
    phase.context.reportProgress(2, 3);

    expect(() => phase.context.reportProgress(1, 3)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PROGRESS' }),
    );
  });

  it('checks cancellation before and after cooperative checkpoints', async () => {
    const controller = new AbortController();
    const phase = createProgressPhase({
      operation: 'decode',
      operationOptions: {
        onProgress(progress) {
          if (progress.completedFrames === 1) {
            controller.abort('checkpoint stopped');
          }
        },
        signal: controller.signal,
      },
      phase: 'decode',
      phaseCount: 1,
      phaseIndex: 0,
    });

    await expect(phase.context.checkpoint(1, 2)).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'checkpoint stopped',
    });

    const activePhase = createProgressPhase({
      operation: 'decode',
      operationOptions: {},
      phase: 'decode',
      phaseCount: 1,
      phaseIndex: 0,
    });
    await expect(activePhase.context.checkpoint(1, 2)).resolves.toBeUndefined();
  });

  it.each([
    [new Error('error reason'), 'error reason'],
    ['string reason', 'string reason'],
    [123, 'Audio operation was aborted.'],
  ])('normalizes cancellation reason %#', (reason, message) => {
    const signal = { aborted: true, reason } as AbortSignal;

    expect(() => throwIfOperationAborted(signal)).toThrowError(
      expect.objectContaining({ code: 'OPERATION_ABORTED', message }),
    );
  });

  it('allows active operations and rejects already aborted starts and finalization', () => {
    expect(() => throwIfOperationAborted()).not.toThrow();

    const controller = new AbortController();
    controller.abort('already stopped');
    const phase = createProgressPhase({
      operation: 'decode',
      operationOptions: { signal: controller.signal },
      phase: 'decode',
      phaseCount: 1,
      phaseIndex: 0,
    });

    expect(() => phase.start()).toThrowError(
      expect.objectContaining({ code: 'OPERATION_ABORTED' }),
    );
    expect(() => phase.complete()).toThrowError(
      expect.objectContaining({ code: 'OPERATION_ABORTED' }),
    );
    expect(() => emitFinalProgress('transcode', { signal: controller.signal })).toThrowError(
      expect.objectContaining({ code: 'OPERATION_ABORTED' }),
    );
  });

  it('emits immutable final progress and supports an omitted listener', () => {
    let event: AudioProgress | undefined;

    emitFinalProgress('transcode', {
      onProgress(progress) {
        event = progress;
      },
    });
    emitFinalProgress('transcode', {});

    expect(event).toEqual({
      completedFrames: null,
      operation: 'transcode',
      phase: 'finalize',
      progress: 1,
      totalFrames: null,
    });
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('cancels a built-in encoder at a cooperative frame boundary', async () => {
    const controller = new AbortController();
    const engine = createAudioTranscoderEngine();
    const audio = {
      channelData: [new Float32Array(300_000)],
      sampleRate: 48_000,
    };

    const result = engine.encode(audio, 'wav-pcm16', {
      onProgress(progress) {
        if (progress.completedFrames === 262_144) {
          controller.abort('user cancelled');
        }
      },
      signal: controller.signal,
    });

    await expect(result).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'user cancelled',
    });
  });
});

function progressPlugin(): AudioTranscoderPlugin {
  const preset = {
    bitDepth: 16,
    container: 'test',
    extension: 'test',
    id: 'progress-output',
    mimeType: 'audio/test',
    sampleFormat: 'integer' as const,
  };

  return {
    decoders: [
      {
        formats: ['test'],
        id: 'progress-decoder',
        decode(_input, context) {
          context?.reportProgress(1, 4);
          return {
            channelData: [new Float32Array([0])],
            durationSeconds: 1,
            sampleRate: 1,
            source: 'progress test',
          };
        },
      },
    ],
    encoders: [
      {
        id: 'progress-encoder',
        presets: [preset],
        encode(_audio, selectedPreset, context) {
          context?.reportProgress(3, 4);
          return { data: new ArrayBuffer(1), preset: selectedPreset };
        },
      },
    ],
    id: 'progress-plugin',
  };
}
