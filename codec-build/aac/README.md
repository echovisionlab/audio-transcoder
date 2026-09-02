# Bundled AAC encoder provenance

The browser AAC-LC encoder is built from the native FFmpeg AAC encoder and a
small MediaBunny bridge. It executes directly inside the existing transcoder
Worker; it does not create a nested or Blob Worker.

Pinned inputs:

- FFmpeg `n8.1.2`, commit
  `38b88335f99e76ed89ff3c93f877fdefce736c13`, official archive SHA-256
  `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`.
- Emscripten SDK `5.0.7`, arm64 image manifest
  `sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c`
  (`emcc` commit `263db4cffa6f9fc2ec514a70abac81362ea41849`).
- Bridge adapted from MediaBunny AAC encoder
  `1.50.9`, repository commit
  `794b84884f1e23cb6241689b3563190d138bbd9a`. The local bridge unreferences
  each reusable `AVPacket` before receive, makes its reusable `AVFrame`
  writable before every send, returns FFmpeg's flush status instead of
  discarding it, and exposes FFmpeg's own backpressure code and error
  descriptions to JavaScript.

Run `./codec-build/aac/build.sh` from any directory with Docker Desktop
available. The script downloads and verifies FFmpeg, builds only `avcodec`,
`avutil`, and the native AAC encoder with GPL/nonfree components disabled, and
checks the thin JavaScript glue and separate raw `aac.wasm` against their
committed SHA-256 values. `SINGLE_FILE` is deliberately disabled so consumers
download the verified WASM asset lazily instead of receiving a duplicate
base64 payload in the engine package. After Emscripten runs, the build applies
`patch-generated-glue.mjs` to remove its unused static local-WASM fallback.
The package runtime always supplies the verified codec asset through
`instantiateWasm`; failing closed here prevents consumer bundlers from trying
to resolve or bundle a nonexistent `aac.generated.wasm` file.

Use `--verify-reproduction --output-dir DIR` to write the audited output away
from the checkout. Pass `--source-dir DIR` to use a previously downloaded
`ffmpeg-8.1.2.tar.xz`. After modifying covered source, pass its root with
`--source-tree DIR` and use `--relink --output-dir DIR`; relink mode permits a
new output hash and cannot overwrite a path inside the repository.

The complete bridge source and build instructions are distributed so a
recipient can modify the LGPL-covered FFmpeg code and relink the WebAssembly
module. The generated module must remain accompanied by the FFmpeg LGPL notice,
the MPL notice for the bridge, these build inputs, and an offer/source location
that remains available for the distribution's required term.
