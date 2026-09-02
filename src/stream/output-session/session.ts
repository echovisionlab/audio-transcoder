import type {
  AudioTranscoderOutputMemoryReservation,
  AudioTranscoderOutputSession,
  AudioTranscoderOutputStorage,
  AudioTranscoderPendingOutput,
  CreateAudioTranscoderPendingOutputOptions,
} from '../output-session.js';
import {
  collectFailures,
  invalidConfiguration,
  sessionDisposedError,
  throwCollectedFailures,
  type OutputDestination,
} from './internal.js';
import {
  createMemoryDestination,
  SessionMemoryBudget,
} from './memory-destination.js';
import {
  createOpfsDestination,
  removeEntryIfPresent,
} from './opfs-destination.js';
import { ManagedPendingOutput } from './resource.js';

const LEASE_FILE_NAME = '.lease.json';
const LEASE_HEARTBEAT_MS = 60_000;
const ORPHAN_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const TIMESTAMPED_SESSION_PATTERN = new RegExp(
  `^session-v1-(\\d{13})-${UUID_PATTERN}$`,
  'i',
);

interface OriginPrivateStorage {
  getDirectory(): Promise<FileSystemDirectoryHandle>;
}

interface OriginLockManager {
  request<T>(
    name: string,
    options: { readonly ifAvailable?: boolean; readonly mode: 'exclusive' },
    callback: (lock: object | null) => PromiseLike<T> | T,
  ): Promise<T>;
}

interface LeaseRecord {
  readonly createdAt: number;
  readonly heartbeatAt: number;
  readonly namespace: string;
  readonly session: string;
  readonly version: 1;
}

export class DefaultOutputSession implements AudioTranscoderOutputSession {
  private readonly creations = new Set<Promise<AudioTranscoderPendingOutput>>();
  private disposal: Promise<void> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatWrite: Promise<void> = Promise.resolve();
  private initialization: Promise<void> | undefined;
  private lifecycleTarget: Window | undefined;
  private lockManager: OriginLockManager | undefined;
  private lockRelease: (() => void) | undefined;
  private lockRequest: Promise<void> | undefined;
  private readonly memoryBudget: SessionMemoryBudget;
  private mode: AudioTranscoderOutputStorage = 'memory';
  private parentDirectory: FileSystemDirectoryHandle | undefined;
  private readonly resources = new Set<ManagedPendingOutput>();
  private sessionDirectory: FileSystemDirectoryHandle | undefined;
  private sessionName: string | undefined;
  private state: 'active' | 'disposed' | 'disposing' = 'active';

