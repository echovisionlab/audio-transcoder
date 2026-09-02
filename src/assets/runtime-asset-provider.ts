export type RuntimeAssetLoadingPhase =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'error';

export type RuntimeAssetErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'ABI_MISMATCH'
  | 'ASSET_NOT_FOUND'
  | 'HTTP_ERROR'
  | 'SIZE_MISMATCH'
  | 'INTEGRITY_MISMATCH'
  | 'LOAD_ABORTED'
  | 'DOWNLOAD_FAILED';

export class RuntimeAssetError extends Error {
  override readonly name = 'RuntimeAssetError';

  constructor(
    readonly code: RuntimeAssetErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface RuntimeAssetDescriptor {
  /** Stable, package-relative name such as `aac.wasm`. */
  readonly path: string;
  readonly bytes: number;
  /** Lower- or upper-case hexadecimal SHA-256 digest. */
  readonly sha256: string;
}

export interface RuntimeAssetManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly abiVersion: number;
  readonly assets: Readonly<Record<string, RuntimeAssetDescriptor>>;
}

export interface JsDelivrRuntimeAssetSource {
  readonly kind: 'jsdelivr';
  readonly packageName: string;
  /** An exact SemVer version. Tags and ranges are intentionally rejected. */
  readonly packageVersion: string;
}

export interface JsDelivrGitHubRuntimeAssetSource {
  readonly kind: 'jsdelivr-github';
  readonly repository: string;
  /** An exact Release Please tag such as `v1.2.3`. */
  readonly tag: string;
  readonly basePath: string;
}

export interface SelfHostedRuntimeAssetSource {
  readonly kind: 'self-hosted';
  readonly baseUrl: string;
}

export type RuntimeAssetSource =
  | JsDelivrRuntimeAssetSource
  | JsDelivrGitHubRuntimeAssetSource
  | SelfHostedRuntimeAssetSource;

export interface RuntimeAssetLoadState {
  readonly assetName: string;
  readonly phase: RuntimeAssetLoadingPhase;
  readonly loadedBytes: number;
  /** Present only when the response supplied a valid Content-Length header. */
  readonly totalBytes: number | null;
  readonly error: RuntimeAssetError | null;
}

export type RuntimeAssetStateListener = (
  state: RuntimeAssetLoadState,
) => void;

export type RuntimeAssetFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface RuntimeAssetProviderOptions {
  readonly manifest: RuntimeAssetManifest;
  /** Required so the package never silently chooses a third-party CDN. */
  readonly source: RuntimeAssetSource;
  /** Tried in order only after the primary source fails verification or load. */
  readonly fallbackSources?: readonly RuntimeAssetSource[];
  readonly expectedAbiVersion: number;
  readonly fetch?: RuntimeAssetFetch;
}

export interface RuntimeAssetProvider {
  readonly abiVersion: number;
  resolveUrl(assetName: string): string;
  resolveUrls(assetName: string): readonly string[];
  getState(assetName: string): RuntimeAssetLoadState;
  subscribe(listener: RuntimeAssetStateListener): () => void;
  /**
   * Returns a caller-owned copy only after byte-size and SHA-256 verification.
   * Concurrent callers share the underlying download, not the mutable result.
   */
  load(assetName: string, signal?: AbortSignal): Promise<Uint8Array>;
}

interface RuntimeAssetLoadEntry {
  readonly controller: AbortController;
  readonly promise: Promise<Uint8Array>;
  settled: boolean;
  subscribers: number;
}

const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NPM_PACKAGE_NAME =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const GITHUB_REPOSITORY =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;

export function createJsDelivrRuntimeAssetSource(
  packageName: string,
  packageVersion: string,
): JsDelivrRuntimeAssetSource {
  if (!NPM_PACKAGE_NAME.test(packageName)) {
    throw configurationError(`Invalid npm package name: ${packageName}`);
  }
  if (!EXACT_SEMVER.test(packageVersion)) {
    throw configurationError(
      `jsDelivr requires an exact package version, received: ${packageVersion}`,
    );
  }
  return Object.freeze({ kind: 'jsdelivr', packageName, packageVersion });
}

export function createJsDelivrGitHubRuntimeAssetSource(
  repository: string,
  tag: string,
  basePath: string,
): JsDelivrGitHubRuntimeAssetSource {
  if (!GITHUB_REPOSITORY.test(repository)) {
    throw configurationError(`Invalid GitHub repository: ${repository}`);
  }
  if (!tag.startsWith('v') || !EXACT_SEMVER.test(tag.slice(1))) {
    throw configurationError(
      `jsDelivr GitHub assets require an exact v<SemVer> tag, received: ${tag}`,
    );
  }
  encodeAssetPath(basePath);
  return Object.freeze({
    basePath,
    kind: 'jsdelivr-github',
    repository,
    tag,
  });
}

export function createSelfHostedRuntimeAssetSource(
  baseUrl: string,
): SelfHostedRuntimeAssetSource {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  if (
    normalizedBaseUrl.length === 0 ||
    normalizedBaseUrl.includes('?') ||
    normalizedBaseUrl.includes('#')
  ) {
    throw configurationError(
      `Self-hosted asset base URL must be a non-empty URL without a query or fragment: ${baseUrl}`,
    );
  }
  return Object.freeze({ kind: 'self-hosted', baseUrl: normalizedBaseUrl });
}

export function createRuntimeAssetProvider(
  options: RuntimeAssetProviderOptions,
): RuntimeAssetProvider {
  if (options.source === undefined) {
    throw configurationError(
      'A runtime asset source must be selected explicitly.',
    );
  }
  assertPositiveInteger('expected ABI version', options.expectedAbiVersion);
  if (options.manifest.schemaVersion !== 1) {
    throw configurationError(
      `Unsupported runtime asset manifest schema version: ${String(options.manifest.schemaVersion)}`,
    );
  }
  assertPositiveInteger('manifest ABI version', options.manifest.abiVersion);
  if (!EXACT_SEMVER.test(options.manifest.version)) {
    throw configurationError(
      `Runtime asset manifest requires an exact version, received: ${options.manifest.version}`,
    );
  }
  if (options.manifest.abiVersion !== options.expectedAbiVersion) {
    throw new RuntimeAssetError(
      'ABI_MISMATCH',
      `Runtime asset ABI mismatch: expected ${options.expectedAbiVersion}, received ${options.manifest.abiVersion}.`,
    );
  }

  const descriptors = validateManifestAssets(options.manifest.assets);
  const fetchAsset = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sources = [options.source, ...(options.fallbackSources ?? [])].map(
    validateRuntimeAssetSource,
  );
  for (const source of sources) {
    if (
      source.kind === 'jsdelivr' &&
      source.packageVersion !== options.manifest.version
    ) {
      throw configurationError(
        `jsDelivr package version ${source.packageVersion} does not match manifest version ${options.manifest.version}.`,
      );
    }
    if (
      source.kind === 'jsdelivr-github' &&
      source.tag !== `v${options.manifest.version}`
    ) {
      throw configurationError(
        `jsDelivr GitHub tag ${source.tag} does not match manifest version ${options.manifest.version}.`,
      );
    }
  }
  const states = new Map<string, RuntimeAssetLoadState>();
  const loads = new Map<string, RuntimeAssetLoadEntry>();
  const listeners = new Set<RuntimeAssetStateListener>();

  const descriptorFor = (assetName: string): RuntimeAssetDescriptor => {
    const descriptor = descriptors.get(assetName);
    if (descriptor === undefined) {
      throw new RuntimeAssetError(
        'ASSET_NOT_FOUND',
        `Runtime asset is not present in the manifest: ${assetName}`,
      );
    }
    return descriptor;
  };

  const publish = (state: RuntimeAssetLoadState): void => {
    const immutableState = Object.freeze(state);
    states.set(state.assetName, immutableState);
    for (const listener of listeners) {
      try {
        listener(immutableState);
      } catch {
        // Observers cannot interrupt an asset download or integrity check.
      }
    }
  };

  const load = (
    assetName: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> => {
    const descriptor = descriptorFor(assetName);
    if (signal?.aborted) {
      return Promise.reject(runtimeAssetAbortedError(signal));
    }
    let entry = loads.get(assetName);
    if (entry === undefined) {
      const controller = new AbortController();
      let resolve!: (bytes: Uint8Array) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<Uint8Array>(
        (promiseResolve, promiseReject) => {
          resolve = promiseResolve;
          reject = promiseReject;
        },
      );
      entry = { controller, promise, settled: false, subscribers: 0 };
      loads.set(assetName, entry);
      const activeEntry = entry;
      const urls = sources.map((source) =>
        resolveValidatedRuntimeAssetUrl(source, descriptor.path),
      );
      void (async (): Promise<void> => {
        try {
          resolve(await downloadAndVerifyAssetWithFallback({
            assetName,
            descriptor,
            fetchAsset,
            publish,
            signal: controller.signal,
            urls,
          }));
        } catch (error: unknown) {
          const activeEntryStillCurrent = loads.get(assetName) === activeEntry;
          if (activeEntryStillCurrent) {
            loads.delete(assetName);
          }
          if (controller.signal.aborted) {
            // An immediate retry may already own state for this asset. Never
            // let completion of the abandoned request overwrite its progress.
            if (!loads.has(assetName)) {
              publish({
                assetName,
                phase: 'idle',
                loadedBytes: 0,
                totalBytes: null,
                error: null,
              });
            }
            reject(runtimeAssetAbortedError(controller.signal));
          } else {
            const assetError = normalizeAssetError(assetName, error);
            const previous = states.get(assetName)!;
            publish({
              assetName,
              phase: 'error',
              loadedBytes: previous.loadedBytes,
              totalBytes: previous.totalBytes,
              error: assetError,
            });
            reject(assetError);
          }
        } finally {
          activeEntry.settled = true;
        }
      })();
      // If every subscriber cancels, the shared rejection still remains
      // observed while a non-cooperative custom fetch eventually settles.
      void promise.catch(() => undefined);
    }
    const activeEntry = entry;
    return subscribeToRuntimeAssetLoad(activeEntry, signal, () => {
      if (
        loads.get(assetName) !== activeEntry ||
        activeEntry.settled ||
        activeEntry.subscribers !== 0
      ) {
        return;
      }
      loads.delete(assetName);
      activeEntry.controller.abort(signal?.reason);
    }).then((bytes) => bytes.slice());
  };

  return Object.freeze({
    abiVersion: options.manifest.abiVersion,
    resolveUrl(assetName: string): string {
      return resolveValidatedRuntimeAssetUrl(
        sources[0]!,
        descriptorFor(assetName).path,
      );
    },
    resolveUrls(assetName: string): readonly string[] {
      const path = descriptorFor(assetName).path;
      return Object.freeze(
        sources.map((source) => resolveValidatedRuntimeAssetUrl(source, path)),
      );
    },
    getState(assetName: string): RuntimeAssetLoadState {
      descriptorFor(assetName);
      return (
        states.get(assetName) ??
        Object.freeze({
          assetName,
          phase: 'idle',
          loadedBytes: 0,
          totalBytes: null,
          error: null,
        })
      );
    },
    subscribe(listener: RuntimeAssetStateListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
  });
}

export function resolveRuntimeAssetUrl(
  source: RuntimeAssetSource,
  assetPath: string,
): string {
  return resolveValidatedRuntimeAssetUrl(
    validateRuntimeAssetSource(source),
    assetPath,
  );
}

function resolveValidatedRuntimeAssetUrl(
  source: RuntimeAssetSource,
  assetPath: string,
): string {
  const encodedPath = encodeAssetPath(assetPath);
  switch (source.kind) {
    case 'jsdelivr':
      return `https://cdn.jsdelivr.net/npm/${source.packageName}@${source.packageVersion}/${encodedPath}`;
    case 'jsdelivr-github':
      return `https://cdn.jsdelivr.net/gh/${source.repository}@${source.tag}/${encodeAssetPath(source.basePath)}/${encodedPath}`;
    case 'self-hosted':
      return `${source.baseUrl}/${encodedPath}`;
  }
}

interface DownloadAndVerifyAssetOptions {
  readonly assetName: string;
  readonly descriptor: RuntimeAssetDescriptor;
  readonly fetchAsset: RuntimeAssetFetch;
  readonly publish: (state: RuntimeAssetLoadState) => void;
  readonly signal: AbortSignal;
  readonly url: string;
}

interface DownloadAndVerifyAssetWithFallbackOptions
  extends Omit<DownloadAndVerifyAssetOptions, 'url'> {
  readonly urls: readonly string[];
}

async function downloadAndVerifyAssetWithFallback({
  urls,
  ...options
}: DownloadAndVerifyAssetWithFallbackOptions): Promise<Uint8Array> {
  let lastError: RuntimeAssetError | undefined;
  for (const url of urls) {
    throwIfRuntimeAssetLoadAborted(options.signal);
    try {
      return await downloadAndVerifyAsset({ ...options, url });
    } catch (error) {
      throwIfRuntimeAssetLoadAborted(options.signal);
      lastError = normalizeAssetError(options.assetName, error);
    }
  }
  if (urls.length === 1) {
    throw lastError!;
  }
  throw new RuntimeAssetError(
    'DOWNLOAD_FAILED',
    `Failed to load runtime asset ${options.assetName} from all ${urls.length} configured sources. Last error: ${lastError!.message}`,
  );
}

async function downloadAndVerifyAsset({
  assetName,
  descriptor,
  fetchAsset,
  publish,
  signal,
  url,
}: DownloadAndVerifyAssetOptions): Promise<Uint8Array> {
  publish({
    assetName,
    phase: 'downloading',
    loadedBytes: 0,
    totalBytes: null,
    error: null,
  });

  const response = await raceWithRuntimeAssetAbort(
    Promise.resolve().then(() => fetchAsset(url, { signal })),
    signal,
  );
  if (!response.ok) {
    throw new RuntimeAssetError(
      'HTTP_ERROR',
      `Failed to download runtime asset ${assetName}: HTTP ${response.status} ${response.statusText}.`,
    );
  }

  const contentLength = parseContentLength(
    assetName,
    response.headers.get('content-length'),
  );
  // Content-Length can describe the compressed transfer size while Fetch
  // exposes decoded bytes. Treat it as progress only when both byte domains
  // agree; the decoded body is still size-checked below in every case.
  const progressTotal =
    contentLength === descriptor.bytes ? contentLength : null;

  publish({
    assetName,
    phase: 'downloading',
    loadedBytes: 0,
    totalBytes: progressTotal,
    error: null,
  });
  const bytes = await readResponseBytes(
    response,
    assetName,
    descriptor.bytes,
    (loadedBytes) => {
      publish({
        assetName,
        phase: 'downloading',
        loadedBytes,
        totalBytes: progressTotal,
        error: null,
      });
    },
    signal,
  );

  if (bytes.byteLength !== descriptor.bytes) {
    throw sizeMismatchError(
      assetName,
      descriptor.bytes,
      bytes.byteLength,
    );
  }

  publish({
    assetName,
    phase: 'verifying',
    loadedBytes: bytes.byteLength,
    totalBytes: progressTotal,
    error: null,
  });
  const digest = await raceWithRuntimeAssetAbort(sha256Hex(bytes), signal);
  if (digest !== descriptor.sha256.toLowerCase()) {
    throw new RuntimeAssetError(
      'INTEGRITY_MISMATCH',
      `Runtime asset ${assetName} failed SHA-256 verification: expected ${descriptor.sha256.toLowerCase()}, received ${digest}.`,
    );
  }

  publish({
    assetName,
    phase: 'ready',
    loadedBytes: bytes.byteLength,
    totalBytes: progressTotal,
    error: null,
  });
  return bytes;
}

async function readResponseBytes(
  response: Response,
  assetName: string,
  maximumBytes: number,
  onProgress: (loadedBytes: number) => void,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) {
    const bytes = new Uint8Array(
      await raceWithRuntimeAssetAbort(response.arrayBuffer(), signal),
    );
    onProgress(bytes.byteLength);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  try {
    for (;;) {
      const result = await raceWithRuntimeAssetAbort(
        reader.read(),
        signal,
        () => {
          cancelReaderWithoutWaiting(reader, signal.reason);
        },
      );
      if (result.done) {
        break;
      }
      loadedBytes += result.value.byteLength;
      if (loadedBytes > maximumBytes) {
        cancelReaderWithoutWaiting(reader);
        throw sizeMismatchError(assetName, maximumBytes, loadedBytes);
      }
      chunks.push(result.value);
      onProgress(loadedBytes);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function cancelReaderWithoutWaiting(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation is best-effort. It must never delay the authoritative
    // abort or size error, and a custom reader may throw synchronously.
  }
}

function validateManifestAssets(
  assets: RuntimeAssetManifest['assets'],
): ReadonlyMap<string, RuntimeAssetDescriptor> {
  const descriptors = new Map<string, RuntimeAssetDescriptor>();
  for (const [assetName, descriptor] of Object.entries(assets)) {
    if (assetName.length === 0) {
      throw configurationError('Runtime asset names must not be empty.');
    }
    encodeAssetPath(descriptor.path);
    assertPositiveInteger(
      `byte size for runtime asset ${assetName}`,
      descriptor.bytes,
    );
    if (!SHA256_HEX.test(descriptor.sha256)) {
      throw configurationError(
        `Runtime asset ${assetName} must declare a 64-character hexadecimal SHA-256 digest.`,
      );
    }
    descriptors.set(
      assetName,
      Object.freeze({
        path: descriptor.path,
        bytes: descriptor.bytes,
        sha256: descriptor.sha256.toLowerCase(),
      }),
    );
  }
  return descriptors;
}

function validateRuntimeAssetSource(
  source: RuntimeAssetSource,
): RuntimeAssetSource {
  switch (source.kind) {
    case 'jsdelivr':
      return createJsDelivrRuntimeAssetSource(
        source.packageName,
        source.packageVersion,
      );
    case 'jsdelivr-github':
      return createJsDelivrGitHubRuntimeAssetSource(
        source.repository,
        source.tag,
        source.basePath,
      );
    case 'self-hosted':
      return createSelfHostedRuntimeAssetSource(source.baseUrl);
  }
}

function encodeAssetPath(assetPath: string): string {
  const segments = assetPath.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === '.' || segment === '..',
    ) ||
    assetPath.includes('\\') ||
    assetPath.includes('?') ||
    assetPath.includes('#')
  ) {
    throw configurationError(
      `Runtime asset path must be a safe package-relative path: ${assetPath}`,
    );
  }
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function parseContentLength(
  assetName: string,
  header: string | null,
): number | null {
  if (header === null) {
    return null;
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RuntimeAssetError(
      'HTTP_ERROR',
      `Runtime asset ${assetName} returned an invalid Content-Length header: ${header}.`,
    );
  }
  return length;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    digestInput.buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw configurationError(`${label} must be a positive integer.`);
  }
}

function sizeMismatchError(
  assetName: string,
  expected: number,
  received: number,
): RuntimeAssetError {
  return new RuntimeAssetError(
    'SIZE_MISMATCH',
    `Runtime asset ${assetName} has the wrong byte size: expected ${expected}, received ${received}.`,
  );
}

function normalizeAssetError(
  assetName: string,
  error: unknown,
): RuntimeAssetError {
  if (error instanceof RuntimeAssetError) {
    return error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new RuntimeAssetError(
    'DOWNLOAD_FAILED',
    `Failed to load runtime asset ${assetName}: ${reason}`,
  );
}

function subscribeToRuntimeAssetLoad(
  entry: RuntimeAssetLoadEntry,
  signal: AbortSignal | undefined,
  onEmpty: () => void,
): Promise<Uint8Array> {
  entry.subscribers += 1;
  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    const finish = (
      settle: (value: Uint8Array) => void,
      value: Uint8Array,
    ): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      entry.subscribers -= 1;
      settle(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      entry.subscribers -= 1;
      reject(error);
    };
    const abort = (): void => {
      fail(runtimeAssetAbortedError(signal!));
      onEmpty();
    };
    signal?.addEventListener('abort', abort, { once: true });
    entry.promise.then(
      (bytes) => finish(resolve, bytes),
      (error: unknown) => fail(error),
    );
  });
}

function raceWithRuntimeAssetAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (signal.aborted) {
    onAbort?.();
    void operation.catch(() => undefined);
    return Promise.reject(runtimeAssetAbortedError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const abort = (): void => {
      cleanup();
      onAbort?.();
      reject(runtimeAssetAbortedError(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function throwIfRuntimeAssetLoadAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw runtimeAssetAbortedError(signal);
  }
}

function runtimeAssetAbortedError(signal: AbortSignal): RuntimeAssetError {
  const reason = signal.reason;
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'Runtime asset load was aborted.';
  return new RuntimeAssetError('LOAD_ABORTED', message);
}

function configurationError(message: string): RuntimeAssetError {
  return new RuntimeAssetError('INVALID_CONFIGURATION', message);
}
