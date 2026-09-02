import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioStreamOutputChunk } from './contracts.js';
import {
  AUDIO_TRANSCODER_OUTPUT_MEMORY_LIMIT_BYTES,
  createAudioTranscoderOutputSession,
} from './output-session.js';
import type { OutputDestination } from './output-session/internal.js';
import { SessionMemoryBudget } from './output-session/memory-destination.js';
import { createOpfsDestination } from './output-session/opfs-destination.js';
import { ManagedPendingOutput } from './output-session/resource.js';

const NOW = 1_800_000_000_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(UUID);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('output session configuration', () => {
  it('validates namespace, memory limit, and lifecycle options', () => {
    for (const namespace of ['', '.', '..', '-bad', 'bad-', 'bad/name', 'a'.repeat(65)]) {
      expect(() => createAudioTranscoderOutputSession({ namespace })).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    }
    for (const memoryLimitBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        createAudioTranscoderOutputSession({ memoryLimitBytes }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    }
    expect(() =>
      createAudioTranscoderOutputSession({
        disposeOnPageHide: 'yes' as unknown as boolean,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));

    expect(
      createAudioTranscoderOutputSession({
        memoryLimitBytes: Number.MAX_SAFE_INTEGER,
        namespace: 'a',
      }),
    ).toBeDefined();
  });

  it('uses safe defaults without allocating storage eagerly', async () => {
    vi.stubGlobal('navigator', {});
    const session = createAudioTranscoderOutputSession();

    expect(AUDIO_TRANSCODER_OUTPUT_MEMORY_LIMIT_BYTES).toBe(128 * 1024 * 1024);
    expect(await session.getStorageMode()).toBe('memory');
    expect(session.getMemoryReservation()).toEqual({
      limitBytes: AUDIO_TRANSCODER_OUTPUT_MEMORY_LIMIT_BYTES,
      reservedBytes: 0,
    });
    await session.dispose();
  });

  it('validates per-output memory artifact capacities', async () => {
    vi.stubGlobal('navigator', {});
    const session = createAudioTranscoderOutputSession({
      memoryLimitBytes: 16,
    });

    for (const maxMemoryArtifactBytes of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expect(
        session.create({ maxMemoryArtifactBytes }),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    }
    await expect(
      session.create(null as never),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });

    const zero = await session.create({ maxMemoryArtifactBytes: 0 });
    expect(zero.maxOutputBytes).toBe(0);
    await zero.discard();
    await session.dispose();
  });
});

describe('paged memory fallback', () => {
  it('rejects reservations beyond the aggregate memory budget', () => {
    const budget = new SessionMemoryBudget(4);
    budget.reserve(3);

    expect(() => budget.reserve(2)).toThrow(
      expect.objectContaining({
        code: 'RESOURCE_LIMIT_EXCEEDED',
        message:
          'Session memory budget exceeded: 3 bytes reserved, 2 requested, 4 limit.',
        reason: 'output-storage-limit',
      }),
    );
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['oversized', 3],
  ])('releases a lease after rejecting a %s committed size', (_label, size) => {
    const budget = new SessionMemoryBudget(4);
    const lease = budget.acquireArtifactLease(2, 2);

    expect(() => lease.commit(size)).toThrow(
      expect.objectContaining({
        code: 'RESOURCE_LIMIT_EXCEEDED',
        reason: 'output-storage-limit',
      }),
    );
    expect(budget.snapshot().reservedBytes).toBe(0);
    lease.release();
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('preserves committed bytes when a lease rejects a second commit', () => {
    const budget = new SessionMemoryBudget(4);
    const lease = budget.acquireArtifactLease(2, 2);

    lease.commit(1);
    expect(budget.snapshot().reservedBytes).toBe(1);
    expect(() => lease.commit(1)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
    expect(budget.snapshot().reservedBytes).toBe(1);
    lease.release();
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('supports seekable writes, sparse pages, artifact metadata, and cleanup', async () => {
    vi.stubGlobal('navigator', { storage: {} });
    const session = createAudioTranscoderOutputSession({
      memoryLimitBytes: 4 * 1024 * 1024,
      namespace: 'memory-test',
    });
    const pending = await session.create();
    expect(pending.maxOutputBytes).toBe(2 * 1024 * 1024);
    const writer = pending.stream.getWriter();
    await writer.write(chunk(1024 * 1024 + 1, [3]));
    await writer.write(chunk(1024 * 1024, [2]));
    await writer.close();
    writer.releaseLock();

    const artifact = await pending.complete({
      mimeType: 'audio/test',
      name: 'sparse.test',
    });
    const bytes = new Uint8Array(await artifact.blob.arrayBuffer());

    expect(pending.storage).toBe('memory');
    expect(artifact).toMatchObject({
      mimeType: 'audio/test',
      name: 'sparse.test',
      size: 1024 * 1024 + 2,
      storage: 'memory',
    });
    expect(artifact.blob.type).toBe('audio/test');
    expect(bytes[0]).toBe(0);
    expect(bytes.at(-2)).toBe(2);
    expect(bytes.at(-1)).toBe(3);
    await expect(
      pending.complete({ mimeType: 'audio/test', name: 'again.test' }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(artifact.dispose()).toBe(artifact.dispose());
    await artifact.dispose();
    expect(session.dispose()).toBe(session.dispose());
    await session.dispose();
    await expect(session.create()).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    expect(await session.getStorageMode()).toBe('memory');
  });

  it('rejects invalid metadata without settling the destination', async () => {
    vi.stubGlobal('navigator', {});
    const session = createAudioTranscoderOutputSession({ memoryLimitBytes: 8 });
    const pending = await session.create();

    expect(() =>
      pending.complete({ mimeType: 'audio/test', name: '' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    expect(() =>
      pending.complete({ mimeType: '', name: 'output.test' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    expect(() =>
      pending.complete({
        mimeType: 1 as unknown as string,
        name: 'output.test',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    expect(() =>
      pending.complete({
        mimeType: 'audio/test',
        name: 1 as unknown as string,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));

    const writer = pending.stream.getWriter();
    await writer.write(chunk(2, [1, 2]));
    await writer.write(chunk(3, [9]));
    await writer.close();
    writer.releaseLock();
    const artifact = await pending.complete({
      mimeType: 'audio/test',
      name: 'output.test',
    });
    expect([...new Uint8Array(await artifact.blob.arrayBuffer())]).toEqual([
      0, 0, 1, 9,
    ]);
    await session.dispose();
  });

  it('leases capacity atomically across concurrent pending and completed outputs', async () => {
    vi.stubGlobal('navigator', {});
    const session = createAudioTranscoderOutputSession({ memoryLimitBytes: 8 });
    const initialReservation = session.getMemoryReservation();
    expect(initialReservation).toEqual({ limitBytes: 8, reservedBytes: 0 });
    expect(Object.isFrozen(initialReservation)).toBe(true);

    const first = await session.create();
    const second = await session.create();
    expect(first.maxOutputBytes).toBe(4);
    expect(second.maxOutputBytes).toBe(0);
    expect(session.getMemoryReservation().reservedBytes).toBe(8);
    const firstWriter = first.stream.getWriter();
    const secondWriter = second.stream.getWriter();
    await firstWriter.write(chunk(0, [1, 2]));
    await expect(secondWriter.write(chunk(0, [3]))).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      reason: 'output-storage-limit',
    });
    expect(session.getMemoryReservation().reservedBytes).toBe(8);
    await firstWriter.close();
    firstWriter.releaseLock();
    secondWriter.releaseLock();
    await second.discard();

    const firstArtifact = await first.complete({
      mimeType: 'audio/test',
      name: 'first.test',
    });
    expect(session.getMemoryReservation().reservedBytes).toBe(2);

    const third = await session.create();
    expect(third.maxOutputBytes).toBe(3);
    expect(session.getMemoryReservation().reservedBytes).toBe(8);
    const thirdWriter = third.stream.getWriter();
    await thirdWriter.write(chunk(2, [4]));
    expect(session.getMemoryReservation().reservedBytes).toBe(8);

    await firstArtifact.dispose();
    expect(session.getMemoryReservation().reservedBytes).toBe(6);
    await thirdWriter.write(chunk(0, [9]));
    thirdWriter.releaseLock();
    await third.discard();
    expect(session.getMemoryReservation().reservedBytes).toBe(0);

    await session.dispose();
    expect(session.getMemoryReservation().reservedBytes).toBe(0);
  });

  it('recomputes default sequential capacity while an artifact remains retained', async () => {
    vi.stubGlobal('navigator', {});
    const session = createAudioTranscoderOutputSession({
      memoryLimitBytes: 16,
    });

    const first = await session.create();
    expect(first.maxOutputBytes).toBe(8);
    const firstWriter = first.stream.getWriter();
    await firstWriter.write(chunk(0, [1]));
    await firstWriter.close();
    firstWriter.releaseLock();
    const retainedArtifact = await first.complete({
      mimeType: 'audio/test',
      name: 'first.test',
    });
    expect(session.getMemoryReservation().reservedBytes).toBe(1);

    const second = await session.create();
    expect(second.maxOutputBytes).toBe(7);
    expect(session.getMemoryReservation().reservedBytes).toBe(15);
    await second.discard();
    expect(session.getMemoryReservation().reservedBytes).toBe(1);

    await retainedArtifact.dispose();
    expect(session.getMemoryReservation().reservedBytes).toBe(0);
    await session.dispose();
  });

  it('supports multiple explicit nonzero memory artifact leases', async () => {
    vi.stubGlobal('navigator', {});
    const session = createAudioTranscoderOutputSession({
      memoryLimitBytes: 12,
    });

    const first = await session.create({ maxMemoryArtifactBytes: 2 });
    const second = await session.create({ maxMemoryArtifactBytes: 2 });
    const third = await session.create({ maxMemoryArtifactBytes: 2 });

    expect([
      first.maxOutputBytes,
      second.maxOutputBytes,
      third.maxOutputBytes,
    ]).toEqual([2, 2, 2]);
    expect(session.getMemoryReservation().reservedBytes).toBe(12);
    await expect(
      session.create({ maxMemoryArtifactBytes: 1 }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      reason: 'output-storage-limit',
    });

    await Promise.all([first.discard(), second.discard(), third.discard()]);
    expect(session.getMemoryReservation().reservedBytes).toBe(0);
    await session.dispose();
  });

  it('rejects writes beyond leased Blob headroom and releases the reservation', async () => {
    vi.stubGlobal('navigator', {});
    const session = createAudioTranscoderOutputSession({ memoryLimitBytes: 8 });
    const pending = await session.create();
    expect(pending.maxOutputBytes).toBe(4);
    const writer = pending.stream.getWriter();
    await expect(writer.write(chunk(0, [1, 2, 3, 4, 5]))).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message:
        'Memory output exceeds its reserved artifact capacity (4 bytes; attempted end: 5 bytes).',
      reason: 'output-storage-limit',
    });
    writer.releaseLock();
    await pending.discard();
    expect(session.getMemoryReservation().reservedBytes).toBe(0);

    const replacement = await session.create();
    expect(replacement.maxOutputBytes).toBe(4);
    const replacementWriter = replacement.stream.getWriter();
    await replacementWriter.write(chunk(0, [1, 2, 3, 4]));
    replacementWriter.releaseLock();
    await replacement.discard();
    expect(session.getMemoryReservation().reservedBytes).toBe(0);
    await session.dispose();
  });

  it('accounts for page rounding when guaranteeing a memory artifact size', async () => {
    vi.stubGlobal('navigator', {});
    const session = createAudioTranscoderOutputSession({
      memoryLimitBytes: 1022,
    });

    const pending = await session.create();

    expect(pending.maxOutputBytes).toBe(510);
    expect(session.getMemoryReservation()).toEqual({
      limitBytes: 1022,
      reservedBytes: 1020,
    });
    const writer = pending.stream.getWriter();
    await writer.write(chunk(509, [1]));
    await expect(writer.write(chunk(510, [2]))).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      reason: 'output-storage-limit',
    });
    writer.releaseLock();
    await pending.discard();
    expect(session.getMemoryReservation().reservedBytes).toBe(0);
    await session.dispose();
  });

  it('rolls back copy headroom when Blob materialization fails', async () => {
    vi.stubGlobal('navigator', {});
    const session = createAudioTranscoderOutputSession({ memoryLimitBytes: 4 });
    const pending = await session.create();
    expect(pending.maxOutputBytes).toBe(2);
    const writer = pending.stream.getWriter();
    await writer.write(chunk(0, [1, 2]));
    await writer.close();
    writer.releaseLock();
    vi.stubGlobal(
      'Response',
      class {
        constructor() {
          throw new Error('Blob materialization failed');
        }
      } as unknown as typeof Response,
    );

    await expect(
      pending.complete({ mimeType: 'audio/test', name: 'failed.test' }),
    ).rejects.toThrow('Blob materialization failed');
    expect(session.getMemoryReservation().reservedBytes).toBe(0);
    await session.dispose();
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['oversized', 3],
  ])(
    'rejects a %s materialized Blob size without corrupting reservations',
    async (_label, artifactBytes) => {
      vi.stubGlobal('navigator', {});
      vi.stubGlobal(
        'Response',
        class {
          async blob(): Promise<Blob> {
            return {
              size: 1,
              slice: () => ({ size: artifactBytes }),
            } as unknown as Blob;
          }
        } as unknown as typeof Response,
      );
      const session = createAudioTranscoderOutputSession({
        memoryLimitBytes: 4,
      });
      const pending = await session.create({
        maxMemoryArtifactBytes: 2,
      });
      const writer = pending.stream.getWriter();
      await writer.write(chunk(0, [1]));
      await writer.close();
      writer.releaseLock();

      await expect(
        pending.complete({
          mimeType: 'audio/test',
          name: 'invalid-size.test',
        }),
      ).rejects.toMatchObject({
        code: 'RESOURCE_LIMIT_EXCEEDED',
        reason: 'output-storage-limit',
      });
      expect(session.getMemoryReservation().reservedBytes).toBe(0);

      const replacement = await session.create({
        maxMemoryArtifactBytes: 2,
      });
      expect(session.getMemoryReservation().reservedBytes).toBe(4);
      await replacement.discard();
      expect(session.getMemoryReservation().reservedBytes).toBe(0);
      await session.dispose();
    },
  );

  it('treats zero-byte positional writes as accounting no-ops', async () => {
    vi.stubGlobal('navigator', {});
    const session = createAudioTranscoderOutputSession({ memoryLimitBytes: 1 });
    const pending = await session.create();
    expect(pending.maxOutputBytes).toBe(0);
    const writer = pending.stream.getWriter();
    await writer.write(chunk(Number.MAX_SAFE_INTEGER, []));
    expect(session.getMemoryReservation().reservedBytes).toBe(0);
    await writer.close();
    writer.releaseLock();

    const artifact = await pending.complete({
      mimeType: 'audio/test',
      name: 'empty.test',
    });
    expect(artifact.size).toBe(0);
    expect(session.getMemoryReservation().reservedBytes).toBe(0);
    await artifact.dispose();
    await session.dispose();
  });

  it('enforces stream state, positions, and the configured hard limit', async () => {
    vi.stubGlobal('navigator', {});
    const session = createAudioTranscoderOutputSession({ memoryLimitBytes: 4 });

    const open = await session.create();
    await expect(
      open.complete({ mimeType: 'audio/test', name: 'open.test' }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    await open.discard();
    expect(open.discard()).toBe(open.discard());
    const openWriter = open.stream.getWriter();
    await expect(openWriter.write(chunk(0, [1]))).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    openWriter.releaseLock();

    for (const position of [-1, Number.NaN]) {
      const pending = await session.create();
      const writer = pending.stream.getWriter();
      await expect(writer.write(chunk(position, [1]))).rejects.toMatchObject({
        code: 'INVALID_CONFIGURATION',
      });
      writer.releaseLock();
      await pending.discard();
    }

    for (const position of [4, Number.MAX_SAFE_INTEGER]) {
      const pending = await session.create();
      const writer = pending.stream.getWriter();
      await expect(writer.write(chunk(position, [1]))).rejects.toMatchObject({
        code: 'RESOURCE_LIMIT_EXCEEDED',
      });
      writer.releaseLock();
      await pending.discard();
    }

    const aborted = await session.create();
    const abortedWriter = aborted.stream.getWriter();
    await abortedWriter.abort('cancel');
    abortedWriter.releaseLock();
    await expect(
      aborted.complete({ mimeType: 'audio/test', name: 'cancel.test' }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    await aborted.discard();
    await session.dispose();
  });
});

describe('managed resource cleanup', () => {
  it('shares pending cleanup attempts, retries failures, and caches success', async () => {
    const firstGate = deferred<void>();
    const retryGate = deferred<void>();
    const failure = new Error('pending cleanup failed');
    let attemptIndex = 0;
    const discard = vi.fn(async () => {
      const index = attemptIndex;
      attemptIndex += 1;
      await [firstGate.promise, retryGate.promise][index];
      if (index === 0) {
        throw failure;
      }
    });
    const release = vi.fn();
    const pending = new ManagedPendingOutput(
      testDestination(new Blob(), discard),
      release,
    );

    const first = pending.discard();
    expect(pending.discard()).toBe(first);
    firstGate.resolve();
    await expect(first).rejects.toBe(failure);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    const retry = pending.discard();
    expect(retry).not.toBe(first);
    expect(pending.discard()).toBe(retry);
    retryGate.resolve();
    await retry;
    expect(discard).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(pending.discard()).toBe(retry);
  });

  it('retries artifact cleanup without materializing its OPFS-backed Blob', async () => {
    const firstGate = deferred<void>();
    const retryGate = deferred<void>();
    const failure = new Error('artifact cleanup failed');
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const arrayBuffer = vi.spyOn(blob, 'arrayBuffer');
    const stream = vi.spyOn(blob, 'stream');
    let attemptIndex = 0;
    const discard = vi.fn(async () => {
      const index = attemptIndex;
      attemptIndex += 1;
      await [firstGate.promise, retryGate.promise][index];
      if (index === 0) {
        throw failure;
      }
    });
    const release = vi.fn();
    const pending = new ManagedPendingOutput(
      testDestination(blob, discard),
      release,
    );
    const artifact = await pending.complete({
      mimeType: 'audio/test',
      name: 'output.test',
    });

    expect(artifact.blob).toBe(blob);
    const first = artifact.dispose();
    expect(artifact.dispose()).toBe(first);
    firstGate.resolve();
    await expect(first).rejects.toBe(failure);
    expect(release).not.toHaveBeenCalled();

    const retry = artifact.dispose();
    expect(retry).not.toBe(first);
    expect(artifact.dispose()).toBe(retry);
    retryGate.resolve();
    await retry;
    expect(discard).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(artifact.dispose()).toBe(retry);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });
});

describe('page lifecycle', () => {
  it('preserves bfcache sessions and disposes only on terminal pagehide', async () => {
    const lifecycle = new EventTarget();
    vi.stubGlobal('window', lifecycle);
    vi.stubGlobal('navigator', {});
    const session = createAudioTranscoderOutputSession({
      disposeOnPageHide: true,
    });

    lifecycle.dispatchEvent(pageHideEvent(true));
    const pending = await session.create();
    await pending.discard();

    lifecycle.dispatchEvent(pageHideEvent(false));
    await vi.waitFor(async () => {
      await expect(session.create()).rejects.toMatchObject({
        code: 'INVALID_CONFIGURATION',
      });
    });
    await session.dispose();
  });

  it('does not attach a listener unless requested', async () => {
    const lifecycle = new EventTarget();
    const add = vi.spyOn(lifecycle, 'addEventListener');
    vi.stubGlobal('window', lifecycle);
    vi.stubGlobal('navigator', {});
    const session = createAudioTranscoderOutputSession();

    expect(add).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('swallows cleanup rejection from an unawaitable terminal pagehide', async () => {
    const lifecycle = new EventTarget();
    vi.stubGlobal('window', lifecycle);
    const { parent } = installOpfs('pagehide-fail');
    const session = createAudioTranscoderOutputSession({
      disposeOnPageHide: true,
      namespace: 'pagehide-fail',
    });
    await session.getStorageMode();
    parent.removeErrors.set(
      timestampedName(NOW, UUID),
      new Error('pagehide cleanup failed'),
    );

    lifecycle.dispatchEvent(pageHideEvent(false));
    await expect(session.dispose()).rejects.toThrow('pagehide cleanup failed');
  });
});

describe('OPFS storage and ownership', () => {
  it('writes through OPFS, refreshes its lease, and removes artifacts eagerly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { parent, locks } = installOpfs('opfs-test', (directory) => {
      directory.outputMimeType = 'audio/wav';
    });
    const session = createAudioTranscoderOutputSession({ namespace: 'opfs-test' });

    expect(await session.getStorageMode()).toBe('opfs');
    const ownName = timestampedName(NOW, UUID);
    const ownDirectory = parent.directory(ownName);
    expect(locks.heldNames()).toContain(lockName('opfs-test', ownName));
    const firstLease = await ownDirectory.file('.lease.json').text();

    await vi.advanceTimersByTimeAsync(60_000);
    const refreshedLease = await ownDirectory.file('.lease.json').text();
    expect(refreshedLease).not.toBe(firstLease);
    expect(JSON.parse(refreshedLease)).toMatchObject({
      heartbeatAt: NOW + 60_000,
      namespace: 'opfs-test',
      session: ownName,
      version: 1,
    });

    const pending = await session.create({ maxMemoryArtifactBytes: 1 });
    expect(pending.maxOutputBytes).toBeUndefined();
    expect(session.getMemoryReservation().reservedBytes).toBe(0);
    const writer = pending.stream.getWriter();
    await writer.write(chunk(0, [1, 2]));
    await writer.write(chunk(1, [9]));
    await writer.close();
    writer.releaseLock();
    const artifact = await pending.complete({
      mimeType: 'audio/wav',
      name: 'result.wav',
    });

    expect(artifact.storage).toBe('opfs');
    expect(artifact.blob.type).toBe('audio/wav');
    expect([...new Uint8Array(await artifact.blob.arrayBuffer())]).toEqual([1, 9]);
    expect(ownDirectory.outputNames()).toHaveLength(1);
    await artifact.dispose();
    expect(ownDirectory.outputNames()).toHaveLength(0);
    await session.dispose();
    expect(parent.has(ownName)).toBe(false);
    expect(locks.heldNames()).not.toContain(lockName('opfs-test', ownName));
  });

  it('requires a closed OPFS stream and supports pending discard', async () => {
    const { parent } = installOpfs('opfs-state');
    const session = createAudioTranscoderOutputSession({ namespace: 'opfs-state' });
    const pending = await session.create();

    await expect(
      pending.complete({ mimeType: 'audio/wav', name: 'open.wav' }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    await pending.discard();
    expect(parent.directory(timestampedName(NOW, UUID)).outputNames()).toEqual([]);

    const aborted = await session.create();
    const writer = aborted.stream.getWriter();
    await writer.abort('cancel OPFS output');
    writer.releaseLock();
    await aborted.discard();
    await session.dispose();
  });

  it('settles the native abort before removing the output file', async () => {
    const abortGate = deferred<void>();
    const directory = new FakeDirectory('abort-order');
    directory.outputAbortGate = abortGate.promise;
    const destination = await createOpfsDestination(directory.handle);

    const discard = destination.discard();
    await vi.waitFor(() => {
      expect(directory.outputEvents).toEqual(['abort:start']);
    });
    expect(directory.outputRemovalAttempts).toBe(0);

    abortGate.resolve();
    await discard;
    expect(directory.outputEvents).toEqual([
      'abort:start',
      'abort:settled',
      'remove:start',
    ]);
    expect(directory.outputNames()).toEqual([]);
  });

  it('retries failed removal without aborting the native writer again', async () => {
    const directory = new FakeDirectory('remove-retry');
    directory.outputRemovalError = new Error('remove failed once');
    const destination = await createOpfsDestination(directory.handle);

    await expect(destination.discard()).rejects.toThrow('remove failed once');
    expect(directory.outputAbortAttempts).toBe(1);
    expect(directory.outputRemovalAttempts).toBe(1);

    directory.outputRemovalError = undefined;
    await destination.discard();
    expect(directory.outputAbortAttempts).toBe(1);
    expect(directory.outputRemovalAttempts).toBe(2);
    expect(directory.outputNames()).toEqual([]);
  });

  it('shares concurrent removal and caches only its successful result', async () => {
    const removalGate = deferred<void>();
    const directory = new FakeDirectory('remove-concurrency');
    directory.outputRemovalGate = removalGate.promise;
    const destination = await createOpfsDestination(directory.handle);

    const first = destination.discard();
    const second = destination.discard();
    await vi.waitFor(() => {
      expect(directory.outputRemovalAttempts).toBe(1);
    });

    removalGate.resolve();
    await Promise.all([first, second]);
    await destination.discard();
    expect(directory.outputAbortAttempts).toBe(1);
    expect(directory.outputRemovalAttempts).toBe(1);
    expect(directory.outputNames()).toEqual([]);
  });

  it('completes a closed output before discarding it without aborting', async () => {
    const directory = new FakeDirectory('close-discard');
    const destination = await createOpfsDestination(directory.handle);
    const writer = destination.stream.getWriter();
    await writer.write(chunk(0, [1, 2, 3]));
    await writer.close();
    writer.releaseLock();

    const completed = await destination.complete('audio/test');
    expect([...new Uint8Array(await completed.arrayBuffer())]).toEqual([1, 2, 3]);
    await destination.discard();
    await destination.discard();
    expect(directory.outputAbortAttempts).toBe(0);
    expect(directory.outputRemovalAttempts).toBe(1);
    expect(directory.outputNames()).toEqual([]);
  });

  it('normalizes OPFS quota failures during writes and still removes output', async () => {
    const directory = new FakeDirectory('write-quota');
    const destination = await createOpfsDestination(directory.handle);
    const outputName = directory.outputNames()[0];
    if (outputName === undefined) {
      throw new Error('Missing test output');
    }
    directory.file(outputName).failWrite = namedError('QuotaExceededError');
    const writer = destination.stream.getWriter();

    await expect(writer.write(chunk(0, [1]))).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message:
        'OPFS output storage quota was exceeded during destination write.',
      reason: 'output-storage-limit',
    });
    writer.releaseLock();
    await destination.discard();
    expect(directory.outputNames()).toEqual([]);
  });

  it('converges close-quota cleanup and releases session tracking', async () => {
    const { parent } = installOpfs('close-quota');
    const session = createAudioTranscoderOutputSession({
      namespace: 'close-quota',
    });
    const pending = await session.create();
    const directory = parent.directory(timestampedName(NOW, UUID));
    const outputName = directory.outputNames()[0];
    if (outputName === undefined) {
      throw new Error('Missing test output');
    }
    directory.file(outputName).failClose = namedError('QuotaExceededError');
    const writer = pending.stream.getWriter();

    await expect(writer.close()).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message:
        'OPFS output storage quota was exceeded during destination close.',
      reason: 'output-storage-limit',
    });
    writer.releaseLock();
    await pending.discard();
    expect(pending.discard()).toBe(pending.discard());
    expect(directory.outputNames()).toEqual([]);
    await session.dispose();
    expect(parent.names()).toEqual([]);
  });

  it('retries real removal failures after a close quota failure', async () => {
    const { parent } = installOpfs('quota-remove-retry', (directory) => {
      directory.outputRemovalError = new Error('remove still failed');
    });
    const session = createAudioTranscoderOutputSession({
      namespace: 'quota-remove-retry',
    });
    const pending = await session.create();
    const directory = parent.directory(timestampedName(NOW, UUID));
    const outputName = directory.outputNames()[0];
    if (outputName === undefined) {
      throw new Error('Missing test output');
    }
    directory.file(outputName).failClose = namedError('QuotaExceededError');
    const writer = pending.stream.getWriter();

    await expect(writer.close()).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      reason: 'output-storage-limit',
    });
    writer.releaseLock();
    await expect(pending.discard()).rejects.toThrow('remove still failed');
    expect(directory.outputRemovalAttempts).toBe(1);

    directory.outputRemovalError = undefined;
    await pending.discard();
    expect(directory.outputRemovalAttempts).toBe(2);
    await session.dispose();
    expect(parent.names()).toEqual([]);
  });

  it('preserves non-quota OPFS write and close failures while cleanup converges', async () => {
    const writeDirectory = new FakeDirectory('write-failure');
    const writeDestination = await createOpfsDestination(writeDirectory.handle);
    const writeName = writeDirectory.outputNames()[0];
    if (writeName === undefined) {
      throw new Error('Missing test output');
    }
    const writeFailure = new Error('write failed');
    writeDirectory.file(writeName).failWrite = writeFailure;
    const writeWriter = writeDestination.stream.getWriter();
    await expect(writeWriter.write(chunk(0, [1]))).rejects.toBe(writeFailure);
    writeWriter.releaseLock();
    await writeDestination.discard();

    const closeDirectory = new FakeDirectory('close-failure');
    const closeDestination = await createOpfsDestination(closeDirectory.handle);
    const closeName = closeDirectory.outputNames()[0];
    if (closeName === undefined) {
      throw new Error('Missing test output');
    }
    const closeFailure = new Error('close failed');
    closeDirectory.file(closeName).failClose = closeFailure;
    const closeWriter = closeDestination.stream.getWriter();
    await expect(closeWriter.close()).rejects.toBe(closeFailure);
    closeWriter.releaseLock();
    await closeDestination.discard();
    expect(closeDirectory.outputNames()).toEqual([]);
  });

  it('retries a tracked pending cleanup during session disposal', async () => {
    const { parent } = installOpfs('pending-session-retry', (directory) => {
      directory.outputRemovalError = new Error('pending remove failed');
    });
    const session = createAudioTranscoderOutputSession({
      namespace: 'pending-session-retry',
    });
    const pending = await session.create();
    const ownDirectory = parent.directory(timestampedName(NOW, UUID));

    await expect(pending.discard()).rejects.toThrow('pending remove failed');
    expect(ownDirectory.outputRemovalAttempts).toBe(1);
    ownDirectory.outputRemovalError = undefined;

    await session.dispose();
    expect(ownDirectory.outputRemovalAttempts).toBe(2);
    expect(parent.names()).toEqual([]);
  });

  it('retries a tracked artifact cleanup during session disposal', async () => {
    const { parent } = installOpfs('artifact-session-retry');
    const session = createAudioTranscoderOutputSession({
      namespace: 'artifact-session-retry',
    });
    const pending = await session.create();
    const writer = pending.stream.getWriter();
    await writer.close();
    writer.releaseLock();
    const artifact = await pending.complete({
      mimeType: 'audio/test',
      name: 'output.test',
    });
    const ownDirectory = parent.directory(timestampedName(NOW, UUID));
    ownDirectory.outputRemovalError = new Error('artifact remove failed');

    await expect(artifact.dispose()).rejects.toThrow('artifact remove failed');
    expect(ownDirectory.outputRemovalAttempts).toBe(1);
    ownDirectory.outputRemovalError = undefined;

    await session.dispose();
    expect(ownDirectory.outputRemovalAttempts).toBe(2);
    expect(parent.names()).toEqual([]);
  });

  it('falls back to memory after a partial destination failure', async () => {
    const { parent } = installOpfs('partial-output', (directory) => {
      directory.failOutputWritable = true;
    });
    const session = createAudioTranscoderOutputSession({
      memoryLimitBytes: 8,
      namespace: 'partial-output',
    });
    const pending = await session.create({ maxMemoryArtifactBytes: 2 });

    expect(pending.storage).toBe('memory');
    expect(pending.maxOutputBytes).toBe(2);
    expect(await session.getStorageMode()).toBe('memory');
    expect(parent.directory(timestampedName(NOW, UUID)).outputNames()).toEqual([]);
    await pending.discard();
    await session.dispose();
  });

  it('ignores failed partial-file cleanup while switching to memory', async () => {
    const { parent } = installOpfs('partial-cleanup', (directory) => {
      directory.failOutputWritable = true;
      directory.outputRemovalError = new Error('partial cleanup failed');
    });
    const session = createAudioTranscoderOutputSession({
      memoryLimitBytes: 8,
      namespace: 'partial-cleanup',
    });

    expect((await session.create()).storage).toBe('memory');
    expect(
      parent.directory(timestampedName(NOW, UUID)).outputNames(),
    ).toHaveLength(1);
    await session.dispose();
  });

  it('falls back safely across unavailable and partial OPFS initialization', async () => {
    const rootFailure = createAudioTranscoderOutputSession({ namespace: 'root-fail' });
    vi.stubGlobal('navigator', {
      storage: { getDirectory: () => Promise.reject(new Error('root failed')) },
    });
    expect(await rootFailure.getStorageMode()).toBe('memory');
    await rootFailure.dispose();

    const root = new FakeDirectory('root');
    const parent = root.addDirectory('lease-fail');
    parent.onCreateDirectory = (directory) => {
      directory.failLeaseWritable = true;
    };
    const locks = new FakeLockManager();
    vi.stubGlobal('navigator', {
      locks,
      storage: { getDirectory: () => Promise.resolve(root.handle) },
    });
    const leaseFailure = createAudioTranscoderOutputSession({
      namespace: 'lease-fail',
    });
    expect(await leaseFailure.getStorageMode()).toBe('memory');
    expect(parent.names()).toEqual([]);
    expect(locks.heldNames()).toEqual([]);
    await leaseFailure.dispose();

    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('random unavailable');
    });
    const randomFailure = createAudioTranscoderOutputSession({
      namespace: 'lease-fail',
    });
    expect(await randomFailure.getStorageMode()).toBe('memory');
    await randomFailure.dispose();
  });

  it('ignores failed cleanup after partial OPFS initialization', async () => {
    const root = new FakeDirectory('root');
    const parent = root.addDirectory('init-cleanup-fail');
    parent.onCreateDirectory = (directory) => {
      directory.failLeaseWritable = true;
    };
    parent.removeErrors.set(
      timestampedName(NOW, UUID),
      new Error('initialization cleanup failed'),
    );
    vi.stubGlobal('navigator', {
      storage: { getDirectory: () => Promise.resolve(root.handle) },
    });
    const session = createAudioTranscoderOutputSession({
      namespace: 'init-cleanup-fail',
    });

    expect(await session.getStorageMode()).toBe('memory');
    expect(parent.names()).toEqual([timestampedName(NOW, UUID)]);
    await session.dispose();
  });

  it('falls back when lock acquisition rejects, returns null, or throws', async () => {
    for (const failure of ['reject', 'null', 'throw'] as const) {
      const namespace = `lock-${failure}`;
      const root = new FakeDirectory('root');
      root.addDirectory(namespace);
      const locks = new FakeLockManager();
      const ownLock = lockName(namespace, timestampedName(NOW, UUID));
      if (failure === 'reject') {
        locks.rejectBeforeCallback.add(ownLock);
      } else if (failure === 'null') {
        locks.rejectAfterNullCallback.add(ownLock);
      } else {
        locks.throwSynchronously.add(ownLock);
      }
      vi.stubGlobal('navigator', {
        locks,
        storage: { getDirectory: () => Promise.resolve(root.handle) },
      });
      const session = createAudioTranscoderOutputSession({ namespace });

      expect(await session.getStorageMode()).toBe('opfs');
      expect(locks.heldNames()).toEqual([]);
      await session.dispose();
    }
  });

  it('handles heartbeat failure and already-removed output files', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { parent } = installOpfs('opfs-recovery');
    const session = createAudioTranscoderOutputSession({
      namespace: 'opfs-recovery',
    });
    await session.getStorageMode();
    const ownDirectory = parent.directory(timestampedName(NOW, UUID));
    ownDirectory.file('.lease.json').failCreateWritable = true;
    await vi.advanceTimersByTimeAsync(60_000);

    const pending = await session.create();
    const outputName = ownDirectory.outputNames()[0];
    if (outputName === undefined) {
      throw new Error('Missing test output');
    }
    await ownDirectory.removeEntry(outputName);
    await pending.discard();
    await session.dispose();
  });

  it('keeps the original completion error when backing cleanup also fails', async () => {
    const { parent } = installOpfs('complete-fail', (directory) => {
      directory.outputGetFileError = new Error('snapshot failed');
      directory.outputRemovalError = new Error('remove failed');
    });
    const session = createAudioTranscoderOutputSession({
      namespace: 'complete-fail',
    });
    const pending = await session.create();
    const writer = pending.stream.getWriter();
    await writer.close();
    writer.releaseLock();

    await expect(
      pending.complete({ mimeType: 'audio/wav', name: 'failed.wav' }),
    ).rejects.toThrow('snapshot failed');
    const ownDirectory = parent.directory(timestampedName(NOW, UUID));
    expect(ownDirectory.outputRemovalAttempts).toBe(1);
    ownDirectory.outputRemovalError = undefined;
    await session.dispose();
    expect(ownDirectory.outputRemovalAttempts).toBe(2);
  });
});

describe('orphan reclamation', () => {
  it('uses origin locks to preserve active tabs and reclaim unlocked sessions', async () => {
    const root = new FakeDirectory('root');
    const parent = root.addDirectory('lock-sweep');
    const active = timestampedName(NOW - 1, OTHER_UUID);
    const orphan = timestampedName(NOW - 2, UUID);
    parent.addDirectory(active);
    parent.addDirectory(orphan);
    parent.addDirectory('unrelated');
    parent.addFile('plain-file');
    const locks = new FakeLockManager([
      lockName('lock-sweep', active),
    ]);
    vi.stubGlobal('navigator', {
      locks,
      storage: { getDirectory: () => Promise.resolve(root.handle) },
    });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '33333333-3333-4333-8333-333333333333',
    );
    const session = createAudioTranscoderOutputSession({ namespace: 'lock-sweep' });

    expect(await session.getStorageMode()).toBe('opfs');
    expect(parent.has(active)).toBe(true);
    expect(parent.has(orphan)).toBe(false);
    expect(parent.has('unrelated')).toBe(true);
    expect(parent.has('plain-file')).toBe(true);
    await session.dispose();
  });

  it('falls back to conservative timestamps when Web Locks are unavailable', async () => {
    const root = new FakeDirectory('root');
    const parent = root.addDirectory('age-sweep');
    const staleLease = timestampedName(NOW - WEEK_MS, UUID);
    const freshLease = timestampedName(NOW - WEEK_MS + 1, OTHER_UUID);
    const staleNameOnly = timestampedName(
      NOW - WEEK_MS - 1,
      '33333333-3333-4333-8333-333333333333',
    );
    const legacyUnknown = `session-44444444-4444-4444-8444-444444444444`;
    parent.addDirectory(staleLease).setLease(
      lease('age-sweep', staleLease, NOW - WEEK_MS),
    );
    parent.addDirectory(freshLease).setLease(
      lease('age-sweep', freshLease, NOW - WEEK_MS + 1),
    );
    parent.addDirectory(staleNameOnly).addFile('.lease.json', '{bad json');
    parent.addDirectory(legacyUnknown);
    vi.stubGlobal('navigator', {
      locks: {},
      storage: { getDirectory: () => Promise.resolve(root.handle) },
    });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '55555555-5555-4555-8555-555555555555',
    );
    const session = createAudioTranscoderOutputSession({ namespace: 'age-sweep' });

    expect(await session.getStorageMode()).toBe('opfs');
    expect(parent.has(staleLease)).toBe(false);
    expect(parent.has(staleNameOnly)).toBe(false);
    expect(parent.has(freshLease)).toBe(true);
    expect(parent.has(legacyUnknown)).toBe(true);
    await session.dispose();
  });

  it('uses timestamp fallback when a lock request fails before its callback', async () => {
    const root = new FakeDirectory('root');
    const parent = root.addDirectory('lock-fallback');
    const stale = timestampedName(NOW - WEEK_MS, OTHER_UUID);
    parent.addDirectory(stale);
    const locks = new FakeLockManager();
    locks.rejectBeforeCallback.add(lockName('lock-fallback', stale));
    vi.stubGlobal('navigator', {
      locks,
      storage: { getDirectory: () => Promise.resolve(root.handle) },
    });
    const session = createAudioTranscoderOutputSession({
      namespace: 'lock-fallback',
    });

    expect(await session.getStorageMode()).toBe('opfs');
    expect(parent.has(stale)).toBe(false);
    await session.dispose();
  });

  it('keeps a stale session when fallback deletion fails', async () => {
    const root = new FakeDirectory('root');
    const parent = root.addDirectory('failed-sweep');
    const stale = timestampedName(NOW - WEEK_MS, OTHER_UUID);
    parent.addDirectory(stale);
    parent.removeErrors.set(stale, new Error('sweep failed'));
    vi.stubGlobal('navigator', {
      storage: { getDirectory: () => Promise.resolve(root.handle) },
    });
    const session = createAudioTranscoderOutputSession({
      namespace: 'failed-sweep',
    });

    expect(await session.getStorageMode()).toBe('opfs');
    expect(parent.has(stale)).toBe(true);
    await session.dispose();
  });

  it('keeps OPFS usable when directory enumeration fails', async () => {
    const root = new FakeDirectory('root');
    const parent = root.addDirectory('entries-fail');
    parent.entriesError = new Error('enumeration failed');
    vi.stubGlobal('navigator', {
      storage: { getDirectory: () => Promise.resolve(root.handle) },
    });
    const session = createAudioTranscoderOutputSession({
      namespace: 'entries-fail',
    });

    expect(await session.getStorageMode()).toBe('opfs');
    await session.dispose();
  });
});

describe('disposal races and failures', () => {
  it('waits for initialization and rejects a racing create without leaking a session', async () => {
    const root = new FakeDirectory('root');
    const parent = root.addDirectory('race-test');
    const directoryGate = deferred<FileSystemDirectoryHandle>();
    vi.stubGlobal('navigator', {
      storage: { getDirectory: () => directoryGate.promise },
    });
    const session = createAudioTranscoderOutputSession({ namespace: 'race-test' });
    const creation = session.create();
    const disposal = session.dispose();
    directoryGate.resolve(root.handle);

    await expect(creation).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    await disposal;
    expect(parent.names()).toEqual([]);
  });

  it('discards a destination that finishes opening after disposal starts', async () => {
    const writableGate = deferred<void>();
    const { parent } = installOpfs('create-race', (directory) => {
      directory.outputWritableGate = writableGate.promise;
    });
    const session = createAudioTranscoderOutputSession({ namespace: 'create-race' });
    await session.getStorageMode();
    const creation = session.create();
    await vi.waitFor(() => {
      expect(
        parent.directory(timestampedName(NOW, UUID)).outputNames(),
      ).toHaveLength(1);
    });
    const disposal = session.dispose();
    writableGate.resolve();

    await expect(creation).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    await disposal;
    expect(parent.names()).toEqual([]);
  });

  it('disposes an artifact completed concurrently with its session', async () => {
    const snapshotGate = deferred<void>();
    const { parent } = installOpfs('complete-race', (directory) => {
      directory.outputGetFileGate = snapshotGate.promise;
    });
    const session = createAudioTranscoderOutputSession({
      namespace: 'complete-race',
    });
    const pending = await session.create();
    const writer = pending.stream.getWriter();
    await writer.write(chunk(0, [1]));
    await writer.close();
    writer.releaseLock();
    const completion = pending.complete({
      mimeType: 'audio/wav',
      name: 'race.wav',
    });
    const disposal = session.dispose();
    snapshotGate.resolve();

    await expect(completion).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    await disposal;
    expect(parent.names()).toEqual([]);
  });

  it('reports cleanup failures, remains idempotent, and becomes terminal', async () => {
    const { parent } = installOpfs('cleanup-fail', (directory) => {
      directory.outputRemovalError = new Error('output remove failed');
    });
    const ownName = timestampedName(NOW, UUID);
    parent.removeErrors.set(ownName, new Error('session remove failed'));
    const session = createAudioTranscoderOutputSession({
      namespace: 'cleanup-fail',
    });
    await session.create();
    const disposal = session.dispose();

    await expect(disposal).rejects.toBeInstanceOf(AggregateError);
    expect(session.dispose()).toBe(disposal);
    await expect(session.create()).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
  });

  it('reports an actual output removal failure after a native abort failure', async () => {
    const { parent } = installOpfs('discard-fail', (directory) => {
      directory.outputAbortError = new Error('abort failed');
      directory.outputRemovalError = new Error('remove failed');
    });
    const session = createAudioTranscoderOutputSession({
      namespace: 'discard-fail',
    });
    await session.create();

    await expect(session.dispose()).rejects.toThrow('remove failed');
    expect(parent.names()).toEqual([]);
  });
});

function chunk(position: number, values: readonly number[]): AudioStreamOutputChunk {
  return {
    data: new Uint8Array(values),
    position,
    type: 'write',
  };
}

function testDestination(
  blob: Blob,
  discard: () => Promise<void>,
): OutputDestination {
  return {
    complete: () => Promise.resolve(blob),
    discard,
    storage: 'opfs',
    stream: new WritableStream<AudioStreamOutputChunk>(),
  };
}

function pageHideEvent(persisted: boolean): Event {
  const event = new Event('pagehide');
  Object.defineProperty(event, 'persisted', { value: persisted });
  return event;
}

function timestampedName(timestamp: number, uuid: string): string {
  return `session-v1-${timestamp}-${uuid}`;
}

function lockName(namespace: string, sessionName: string): string {
  return `audio-transcoder:output-session:${namespace}:${sessionName}`;
}

function lease(namespace: string, session: string, heartbeatAt: number): string {
  return JSON.stringify({
    createdAt: heartbeatAt,
    heartbeatAt,
    namespace,
    session,
    version: 1,
  });
}

function installOpfs(
  namespace: string,
  initializeSession?: (directory: FakeDirectory) => void,
): { locks: FakeLockManager; parent: FakeDirectory; root: FakeDirectory } {
  const root = new FakeDirectory('root');
  const parent = root.addDirectory(namespace);
  parent.onCreateDirectory = (directory, name) => {
    if (name.startsWith('session-v1-')) {
      initializeSession?.(directory);
    }
  };
  const locks = new FakeLockManager();
  vi.stubGlobal('navigator', {
    locks,
    storage: { getDirectory: () => Promise.resolve(root.handle) },
  });
  return { locks, parent, root };
}

class FakeLockManager {
  readonly rejectBeforeCallback = new Set<string>();
  readonly rejectAfterNullCallback = new Set<string>();
  readonly throwSynchronously = new Set<string>();
  private readonly held = new Set<string>();

  constructor(initiallyHeld: readonly string[] = []) {
    for (const name of initiallyHeld) {
      this.held.add(name);
    }
  }

  heldNames(): readonly string[] {
    return [...this.held];
  }

  request<T>(
    name: string,
    options: { readonly ifAvailable?: boolean; readonly mode: 'exclusive' },
    callback: (lock: object | null) => PromiseLike<T> | T,
  ): Promise<T> {
    if (this.throwSynchronously.has(name)) {
      throw new Error('lock request threw');
    }
    if (this.rejectBeforeCallback.has(name)) {
      return Promise.reject(new Error('lock request failed'));
    }
    if (this.rejectAfterNullCallback.has(name)) {
      return Promise.resolve(callback(null)).then(() =>
        Promise.reject(new Error('lock callback failed')),
      );
    }
    if (options.ifAvailable && this.held.has(name)) {
      return Promise.resolve(callback(null));
    }
    this.held.add(name);
    return Promise.resolve(callback({ name })).finally(() => {
      this.held.delete(name);
    });
  }
}

class FakeDirectory {
  readonly handle = this as unknown as FileSystemDirectoryHandle;
  readonly kind = 'directory' as const;
  readonly removeErrors = new Map<string, Error>();
  entriesError: Error | undefined;
  failLeaseWritable = false;
  failOutputWritable = false;
  onCreateDirectory:
    | ((directory: FakeDirectory, name: string) => void)
    | undefined;
  outputAbortError: Error | undefined;
  outputAbortGate: Promise<void> | undefined;
  outputAbortAttempts = 0;
  readonly outputEvents: string[] = [];
  outputGetFileError: Error | undefined;
  outputGetFileGate: Promise<void> | undefined;
  outputMimeType = '';
  outputRemovalError: Error | undefined;
  outputRemovalGate: Promise<void> | undefined;
  outputRemovalAttempts = 0;
  outputWritableGate: Promise<void> | undefined;
  private readonly children = new Map<string, FakeDirectory | FakeFile>();

  constructor(readonly name: string) {}

  addDirectory(name: string): FakeDirectory {
    const directory = new FakeDirectory(name);
    this.children.set(name, directory);
    return directory;
  }

  addFile(name: string, content = ''): FakeFile {
    const file = new FakeFile(name, content);
    this.children.set(name, file);
    return file;
  }

  directory(name: string): FakeDirectory {
    const entry = this.children.get(name);
    if (!(entry instanceof FakeDirectory)) {
      throw new Error(`Missing directory: ${name}`);
    }
    return entry;
  }

  file(name: string): FakeFile {
    const entry = this.children.get(name);
    if (!(entry instanceof FakeFile)) {
      throw new Error(`Missing file: ${name}`);
    }
    return entry;
  }

  has(name: string): boolean {
    return this.children.has(name);
  }

  names(): readonly string[] {
    return [...this.children.keys()];
  }

  outputNames(): readonly string[] {
    return this.names().filter((name) => name.startsWith('output-'));
  }

  setLease(content: string): void {
    this.addFile('.lease.json', content);
  }

  async getDirectoryHandle(
    name: string,
    options: FileSystemGetDirectoryOptions = {},
  ): Promise<FileSystemDirectoryHandle> {
    const current = this.children.get(name);
    if (current instanceof FakeDirectory) {
      return current.handle;
    }
    if (current !== undefined || !options.create) {
      throw namedError('NotFoundError');
    }
    const directory = this.addDirectory(name);
    this.onCreateDirectory?.(directory, name);
    return directory.handle;
  }

  async getFileHandle(
    name: string,
    options: FileSystemGetFileOptions = {},
  ): Promise<FileSystemFileHandle> {
    const current = this.children.get(name);
    if (current instanceof FakeFile) {
      return current.handle;
    }
    if (current !== undefined || !options.create) {
      throw namedError('NotFoundError');
    }
    const file = this.addFile(name);
    file.failCreateWritable =
      (name === '.lease.json' && this.failLeaseWritable) ||
      (name.startsWith('output-') && this.failOutputWritable);
    if (name.startsWith('output-')) {
      file.failAbort = this.outputAbortError;
      file.abortGate = this.outputAbortGate;
      file.onAbortSettled = () => {
        this.outputEvents.push('abort:settled');
      };
      file.onAbortStart = () => {
        this.outputAbortAttempts += 1;
        this.outputEvents.push('abort:start');
      };
      file.getFileError = this.outputGetFileError;
      file.getFileGate = this.outputGetFileGate;
      file.mimeType = this.outputMimeType;
      file.writableGate = this.outputWritableGate;
    }
    return file.handle;
  }

  async removeEntry(
    name: string,
    _options?: FileSystemRemoveOptions,
  ): Promise<void> {
    if (name.startsWith('output-')) {
      this.outputRemovalAttempts += 1;
      this.outputEvents.push('remove:start');
      await this.outputRemovalGate;
    }
    const configured = this.removeErrors.get(name);
    if (configured !== undefined) {
      throw configured;
    }
    if (!this.children.has(name)) {
      throw namedError('NotFoundError');
    }
    if (name.startsWith('output-') && this.outputRemovalError !== undefined) {
      throw this.outputRemovalError;
    }
    this.children.delete(name);
  }

  async *entries(): AsyncIterableIterator<
    [string, FileSystemDirectoryHandle | FileSystemFileHandle]
  > {
    if (this.entriesError !== undefined) {
      throw this.entriesError;
    }
    for (const [name, child] of [...this.children]) {
      yield [name, child.handle];
    }
  }
}

class FakeFile {
  readonly handle = this as unknown as FileSystemFileHandle;
  readonly kind = 'file' as const;
  abortGate: Promise<void> | undefined;
  failAbort: Error | undefined;
  failClose: Error | undefined;
  failCreateWritable = false;
  failWrite: Error | undefined;
  getFileError: Error | undefined;
  getFileGate: Promise<void> | undefined;
  mimeType = '';
  onAbortSettled: (() => void) | undefined;
  onAbortStart: (() => void) | undefined;
  writableGate: Promise<void> | undefined;
  private bytes: Uint8Array<ArrayBuffer>;

  constructor(
    readonly name: string,
    content: string | Uint8Array<ArrayBuffer> = '',
  ) {
    this.bytes =
      typeof content === 'string'
        ? new Uint8Array(new TextEncoder().encode(content))
        : content;
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    await this.writableGate;
    if (this.failCreateWritable) {
      throw new Error('createWritable failed');
    }
    return new FakeWritable(this) as unknown as FileSystemWritableFileStream;
  }

  async getFile(): Promise<File> {
    await this.getFileGate;
    if (this.getFileError !== undefined) {
      throw this.getFileError;
    }
    const blob = new Blob([this.bytes], { type: this.mimeType });
    return blob as File;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }

  async applyWrite(data: FileSystemWriteChunkType): Promise<void> {
    if (this.failWrite !== undefined) {
      throw this.failWrite;
    }
    if (typeof data === 'string') {
      this.bytes = new Uint8Array(new TextEncoder().encode(data));
      return;
    }
    if (data instanceof Blob) {
      this.bytes = new Uint8Array(await data.arrayBuffer());
      return;
    }
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) {
      this.bytes = copyBufferSource(data);
      return;
    }
    if (data.type === 'write') {
      if (data.data === undefined || data.data === null) {
        throw new Error('Missing write data');
      }
      const source =
        data.data instanceof Blob
          ? new Uint8Array(await data.data.arrayBuffer())
          : typeof data.data === 'string'
            ? new Uint8Array(new TextEncoder().encode(data.data))
          : copyBufferSource(data.data);
      const position = data.position ?? 0;
      const next = new Uint8Array(
        Math.max(this.bytes.byteLength, position + source.byteLength),
      );
      next.set(this.bytes);
      next.set(source, position);
      this.bytes = next;
    }
  }
}

class FakeWritable extends WritableStream<FileSystemWriteChunkType> {
  constructor(private readonly file: FakeFile) {
    super({
      abort: async () => {
        file.onAbortStart?.();
        try {
          await file.abortGate;
          if (file.failAbort !== undefined) {
            throw file.failAbort;
          }
        } finally {
          file.onAbortSettled?.();
        }
      },
      close: () => {
        if (file.failClose !== undefined) {
          throw file.failClose;
        }
      },
      write: (data) => file.applyWrite(data),
    });
  }

  override close(): Promise<void> {
    if (this.file.failClose !== undefined) {
      return Promise.reject(this.file.failClose);
    }
    return Promise.resolve();
  }

  write(data: FileSystemWriteChunkType): Promise<void> {
    return this.file.applyWrite(data);
  }
}

function copyBufferSource(source: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source.slice(0));
  }
  return new Uint8Array(
    source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer,
  );
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