  private readonly pageHideListener = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      return;
    }
    void this.dispose().catch(() => undefined);
  };

  constructor(
    private readonly namespace: string,
    memoryLimitBytes: number,
    disposeOnPageHide: boolean,
  ) {
    this.memoryBudget = new SessionMemoryBudget(memoryLimitBytes);
    if (disposeOnPageHide && typeof window !== 'undefined') {
      this.lifecycleTarget = window;
      window.addEventListener('pagehide', this.pageHideListener);
    }
  }

  create(
    options: CreateAudioTranscoderPendingOutputOptions = {},
  ): Promise<AudioTranscoderPendingOutput> {
    if (this.state !== 'active') {
      return Promise.reject(sessionDisposedError());
    }
    let maxMemoryArtifactBytes: number | undefined;
    try {
      maxMemoryArtifactBytes = validateCreateOptions(options);
    } catch (error) {
      return Promise.reject(error);
    }
    const creation = this.createOutput(maxMemoryArtifactBytes);
    this.creations.add(creation);
    void creation.then(
      () => this.creations.delete(creation),
      () => this.creations.delete(creation),
    );
    return creation;
  }

  dispose(): Promise<void> {
    if (this.disposal === undefined) {
      this.state = 'disposing';
      this.lifecycleTarget?.removeEventListener(
        'pagehide',
        this.pageHideListener,
      );
      this.lifecycleTarget = undefined;
      this.disposal = this.disposeOnce();
    }
    return this.disposal;
  }

  async getStorageMode(): Promise<AudioTranscoderOutputStorage> {
    if (this.state === 'active') {
      await this.initialize();
    }
    return this.mode;
  }

  getMemoryReservation(): AudioTranscoderOutputMemoryReservation {
    return this.memoryBudget.snapshot();
  }

  private async createOutput(
    maxMemoryArtifactBytes: number | undefined,
  ): Promise<AudioTranscoderPendingOutput> {
    await this.initialize();
    if (this.state !== 'active') {
      throw sessionDisposedError();
    }

    let destination: OutputDestination;
    if (this.mode === 'opfs' && this.sessionDirectory !== undefined) {
      try {
        destination = await createOpfsDestination(this.sessionDirectory);
      } catch {
        this.mode = 'memory';
        destination = createMemoryDestination(
          this.memoryBudget,
          maxMemoryArtifactBytes,
        );
      }
    } else {
      destination = createMemoryDestination(
        this.memoryBudget,
        maxMemoryArtifactBytes,
      );
    }

    if (this.state !== 'active') {
      await destination.discard();
      throw sessionDisposedError();
    }
    const pending = new ManagedPendingOutput(destination, () => {
      this.resources.delete(pending);
    });
    this.resources.add(pending);
    return pending;
  }

  private async disposeOnce(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.initialization;
      await Promise.allSettled([...this.creations]);
      const settlements = await Promise.allSettled(
        [...this.resources].map((resource) => resource.discard()),
      );
      collectFailures(settlements, failures);

      if (this.heartbeatTimer !== undefined) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      }
      await this.heartbeatWrite;

      const parent = this.parentDirectory;
      const sessionName = this.sessionName;
      this.parentDirectory = undefined;
      this.sessionDirectory = undefined;
      this.sessionName = undefined;
      if (parent !== undefined && sessionName !== undefined) {
        try {
          await removeEntryIfPresent(parent, sessionName, true);
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      this.lockRelease?.();
      await this.lockRequest;
      this.lockManager = undefined;
      this.lockRelease = undefined;
      this.lockRequest = undefined;
      this.state = 'disposed';
    }
    throwCollectedFailures(failures, 'Failed to dispose output session.');
  }

  private async initialize(): Promise<void> {
    this.initialization ??= this.openStorage();
    await this.initialization;
  }

  private async openStorage(): Promise<void> {
    const storage = getOriginPrivateStorage();
    if (storage === undefined) {
      return;
    }

    let parent: FileSystemDirectoryHandle | undefined;
    let sessionName: string | undefined;
    try {
      const root = await storage.getDirectory();
      parent = await root.getDirectoryHandle(this.namespace, { create: true });
      const createdAt = Date.now();
      sessionName = `session-v1-${createdAt}-${crypto.randomUUID()}`;
      const lockManager = getOriginLockManager();
      const lockHeld =
        lockManager === undefined
          ? false
          : await this.acquireSessionLock(lockManager, sessionName);
      if (lockHeld) {
        this.lockManager = lockManager;
      }

      const directory = await parent.getDirectoryHandle(sessionName, {
        create: true,
      });
      await writeLease(directory, {
        createdAt,
        heartbeatAt: createdAt,
        namespace: this.namespace,
        session: sessionName,
        version: 1,
      });

      this.parentDirectory = parent;
      this.sessionDirectory = directory;
      this.sessionName = sessionName;
      this.mode = 'opfs';
      this.startHeartbeat(directory, sessionName, createdAt);
      await this.reclaimOrphans(parent, sessionName).catch(() => undefined);
    } catch {
      if (parent !== undefined && sessionName !== undefined) {
        await removeEntryIfPresent(parent, sessionName, true).catch(
          () => undefined,
        );
      }
      this.lockRelease?.();
      await this.lockRequest;
      this.lockManager = undefined;
      this.lockRelease = undefined;
      this.lockRequest = undefined;
      this.parentDirectory = undefined;
      this.sessionDirectory = undefined;
      this.sessionName = undefined;
      this.mode = 'memory';
    }
  }

  private async acquireSessionLock(
    manager: OriginLockManager,
    sessionName: string,
  ): Promise<boolean> {
    let reportAcquired!: (value: boolean) => void;
    let release!: () => void;
    let reported = false;
    const acquired = new Promise<boolean>((resolve) => {
      reportAcquired = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const request = manager.request(
        lockName(this.namespace, sessionName),
        { mode: 'exclusive' },
        async (lock) => {
          reported = true;
          reportAcquired(lock !== null);
          if (lock !== null) {
            await held;
          }
        },
      );
      this.lockRelease = release;
      this.lockRequest = request.then(
        () => undefined,
        () => undefined,
      );
      void request.catch(() => {
        if (!reported) {
          reportAcquired(false);
        }
      });
      const lockHeld = await acquired;
      if (!lockHeld) {
        release();
      }
      return lockHeld;
    } catch {
      release();
      return false;
    }
  }

  private startHeartbeat(
    directory: FileSystemDirectoryHandle,
    sessionName: string,
    createdAt: number,
  ): void {
    this.heartbeatTimer = setInterval(() => {
      this.heartbeatWrite = this.heartbeatWrite
        .then(() =>
          writeLease(directory, {
            createdAt,
            heartbeatAt: Date.now(),
            namespace: this.namespace,
            session: sessionName,
            version: 1,
          }),
        )
        .catch(() => undefined);
    }, LEASE_HEARTBEAT_MS);
  }

  private async reclaimOrphans(
    parent: FileSystemDirectoryHandle,
    currentSession: string,
  ): Promise<void> {
    for await (const [name, handle] of parent.entries()) {
      if (
        handle.kind !== 'directory' ||
        name === currentSession ||
        !isManagedSessionName(name)
      ) {
        continue;
      }
      if (await this.reclaimWithLock(parent, name)) {
        continue;
      }
      if (await isExpiredSession(parent, name, this.namespace, Date.now())) {
        await removeEntryIfPresent(parent, name, true).catch(() => undefined);
      }
    }
  }

  private async reclaimWithLock(
    parent: FileSystemDirectoryHandle,
    sessionName: string,
  ): Promise<boolean> {
    const manager = this.lockManager;
    if (manager === undefined) {
      return false;
    }
    let callbackRan = false;
    try {
      await manager.request(
        lockName(this.namespace, sessionName),
        { ifAvailable: true, mode: 'exclusive' },
        async (lock) => {
          callbackRan = true;
          if (lock !== null) {
            await removeEntryIfPresent(parent, sessionName, true);
          }
        },
      );
      return true;
    } catch {
      return callbackRan;
    }
  }
}

