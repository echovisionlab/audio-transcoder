# Codec runtime assets

Version-matched raw WebAssembly assets for `@echovisionlab/audio-transcoder`.

These files are part of the public GitHub release tag matching the engine
version; they are not published as a separate npm package. That tag contains
the modified bridges, build scripts, manifests, verifiers, notices, and relink
instructions.
`THIRD_PARTY_NOTICES.md` records the exact upstream archive URLs and SHA-256
digests. Do not substitute a branch, `latest`, or a version range when locating
source for a released binary.

The engine never selects this package or a CDN implicitly. The application must
pass an explicit primary source to the default stream Worker. Optional fallback
sources are tried sequentially in configuration order after the preceding
source fails to load or verify; sources are never raced.

The engine package embeds a schema-version-1 manifest containing the release's
exact version, ABI version, stable asset paths, decoded raw byte counts, and
SHA-256 digests. Provider creation validates the schema and ABI contract. A
jsDelivr source must also use the exact manifest version. Every response is
decoded, byte-counted, and SHA-256-verified before WebAssembly compilation.
Fallbacks receive exactly the same checks.

The raw modules run directly in the engine's existing module Worker. The engine
package does not embed these payloads, create a nested or Blob Worker, or choose
a package-controlled network source.

## Explicit jsDelivr opt-in

```ts
import {
  createAudioTranscoderJsDelivrAssetSource,
  createAudioTranscoderStreamWorkerPool,
} from '@echovisionlab/audio-transcoder';

const pool = createAudioTranscoderStreamWorkerPool({
  codecAssets: {
    source: createAudioTranscoderJsDelivrAssetSource(),
  },
});
```

The helper reads the exact version baked into the engine. If that version is
`1.2.3`, the stable URL for AAC is exactly:

```text
https://cdn.jsdelivr.net/gh/echovisionlab/audio-transcoder@v1.2.3/codec-assets/wasm/aac.wasm
```

`1.2.3` is illustrative. Never substitute a branch, `latest`, or a SemVer
range. The no-argument helper can produce only the baked exact version. If an
application uses the lower-level jsDelivr source constructor, provider creation
rejects a version that differs from the engine manifest.

## Self-hosting and ordered fallback

Place the `wasm/` directory at a versioned base URL. Preserve the stable names;
the engine manifest, rather than a hash in each filename, provides identity.

```ts
import {
  AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
  createAudioTranscoderJsDelivrAssetSource,
  createAudioTranscoderStreamWorkerPool,
  createSelfHostedRuntimeAssetSource,
} from '@echovisionlab/audio-transcoder';

const exactVersion = AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version;
const pool = createAudioTranscoderStreamWorkerPool({
  codecAssets: {
    source: createSelfHostedRuntimeAssetSource(
      `https://assets.example.com/audio-transcoder/${exactVersion}`,
    ),
    fallbackSources: [createAudioTranscoderJsDelivrAssetSource()],
    onStateChange(state) {
      console.log(state);
    },
  },
});
```

This example tries the self-hosted origin first and jsDelivr second. Reverse the
two only when the application intentionally prefers jsDelivr. Every source must
serve the exact bytes named by the engine manifest; a mirror is not a path for
different codec builds.

The state model starts at `idle`. Once a load starts, `onStateChange` reports
`downloading`, `verifying`, `ready`, or final `error` with an asset name and
loaded bytes. It lets a host say that the audio engine is loading rather than
appearing stalled before encode progress begins. When HTTP gzip or Brotli makes
`Content-Length` describe compressed transfer bytes, `totalBytes` is `null`;
use indeterminate progress while integrity continues to cover the decoded raw
WASM.

## Stable runtime paths

- `wasm/aac.wasm`
- `wasm/flac.wasm`
- `wasm/mp3.wasm`
- `wasm/ogg-opus.wasm`
- `wasm/resampler-fast.wasm`
- `wasm/resampler-balanced.wasm`
- `wasm/resampler-best.wasm`

WAV and AIFF do not use these assets. Selecting or probing one of the four
compressed output codecs downloads only that codec. A same-rate conversion
loads no resampler; a rate change loads only the selected resampler quality.

## Hosting and CSP

Serve `.wasm` with `Content-Type: application/wasm`. HTTP gzip or Brotli is a
transport optimization; the manifest size and SHA-256 always identify decoded
raw bytes. An exact-version jsDelivr URL or versioned self-host path can use an
immutable cache policy.

The engine Worker is same-origin and needs `worker-src 'self'`; no Blob Worker
permission is required. WASM compilation needs the application's selected
`script-src` policy (commonly `'wasm-unsafe-eval'`). Worker-side `fetch` needs
the selected source and every possible final fallback origin in `connect-src`.
For explicit jsDelivr use, allow `https://cdn.jsdelivr.net`. Cross-origin hosts
must send suitable CORS headers. The asset host receives requests for these
public WASM files only; the engine does not upload user audio.

## Version and release order

`@echovisionlab/audio-transcoder` and this `codec-assets/` tree are released together in
one exact public GitHub tag:

1. Let Release Please establish the engine version and changelog; do not create
   a manual tag or version edit.
2. The Release workflow verifies the manifest and all seven raw WASM files at
   the exact jsDelivr GitHub path
   `/gh/echovisionlab/audio-transcoder@v<version>/codec-assets`.
3. Only after those CDN bytes pass size, SHA-256, ABI, schema, and WebAssembly
   validation does the workflow publish `@echovisionlab/audio-transcoder` through npm
   Trusted Publishing (OIDC).

There is no separate codec npm package, manual publish, recovery publish, or
manual tag path. Release Please is the only owner of release versions and tags.

See `THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_LICENSES/`, and the pinned build and
provenance material in the engine repository's `codec-build/` and `vendor/`
directories before redistribution.
