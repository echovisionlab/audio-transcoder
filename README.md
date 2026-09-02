# Audio transcoder

Browser-local audio inspection and transcoding in module Web Workers. Local
`Blob` and `File` inputs stay on the device; HTTP inputs are fetched from the
source explicitly supplied by the host application.

```sh
pnpm add @echovisionlab/audio-transcoder
```

```ts
import {
  createAudioTranscoderStreamWorkerPool,
  createSelfHostedRuntimeAssetSource,
} from "@echovisionlab/audio-transcoder";

const pool = createAudioTranscoderStreamWorkerPool({
  codecAssets: {
    source: createSelfHostedRuntimeAssetSource("/audio-codecs/0.1.0"),
  },
  concurrency: 1,
  maxQueued: 8,
});
```

WAV and AIFF use JavaScript only. AAC, Ogg Opus, MP3, FLAC, and resampling load
the exact versioned WASM asset on demand. The application may self-host those
assets or explicitly opt into the jsDelivr helper. See [docs](docs/) for the
full API, integration, memory, security, and codec documentation.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:coverage
pnpm build
pnpm package:verify
pnpm package:pack
```

Codec source, pinned provenance, build scripts, license texts, and release asset
verification are included in this repository.

## Release

Release Please creates the GitHub release and versioned codec assets. The npm
package is published through GitHub Actions trusted publishing without a
repository npm token.

## License

PolyForm Noncommercial 1.0.0. Commercial use requires a separate license from
Echo Vision Lab. Bundled codec components retain their licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
