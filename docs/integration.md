# Browser integration

`@echovisionlab/audio-transcoder` performs audio work in the browser. A module Web Worker
keeps codec work off the UI thread; it is not a server backend. Local `Blob` and
`File` inputs are never uploaded. An explicit HTTP input may fetch bounded byte
ranges from a consumer-owned endpoint; the package does not resolve media or
provide a proxy. No ffmpeg installation is required. It is licensed for
noncommercial use under
[PolyForm Noncommercial 1.0.0](../LICENSE.md).

Start with the complete [Quick Start](../README.md#quick-start). The sections
below cover production ownership and framework-specific lifecycle differences
without repeating that conversion flow.

The production streaming architecture has four ownership layers:

1. The page or component owns one Worker pool.
2. The pool bounds active and waiting jobs.
3. Each scheduled job probes one concrete input, then creates one temporary
   output destination.
4. The page explicitly disposes result artifacts, the pool, and the output
   session.

## Recommended owner

Create the pool and output session at the tool route or component boundary, not
at application startup:

```ts
import {
  AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
  createAudioTranscoderOutputSession,
  createAudioTranscoderStreamWorkerPool,
  createSelfHostedRuntimeAssetSource,
} from '@echovisionlab/audio-transcoder';

export function createAudioToolRuntime() {
  const pool = createAudioTranscoderStreamWorkerPool({
    codecAssets: {
      source: createSelfHostedRuntimeAssetSource(
        `/audio-transcoder-codecs/${AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version}`,
      ),
      onStateChange: ({ assetName, phase, loadedBytes, totalBytes }) => {
        console.log({ assetName, phase, loadedBytes, totalBytes });
      },
    },
    concurrency: 1,
    idleTimeoutMs: 30_000,
    maxQueued: 8,
  });
  const outputSession = createAudioTranscoderOutputSession({
    memoryLimitBytes: 128 * 1024 * 1024,
    namespace: 'audio-transcoder',
  });

  let disposal: Promise<void> | undefined;

  function dispose(): Promise<void> {
    window.removeEventListener('pagehide', handlePageHide);
    disposal ??= (async () => {
      // Abort row-level controllers before calling this method.
      await pool.dispose();
      await outputSession.dispose();
    })();
    return disposal;
  }

  function handlePageHide(event: PageTransitionEvent): void {
    if (!event.persisted) void dispose().catch(() => undefined);
  }

  window.addEventListener('pagehide', handlePageHide);

  return {
    dispose,
    outputSession,
    pool,
  };
}

const runtime = createAudioToolRuntime();
```

The order matters. `pool.dispose()` waits for active output streams to abort and
release writer locks; only then should `outputSession.dispose()` remove OPFS
entries. Both methods are idempotent. `terminate()` remains available on a
stream Worker or pool as fire-and-forget compatibility, but it is not a
completion barrier.

## Remote input ownership

The application may pass `{ http: { url, size } }` instead of `{ blob }` to
`probeInputSupport()`, `inspect()`, and `transcode()`. This descriptor is plain
data and is posted to the module Worker. The Worker issues bounded `GET`
requests with its own `Range` header; partial responses must be exact `206`
responses with `Content-Range`. Optional `credentials` defaults to
`same-origin`, and optional headers must contain only serializable string
values.

Keep acquisition and authorization outside this package. A production media
integration should resolve the upstream source on the server, bind an opaque
short-lived ticket to the signed-in user, and expose only an authenticated
range endpoint. Never accept an arbitrary client-provided upstream URL in that
endpoint. If the range source is cross-origin, configure CORS for the Worker
origin and `Range`; a same-origin endpoint avoids that additional boundary.

## Codec asset source and loading state

The default stream runtime has no implicit asset source. The owner must provide
`codecAssets.source` even when its first operation uses eager WAV or AIFF. No
asset is fetched until an exact probe or conversion needs AAC, Ogg Opus, MP3,
FLAC, or a resampler quality.

For self-hosting, copy the release tag's stable `codec-assets/wasm/` files
beneath a versioned base URL and configure that base explicitly, as in the
owner example above. For jsDelivr, the application must opt in:

```ts
import {
  createAudioTranscoderJsDelivrAssetSource,
  createAudioTranscoderStreamWorkerPool,
  createSelfHostedRuntimeAssetSource,
} from '@echovisionlab/audio-transcoder';

const pool = createAudioTranscoderStreamWorkerPool({
  codecAssets: {
    source: createAudioTranscoderJsDelivrAssetSource(),
    fallbackSources: [
      createSelfHostedRuntimeAssetSource(
        'https://assets.example.com/audio-transcoder/1.2.3',
      ),
    ],
    onStateChange(state) {
      console.log(state);
    },
  },
});
```

The primary is attempted first; fallbacks are attempted one at a time in array
order after load or verification failure. They are not raced. `1.2.3` above is
an illustrative exact version and must equal the installed engine version in a
real deployment. For that version the jsDelivr helper resolves stable URLs such
as
`https://cdn.jsdelivr.net/gh/echovisionlab/audio-transcoder@v1.2.3/codec-assets/wasm/flac.wasm`.
It rejects branches and ranges and never resolves `latest`. This is a contract
example, not an availability claim for an illustrative version. A released
version's corresponding source and relink material is the public repository
tag `v<package-version>`; codec assets are not published as a separate npm
package.

The engine bakes the matching schema-version-1 manifest, package version, ABI,
stable path, decoded byte count, and SHA-256 for every raw asset. Provider
creation rejects a schema or ABI mismatch, and a jsDelivr source whose exact
version differs from the manifest; every fetched response is size- and
SHA-256-verified before compilation. A failed source does not weaken
verification for its fallback.

The state model starts at `idle`. Once a load starts, `onStateChange` receives
one asset's `downloading`, `verifying`, `ready`, or final `error` transitions on
the main thread. Use it for an explicit “audio transcoder engine is loading”
UI. `loadedBytes` counts decoded response bytes. When HTTP gzip or Brotli makes
`Content-Length` describe compressed transfer bytes, `totalBytes` is
deliberately `null`; show an indeterminate progress indicator instead of mixing
transfer and integrity byte domains.

## Capability-driven controls

### Input

`pool.getCapabilities()` is synchronous because it returns an immutable local
manifest. `inputFormats` lists installed recognition paths plus extension and
MIME hints for picker UI. It does not establish that a selected file is
decodable. In particular, entries with `path: 'runtime-probed'` depend on the
container codec and current browser runtime. See the compact
[input candidate table](../README.md#input-discovery-and-probing); every concrete
file still requires `probeInputSupport()`.

Probe every file asynchronously before enabling conversion, as shown in the
Quick Start. Treat `recognized-unsupported` as a recognized container whose
codec cannot be decoded in this runtime, and `unsupported` as unrecognized.

`probeInputSupport()` reads enough metadata to identify the source and asks the
installed decoder path whether it can decode that codec. Runtime decoders
validate at most the first decoded sample within the configured
`inputReadBytes` read budget. If the budget is exhausted before that verdict,
the Promise rejects with
`AudioTranscoderError.code === 'RESOURCE_LIMIT_EXCEEDED'`. Do not translate
that rejection to `recognized-unsupported` or `unsupported`; increase the
budget within its documented limit or report that the probe was inconclusive.
Treat filename extensions, MIME values, and `inputFormats` as picker/parser
hints only, including entries marked `built-in-pcm`.

Do not use a browser brand, user-agent string, `hardwareConcurrency`, or
`deviceMemory` to claim that a concrete input codec is supported. Only
`probeInputSupport()` can make that decision for the selected file in the
current runtime.

Read `inspection.sourceEncoding` for machine-readable source identity. PCM
metadata distinguishes integer from float data and includes bit depth,
signedness, and endianness. Do not parse `inspection.codec`; it remains a
human-readable compatibility field. Third-party inspectors compiled against an
older package may omit `sourceEncoding`, so treat absence as `unknown`.

### Output

The installed output manifest is deterministic, but runtime availability is
not. The manifest exposes built-in eager WAV PCM16/24/32 and float32 presets,
built-in eager AIFF PCM16/24 presets, lazy external raw-WASM AAC-LC
96/128/192/256-kbps and Ogg Opus 64/96/128/192-kbps presets, lazy external
raw-WASM MP3 128/192/256/320-kbps presets, and lazy external raw-WASM FLAC
16/24-bit presets.
The exact preset IDs, codec constraints, implementation, loading mode,
extension, MIME type, and seekable-output requirement are under
`outputFormats`.

Build controls from the package's semantic parameter resolver instead of
maintaining a second support list. Labels, localization, and layout remain the
consumer's responsibility:

```ts
import {
  getAudioStreamOutputParameters,
  getAudioStreamOutputSampleRateOptions,
  resolveAudioStreamSourceAwareFormatTarget,
} from '@echovisionlab/audio-transcoder';

const fields = getAudioStreamOutputParameters('wav');
// sample-format: integer | float
// bit-depth: 16 | 24 | 32, filtered by the other current selections

const sampleRates = getAudioStreamOutputSampleRateOptions(
  { formatId: 'wav', presetId: 'wav-pcm24' },
  inspection,
);
if (sampleRates.status === 'unsupported') {
  renderInvalidTarget(sampleRates.reason, sampleRates.message);
} else {
  renderSampleRates(sampleRates.options);
}

const resolved = resolveAudioStreamSourceAwareFormatTarget(
  {
    formatId: 'wav',
    parameters: { bitDepth: 24, sampleFormat: 'integer' },
    sampleRate: 'automatic',
  },
  inspection,
);

if (resolved.status === 'unsupported') {
  renderInvalidTarget(resolved.reason, resolved.message);
} else {
  await runtime.pool.probeOutputSupport(resolved.probeTarget, { signal });
}
```

The source-aware resolver always preserves the inspected source channel count
and validates it before selecting a rate; it never downmixes. `automatic`
first preserves a source rate accepted by the preset and pass-through path. If
that is impossible for a discrete preset, it chooses among only the preset's
exact rates that are valid for the global resampling path, minimizing absolute
Hz distance and choosing the higher rate on a tie. A range preset preserves the
source when valid and does not invent fallback candidates. The existing
`resolveAudioStreamFormatTarget()` and its `'source' | number` sample-rate
selection remain available for exact source-preserving or explicit behavior.

`getAudioStreamOutputSampleRateOptions()` returns an immutable discriminated
result for one exact format, preset, and source. An unsupported result reports
`format`, `preset`, `source-inspection`, or `channels`; no rate is advertised
until the source-owned channel layout has been validated. A resolved result's
`options` contain immutable entries whose `path` is `pass-through` or
`resampling`. Unsupported entries report a machine-readable reason such as
`preset-sample-rate`,
`resampling-source-sample-rate`, or `resampling-target-sample-rate`. For range
presets its default list contains only the source rate; pass exact
`candidateSampleRates` in the selection object to evaluate application-owned
choices. The package supplies no labels, translations, or UI policy.

Formats with lossy presets expose `bitrate-bps`/`bitrateBps`; their public
capability descriptors also expose `bitrateMode`. AAC and Ogg Opus are
`variable`, while MP3 is `constant`. Container, extension, MIME type, and
lossless processing precision remain owned by their existing format and preset
descriptors rather than being copied into semantic encoding options.

The manifest's `loading: 'lazy'` is static metadata, not an aggregate runtime
state. Render `checking` before awaiting `probeOutputSupport()` and `preparing`
before calling `transcode()`. This covers module Worker startup, the selected
dynamic import, WASM compilation, and codec initialization even before the
first progress callback. Do not call a global warm-up routine or probe every
format on page load: it would download every optional codec.

The lower-level manifest remains available when a consumer needs every exact
preset or custom presentation:

```ts
import type { AudioStreamOutputPresetId } from '@echovisionlab/audio-transcoder';

const outputOptions = runtime.pool
  .getCapabilities()
  .outputFormats.flatMap((format) =>
    format.presets.map((descriptor) => ({
      channels: descriptor.target.channels,
      effectiveIntegerPrecisionBits:
        descriptor.kind === 'lossless'
          ? descriptor.processingPrecision.effectiveIntegerPrecisionBits
          : null,
      format: format.id,
      implementation: format.implementation,
      loading: format.loading,
      mimeType: format.mimeType,
      presetId: descriptor.preset.id as AudioStreamOutputPresetId,
      sampleRate: descriptor.target.sampleRate,
    })),
  );

type Availability =
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'unavailable'; reason: string }
  | { state: 'error'; reason: string };

function supportsTarget(
  option: (typeof outputOptions)[number],
  channels: number,
  sampleRate: number,
): boolean {
  const rate = option.sampleRate;
  return (
    channels >= option.channels.minimum &&
    channels <= option.channels.maximum &&
    (rate.kind === 'range'
      ? sampleRate >= rate.minimum && sampleRate <= rate.maximum
      : rate.values.some((value) => value === sampleRate))
  );
}

async function probeOutputOption(
  option: (typeof outputOptions)[number],
  channels: number,
  sampleRate: number,
  signal: AbortSignal,
  render: (availability: Availability) => void,
): Promise<void> {
  if (!supportsTarget(option, channels, sampleRate)) {
    render({ state: 'unavailable', reason: 'Unsupported target settings' });
    return;
  }

  render({ state: 'checking' });
  try {
    const result = await runtime.pool.probeOutputSupport(
      { presetId: option.presetId, channels, sampleRate },
      { signal },
    );
    render(
      result.status === 'supported'
        ? { state: 'available' }
        : { state: 'unavailable', reason: result.message },
    );
  } catch (error) {
    if (signal.aborted) return;
    render({
      state: 'error',
      reason: error instanceof Error ? error.message : 'Output probe failed',
    });
  }
}
```

Static constraints are available synchronously and should immediately disable
invalid channel/rate combinations. Runtime probing is asynchronous: reset the
state when any target field changes, render `checking`, and disable conversion
until that exact `{ presetId, channels, sampleRate }` resolves to `supported`.
Both `unsupported-configuration` and `runtime-unavailable` are unavailable UI
states. A rejected Promise is a distinct retryable error state; never use it to
permanently gray the option.

`probeOutputSupport()` performs a tiny bounded discard-only encode. It does not
read an input, create OPFS state or an artifact, or invoke the resampler. Static
mismatches return before a lazy codec is loaded. Identical requests coalesce;
one probe runs at a time, at most eight unique targets wait, and 32 successful
exact targets are cached. Unsupported results and rejected probes are not
cached, so error UI can retry them. Independent callers may cancel without
stopping shared work until the last subscriber leaves.

Do not use browser or device heuristics to replace this probe. Probe concrete
files with `probeInputSupport()` and exact output targets with
`probeOutputSupport()`. `hardwareConcurrency` and `deviceMemory` may only help
tune queue or concurrency settings after measurement on representative files;
the default and recommended concurrency remains `1`.

Neither probe adds a wall-clock deadline. Compose the route or row lifecycle
`AbortSignal` with an application deadline so a stalled browser codec API
becomes a retryable error state. Keep explicit unsupported results separate from
deadline, cancellation, Worker, and resource-limit rejections.

Probe the selected exact target first. If controls must be preflighted, probe
their offered exact targets sequentially and apply each verdict only to that
target. Probing AAC, Ogg Opus, MP3, or FLAC intentionally downloads that
format's raw codec asset; defer those probes until interaction for a smaller
initial transfer. Never launch all output probes concurrently.

WAV and AIFF accept 1-32 channels and 8,000-384,000 Hz. AAC-LC accepts 1-2
channels at exactly 32,000, 44,100, or 48,000 Hz. Ogg Opus accepts 1-2 channels
at its 48,000 Hz codec clock. Automatic selection converts another supported
source rate to 48,000 Hz, but rejects sources outside the global resampling
range. MP3 accepts 1-2 channels: `mp3-128kbps` accepts
exactly 16,000, 22,050, 24,000, 32,000, 44,100, and 48,000 Hz;
`mp3-192kbps`, `mp3-256kbps`, and `mp3-320kbps` accept exactly 32,000, 44,100,
and 48,000 Hz. Lower-rate combinations are excluded because LAME can silently
downgrade the encoded bitrate instead of honoring the requested preset. FLAC
accepts 1-8 channels and the descriptor's eleven discrete rates from 8,000
through 192,000 Hz. Read concrete discrete arrays from
`descriptor.target.sampleRate.values`; do not infer values from only their
minimum and maximum.

If `target.sampleRate` differs from the source rate, the global resampler limit
also applies. Read `capabilities.limits.sampleRate.resampling` for conversion
and `capabilities.limits.sampleRate.passThrough` for same-rate output. The
default manifest exposes 8,000-192,000 Hz for resampling and 8,000-384,000 Hz
for pass-through.

All processing between decode and encode uses Float32 PCM. Consequently,
`wav-pcm32` is a 32-bit signed-integer container but retains at most 24 bits of
integer precision. The manifest reports this explicitly through
`processingPrecision.effectiveIntegerPrecisionBits`.

## Scheduling multiple files

Use `schedule()` for a batch and create the output only after a Worker slot is
available:

```ts
async function transcodeOne(
  file: File,
  signal: AbortSignal,
) {
  return runtime.pool.schedule(
    async (engine) => {
      const input = { blob: file, name: file.name };
      const support = await engine.probeInputSupport(input, { signal });
      if (support.status !== 'supported') {
        throw new Error(`Input support: ${support.status}`);
      }

      const pending = await runtime.outputSession.create();
      try {
        const result = await engine.transcode(
          input,
          { presetId: 'mp3-192kbps', sampleRate: 48_000 },
          pending.stream,
          {
            ...(pending.maxOutputBytes === undefined
              ? {}
              : { maxOutputBytes: pending.maxOutputBytes }),
            signal,
            onProgress: ({ phase, progress }) => {
              console.log(phase, progress);
            },
          },
        );

        return await pending.complete({
          mimeType: result.preset.mimeType,
          name: replaceExtension(file.name, result.preset.extension),
        });
      } catch (error) {
        return cleanupAndRethrowPrimary(
          () => pending.discard(),
          error,
        );
      }
    },
    { signal },
  );
}

async function cleanupAndRethrowPrimary(
  cleanup: () => Promise<void>,
  primaryError: unknown,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    try {
      console.error(
        'Output cleanup failed; output-session disposal will retry it.',
        { cleanupError, primaryError },
      );
    } catch {
      // Reporting must not replace the primary conversion or quota error.
    }
  }
  throw primaryError;
}

function replaceExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${extension}`;
}
```

The helper keeps the conversion or quota error primary. A failed
`pending.discard()` remains observable in the local console, while the pending
resource stays tracked so `runtime.outputSession.dispose()` can retry removal.

Pass the same `AbortSignal` to `schedule()`, `probeInputSupport()`, and
`transcode()`. The pool is FIFO, creates Workers lazily, and releases idle
Workers after 30 seconds by default.

A running `OPERATION_ABORTED` rejection retires the affected pool Worker before
the slot is reused. A `schedule()` callback must discard its owned output and
rethrow that error. Standalone Worker-engine consumers must instead await
`dispose()`, create a replacement, and only then retry.

A waiting `schedule()` callback retains references it captures, including its
source `File` or `Blob`, but the example does not open output storage or read the
file into an `ArrayBuffer` until a slot is active. Direct `pool.transcode()`
accepts a destination before admission; the pool aborts that destination if the
job is rejected, cancelled while queued, disposed, or fails during Worker
startup. Prefer `schedule()` for batches so storage ownership begins with active
work.

`concurrency` defaults to `1` and must be from `1` through `4`. `maxQueued`
defaults to `8` and must be from `0` through `64`; active operations are not
counted. A full queue rejects immediately with
`AudioTranscoderError.code === 'QUEUE_CAPACITY_EXCEEDED'`. Use
`pool.getQueueSnapshot()` for UI state and apply retry policy in the consuming
application.

Keep `concurrency: 1` for unknown devices, mobile, long files, and raw-WASM
output. This is also the manifest's `recommendedConcurrency`. Each active slot
can own a browser decoder, one module Worker, and one or more WASM heaps. Raise
concurrency only after measuring representative files on target devices; never
derive codec support or an automatic pool size from device hints alone.

## Output storage lifecycle

`createAudioTranscoderOutputSession()` returns an application-owned temporary
storage boundary:

- `session.create()` returns a tracked `pending` destination and derives a
  memory fallback capacity from the session's current remaining budget.
- Pass `pending.stream` directly to `transcode()`.
- If `pending.maxOutputBytes` is present, pass it to `transcode()` in the same
  operation options.
- After successful stream closure, `pending.complete({ name, mimeType })`
  returns an artifact containing a `Blob` or `File` snapshot.
- On failure or cancellation, `await pending.discard()` aborts and removes the
  incomplete destination.
- `await artifact.dispose()` removes its backing storage or releases its memory
  reservation. Treat `artifact.blob` as unusable as soon as disposal starts.
- `await session.dispose()` settles every pending output and artifact and then
  removes the session directory.

An OPFS-backed `artifact.blob` is guaranteed readable only until
`artifact.dispose()` starts because disposal removes its backing file. The API
makes no post-disposal readability guarantee for memory-backed artifacts
either. `URL.createObjectURL(artifact.blob)` adds no application-level copy, but
the memory fallback's `complete()` materializes a Blob and reserves output-sized
copy headroom. Revoke each object URL before awaiting artifact disposal. Failed
cleanup remains session-tracked and is retried by `session.dispose()`.

The session prefers the
[origin private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system).
OPFS is origin-private persistent storage; closing a tab does not guarantee its
contents disappear. If OPFS cannot be opened, the session uses paged memory.
`memoryLimitBytes` is a hard aggregate reservation shared by pending and
completed memory outputs; Blob completion also reserves output-sized copy
headroom. The default is 128 MiB. This package does not request persistent
storage through `navigator.storage.persist()`.

`pending.maxOutputBytes` is derived after the actual destination opens. It is
absent for OPFS because browser quota can change outside the session. For a
memory destination it is a stable, per-pending guarantee backed by an atomic
session-budget lease that includes page rounding and Blob copy headroom. Pass
the value to `transcode()` when present. WAV and AIFF full container sizes that
are already known to exceed it fail during preparation, and a write-time guard
covers compressed or otherwise unknown output sizes. Because a pending memory
destination owns its lease until completion or discard, create outputs only
after queue admission and settle each one promptly.

Omitting `maxMemoryArtifactBytes` reserves the largest currently safe artifact
capacity for that pending memory output. This is the correct default for a
sequential batch that retains completed artifacts for download: each new
pending output uses the budget remaining at that point.

Only simultaneous pending memory outputs should request smaller explicit
leases:

```ts
const firstPending = await runtime.outputSession.create({
  maxMemoryArtifactBytes: 24 * 1024 * 1024,
});
const secondPending = await runtime.outputSession.create({
  maxMemoryArtifactBytes: 24 * 1024 * 1024,
});
```

Each capacity also needs page-rounded source storage and Blob materialization
headroom within `memoryLimitBytes`. An unavailable request rejects before a
destination is returned. OPFS destinations ignore the option and reserve no
session memory.

For user-facing classification, require both
`error.code === 'RESOURCE_LIMIT_EXCEEDED'` and
`error.reason === 'output-storage-limit'` before showing storage-capacity
guidance. Use `error.code === 'UNSUPPORTED_OUTPUT'` with
`error.reason === 'target-size-limit'` for RIFF, AIFF, Ogg, or another target
representation limit. Both reasons survive the Worker boundary.

Known `AudioTranscoderError` instances preserve `code`, optional `reason`, and
`message`. Unknown Worker-origin `Error` values preserve `name`, `message`, and
stack when available without an invented package classification. Arbitrary
thrown values retain a diagnostic string where possible. Destination write or
close failures prefer the original local thrown value over its Worker clone.

### 0.3.0 memory lease migration

Memory fallback allocation now occurs as an atomic page-plus-Blob lease during
`session.create()`. Existing sequential code may keep `create()` without
arguments, including while completed download artifacts remain retained. Its
first pending output receives the largest safe capacity and can leave later
concurrent pending outputs with zero capacity. Concurrent code should pass a
smaller `maxMemoryArtifactBytes` per output and provision `memoryLimitBytes` for
all leases. This behavioral change should ship as `0.3.0`; do not edit
`package.json` manually because Release Please owns the version.

Each OPFS session writes a lease and cleans managed orphan directories when the
next session starts. [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
prevent one tab from deleting another tab's active session. If Web Locks are
unavailable, cleanup falls back to lease age and reclaims only managed sessions
whose heartbeat is older than seven days. Cleanup never scans outside the
configured namespace.

For an integrated transcoder, leave `disposeOnPageHide` at its default `false`.
Install one app-level
[`pagehide`](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event)
handler that starts the shared `dispose()` method, preserving the strict order
`await pool.dispose()` then `await outputSession.dispose()`. Otherwise the
session's handler could race an independently owned Worker output lock. The
session option is only a convenience when the session has no independently
owned active writers.

Browsers do not wait for the app-level handler's Promise, so it remains
best-effort crash recovery rather than a replacement for explicitly awaiting
`dispose()`. A BFCache transition has `event.persisted === true`; leave that
runtime active so it remains usable when the page is restored.

## Memory boundaries

The stream operation settings have narrow meanings:

| Setting | Default | Bounds |
| --- | ---: | ---: |
| `inputReadBytes` | 8 MiB | 64 KiB-64 MiB |
| `pcmChunkBytes` | 4 MiB | 64 KiB-64 MiB |
| `outputChunkBytes` | 4 MiB | 64 KiB-64 MiB |

These are per-read or per-yield allocation bounds, not a total working-set or
WASM limit. They exclude browser decoder state, MediaBunny caches and queues,
resampler state, the module Worker, WASM heaps, source Blobs, output storage,
and garbage awaiting browser collection. The API cannot guarantee that a
device will not run out of memory.

Do not call `file.arrayBuffer()` before scheduling a streaming job. Do not use
`navigator.hardwareConcurrency` as an automatic pool size. Release object URLs,
artifacts, input references, Workers, and sessions as soon as ownership ends.

## Bundling and CSP

The default stream Worker is a package module Worker. WAV and AIFF encoding are
part of the eager Worker payload. AAC-LC uses pinned FFmpeg, Ogg Opus uses
pinned libopusenc/libopus/libogg, MP3 uses pinned LAME, and FLAC uses pinned
libFLAC. Their small JavaScript bridges may be split into lazy Worker chunks,
but their raw `.wasm` payloads are not embedded in the engine package. The first
job or exact runtime probe fetches only its chosen asset from the explicit
source; concurrent first calls share initialization.

The package-owned libsamplerate resampler is split into independent `best`,
`balanced`, and `fast` WASM modules. The first resampling job loads only its
selected quality module; a same-rate job takes the pass-through path and loads
none. `best` contains libsamplerate's complete highest-quality sinc coefficient
table. The size optimization does not remove coefficients, narrow the
passband, reduce the supported 8-192 kHz conversion range, or lower the
32-channel limit.

The consumer bundler should preserve dynamic imports in its production Worker
output. For Vite, configure `worker.format: 'es'`; the default IIFE Worker
format may inline lazy JavaScript glue into the eager Worker. Raw WASM remains
external and is always fetched through the configured provider.

All codec and resampler WASM executes directly inside the existing module
Worker. There is no nested or Blob Worker and no embedded base64/binary payload.
The runtime does not choose a package-controlled CDN. It fetches only from the
application's primary and ordered fallback sources, and it never sends input
media to those hosts.

A strict policy for all output formats needs:

```http
Content-Security-Policy:
  script-src 'self' 'wasm-unsafe-eval';
  worker-src 'self';
  connect-src 'self' https://cdn.jsdelivr.net
```

The same-origin stream Worker uses `worker-src 'self'`; no `blob:` permission is
needed. WebAssembly output codecs require `'wasm-unsafe-eval'`. The jsDelivr
origin is needed in `connect-src` only when the application explicitly chooses
that source or fallback. A self-host-only deployment can keep
`connect-src 'self'`; allow every configured cross-origin fallback and its
final response origin. See MDN for
[`worker-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src)
and [`script-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src).

Cross-origin asset responses must allow CORS. Serve `.wasm` as
`application/wasm`; gzip or Brotli can compress transport bytes without
changing the decoded raw size and SHA-256 checked by the runtime. Versioned
self-host paths and exact jsDelivr Git-tag URLs can use immutable caching. The
asset origin learns which public codec file was requested, but receives no
input audio from this package.

If an application must own the Worker entry, create a local module:

```ts
// audio-transcoder.worker.ts
import '@echovisionlab/audio-transcoder/stream-worker';
```

Then provide it explicitly:

```ts
const pool = createAudioTranscoderStreamWorkerPool({
  codecAssets: {
    source: createSelfHostedRuntimeAssetSource(
      `/audio-transcoder-codecs/${AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version}`,
    ),
  },
  concurrency: 1,
  workerFactory: () =>
    new Worker(new URL('./audio-transcoder.worker.ts', import.meta.url), {
      name: 'audio-transcoder',
      type: 'module',
    }),
});
```

`workerFactory` alone changes only the URL/CSP-owned entry; it still declares the
package's default runtime and therefore exposes the built-in capability
manifest. The entry above must import `@echovisionlab/audio-transcoder/stream-worker`.

For a custom codec runtime, couple the custom Worker and its matching immutable
manifest explicitly:

```ts
const pool = createAudioTranscoderStreamWorkerPool({
  concurrency: 1,
  runtime: 'custom',
  capabilities: customCapabilities,
  workerFactory: () =>
    new Worker(new URL('./custom-audio-runtime.worker.ts', import.meta.url), {
      name: 'custom-audio-runtime',
      type: 'module',
    }),
});
```

Construct `createAudioTranscoderStreamEngine({ codecRuntime })` inside that
custom Worker. Adapters contain functions and may own module or WASM state, so
they are not structured-clone values. Supplying `capabilities` without
`runtime: 'custom'` and a `workerFactory` is an `INVALID_CONFIGURATION` error.
Every `workerFactory(workerIndex)` slot in a custom pool must expose the same
declared runtime and capability manifest. Do not use the slot index to mix codec
implementations or availability: capability discovery and output probe results
are pool-wide and assume homogeneous Worker slots.

## Framework ownership

In every framework, abort stale probes when the target changes, keep conversion
disabled while checking, and dispose in pool-then-session order.

### Vite bundling

This config preserves lazy Worker-side JavaScript glue as separate production
chunks. Raw codec and resampler WASM is independent of the bundler and comes
from `codecAssets`:

```ts
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
});
```

Without `worker.format: 'es'`, behavior remains correct but Vite may inline lazy
JavaScript glue into its IIFE Worker output.

### Vanilla

Create `createAudioToolRuntime()` when mounting the tool route. Retain its
download cleanup handles, abort active controllers, release those handles, then
await `runtime.dispose()` before replacing the route DOM. The app-level
`pagehide` handler remains best-effort crash cleanup.

### React

Keep the runtime in a ref rather than state and create it in an effect. Effect
cleanup cannot await, so start idempotent cleanup there and expose a separate
async navigation action when writer-lock release must be observed:

```tsx
const runtimeRef = useRef<ReturnType<typeof createAudioToolRuntime> | null>(null);