function validateCreateOptions(
  options: CreateAudioTranscoderPendingOutputOptions,
): number | undefined {
  if (options === null || typeof options !== 'object') {
    throw invalidConfiguration('Output creation options must be an object.');
  }
  const value = options.maxMemoryArtifactBytes;
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 0)
  ) {
    throw invalidConfiguration(
      'maxMemoryArtifactBytes must be a non-negative safe integer.',
    );
  }
  return value;
}

function getOriginPrivateStorage(): OriginPrivateStorage | undefined {
  if (typeof navigator === 'undefined' || !('storage' in navigator)) {
    return undefined;
  }
  const storage = navigator.storage as OriginPrivateStorage | undefined;
  return typeof storage?.getDirectory === 'function' ? storage : undefined;
}

function getOriginLockManager(): OriginLockManager | undefined {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) {
    return undefined;
  }
  const locks = navigator.locks as unknown as OriginLockManager | undefined;
  return typeof locks?.request === 'function' ? locks : undefined;
}

async function writeLease(
  directory: FileSystemDirectoryHandle,
  lease: LeaseRecord,
): Promise<void> {
  const handle = await directory.getFileHandle(LEASE_FILE_NAME, {
    create: true,
  });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(lease));
  await writable.close();
}

async function isExpiredSession(
  parent: FileSystemDirectoryHandle,
  sessionName: string,
  namespace: string,
  now: number,
): Promise<boolean> {
  let timestamp: number | undefined;
  try {
    const directory = await parent.getDirectoryHandle(sessionName);
    const handle = await directory.getFileHandle(LEASE_FILE_NAME);
    const parsed = JSON.parse(await (await handle.getFile()).text()) as Partial<
      LeaseRecord
    >;
    if (
      parsed.version === 1 &&
      parsed.namespace === namespace &&
      parsed.session === sessionName &&
      Number.isFinite(parsed.heartbeatAt)
    ) {
      timestamp = parsed.heartbeatAt;
    }
  } catch {
    timestamp = undefined;
  }
  const effectiveTimestamp = timestamp ?? timestampFromSessionName(sessionName);
  return now - effectiveTimestamp >= ORPHAN_MIN_AGE_MS;
}

function timestampFromSessionName(sessionName: string): number {
  return Number(
    sessionName.slice('session-v1-'.length, 'session-v1-'.length + 13),
  );
}

function isManagedSessionName(name: string): boolean {
  return TIMESTAMPED_SESSION_PATTERN.test(name);
}

function lockName(namespace: string, sessionName: string): string {
  return `audio-transcoder:output-session:${namespace}:${sessionName}`;
}