useEffect(() => {
  const owned = createAudioToolRuntime();
  runtimeRef.current = owned;

  return () => {
    if (runtimeRef.current === owned) runtimeRef.current = null;
    void owned.dispose();
  };
}, []);
```

In Storybook, own the runtime inside the rendered story and verify a real Worker
conversion in both development and the production Storybook build.

### Next.js App Router

Put the owner behind `'use client'`, but still create the runtime in an effect or
browser event rather than at module scope. Package metadata is SSR-safe; `File`,
Worker, OPFS, and object-URL operations are not. A dedicated route can use normal
route splitting; interaction-only loading may use
`await import('@echovisionlab/audio-transcoder')`. Verify the Worker, lazy JavaScript,
and explicitly configured raw-WASM URLs from the deployed base path before
adding `transpilePackages` or webpack overrides.

### Vue

Create the runtime in `onMounted()` and hold it in a non-reactive local binding,
`shallowRef()`, or `markRaw()`. `onUnmounted()` cannot await framework teardown;
start idempotent cleanup there and provide an explicit async shutdown action
when navigation must wait for disposal.

Do not keep a global pool unless the product intentionally wants a cross-route
queue. A global owner makes cancellation, stale UI updates, output URLs, and
storage lifetime harder to reason about.

## Browser validation

The stream path requires module Workers, transferable `WritableStream` values,
`Blob`, and `AbortController`. OPFS and Web Locks are progressive enhancements;
the bounded memory fallback remains available when OPFS initialization fails.
Encoder completion does not close the host destination by itself. The Worker
result authorizes one final destination `close()`, which is the irreversible
commit point; cancellation remains abortable before it, while cancellation or
disposal after it starts waits for the close result.

Test the actual Worker path in Chromium, Firefox, and WebKit. Chromium covers
the engine shared by Chrome, Edge, and Opera, but does not replace branded-
browser checks when the product promises them. Runtime-probed input codecs can
differ by engine, operating system, and browser version, so matrix tests must
assert that each file's `probeInputSupport()` result agrees with whether
transcoding is enabled rather than hard-code universal decode support.

Output candidates and static constraints are package-owned; current runtime
availability is probed. Matrix tests should call `probeOutputSupport()` for
exact targets, then write a small file for every WAV, AIFF, AAC, Ogg Opus, MP3,
and FLAC preset, parse the resulting header, test cancellation and queue
saturation, and exercise OPFS only where the runtime provides it.

## Whole-buffer compatibility

`createAudioTranscoderEngine()`, `createAudioTranscoderWorkerEngine()`, and
`createAudioTranscoderWorkerPool()` remain available for short inputs. They
accept complete `ArrayBuffer` input and return complete decoded or encoded
buffers.

Built-in whole-buffer support is:

- Inspect WAV, AIFF/AIFC, CAF, FLAC, and MP3 headers.
- Decode PCM WAV, uncompressed AIFF/AIFC, and LPCM CAF.
- Encode WAV integer 16/24/32-bit, WAV float32, and AIFF integer 16/24-bit.
- Transcode between a built-in PCM decoder and built-in encoder without hidden
  resampling or channel mixing.

Whole-buffer operations default to a 64 MiB guard for complete input and unique
PCM backing stores. Built-in WAV, AIFF/AIFC, and CAF decoders estimate expanded
planar Float32 bytes from headers and reject before allocation. Custom decoder
plugins should implement `estimateDecodedPcm()` to get the same preflight;
without it, only the post-decode guard is possible. `unsafeAllowLargeBuffers`
is an explicit bypass, not OOM protection.

Whole-buffer Worker engines and pools also use a bounded queue: `maxQueued`
defaults to `8`, has a maximum of `64`, and reports
`QUEUE_CAPACITY_EXCEEDED` when full. `maxQueuedBytes` defaults to 64 MiB and
counts only waiting operations; active operations are excluded. Complete input
buffers and unique PCM backing buffers are counted conservatively. The current
and configured values are exposed as `queuedBytes` and `maxQueuedBytes` in pool
snapshots. `unsafeAllowLargeBuffers` does not bypass this aggregate queue limit.

Pool concurrency defaults to `1` and has a maximum of `4`. Arbitrary values
captured by `schedule()` closures cannot be measured and therefore contribute
zero to `queuedBytes`; call `file.arrayBuffer()` inside the callback after a
slot is available. The whole-buffer lifecycle retains `terminate()`; it does
not own the seekable streaming output locks covered by async stream `dispose()`.

## Third-party distribution

Production distribution comprises the engine JavaScript/Worker plus separately
served raw FFmpeg AAC, libopusenc/libopus/libogg, LAME, libFLAC, and
libsamplerate assets. Make `THIRD_PARTY_NOTICES.md`, the applicable complete
license texts, and the required source/relink offer available with the deployed
artifact. A released package's corresponding source is the public repository
tag `v<package-version>`, which retains the exact build materials under
`codec-build/` and `vendor/`. The notice records the audited upstream archive
URLs, hashes, revisions, and distribution considerations; it is not legal
advice.

The engine and `codec-assets/` tree release together in one exact public GitHub
tag. Release Please alone establishes the version, tag, and GitHub release. The
Release workflow verifies the manifest and all seven raw WASM files through
`https://cdn.jsdelivr.net/gh/echovisionlab/audio-transcoder@v<version>/codec-assets`,
then publishes only `@echovisionlab/audio-transcoder` through npm Trusted Publishing
(OIDC) on a GitHub-hosted runner. There is no separate codec npm package,
manual publish, recovery publish, or manual tag path. The engine publication
gate checks the exact tagged CDN bytes, sizes, SHA-256 values, ABI, schema, and
WebAssembly validity before npm publication.

## Consumer release gate

Verify development and production builds because Worker bundles and external
asset routing can differ:

1. Build and serve the consumer from its real base path.
2. Probe a concrete input and the selected exact output target before enabling
   conversion.
3. Run one real Worker conversion for WAV, AIFF, AAC, Ogg Opus, MP3, and FLAC.
4. Confirm progress reaches `1`, cancellation settles, and downloads parse.
5. Confirm the main Worker and lazy JavaScript return JavaScript, and every
   selected stable `.wasm` URL returns the manifest-matched raw asset rather
   than an HTML fallback. Record the primary/fallback URL actually used.
6. Confirm loading state reaches `downloading`, `verifying`, then `ready`, and
   confirm a bad size/hash reaches `error` rather than compilation.
7. Confirm the deployed CSP allows the module Worker, WASM compilation, and
   every configured asset origin without allowing a Blob Worker.
8. Await runtime disposal and verify no output writer remains locked.
9. Repeat the interaction in the development server and built Storybook.
