# FLAC encoder WASM provenance and relinking

This directory contains the complete Echo Vision Lab-owned bridge, pinned build recipe,
and reproducible raw WebAssembly artifact used by the browser FLAC encoder.
The module executes directly inside the existing audio-transcoder Worker; it
does not create MediaBunny's nested Blob Worker.

## Pinned upstream inputs

- MediaBunny FLAC encoder `1.50.9`, repository commit
  `794b84884f1e23cb6241689b3563190d138bbd9a`. That exact commit's generated
  module identifies libFLAC as `git-3f1ecff8 20260304`.
- libFLAC commit `3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c`, downloaded from the
  official Xiph GitHub repository. The exact source archive SHA-256 is
  `4ace54db53e274f6c73999a644b0a11410f67e5c35c06e4aaa8e5457bbf59f9d`.
- Emscripten SDK `5.0.7`, compiler source commit
  `263db4cffa6f9fc2ec514a70abac81362ea41849`, using the pinned linux/arm64
  image manifest
  `sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c`.

The MediaBunny bridge's compression level 5, supported channel count, sample
rates, 16/24-bit input selection, and `-msimd128` optimization are preserved.
The Echo Vision Lab bridge adds explicit destruction, checked allocations, reusable flush,
and an ABI-version function; all exported application symbols use the
`flac_` prefix.

## Rebuild and relink

With Docker Desktop available, run from any directory:

```sh
sh codec-build/flac/build.sh
```

The script downloads and verifies the exact libFLAC source, builds only the
static libFLAC target, links the bridge as standalone raw WebAssembly, and
refuses to replace the committed artifact unless its SHA-256 matches the
recorded value. It then runs `verify.mjs`, which checks the complete manifest,
import/export surface, ABI version, and a real encode/finish/reset cycle. The
source directory is mounted read-only and all temporary build files are removed
afterward.

Use `--verify-reproduction --output-dir DIR` for an isolated audited build and
`--source-dir DIR` to use the pinned archive locally. After modifying covered
source, pass its root with `--source-tree DIR` and use `--relink --output-dir
DIR`; this permits a new hash without overwriting a path inside the repository.

The verifier can also be run independently:

```sh
node codec-build/flac/verify.mjs
```

The raw module is intended to be copied into the separately versioned codec
asset package as the stable path `wasm/flac.wasm`. Runtime integrity belongs to
that package manifest; the filename itself deliberately has no duplicate hash.

## License material

- The bridge is MPL-2.0 and is adapted from MediaBunny's MPL-2.0 bridge. The
  complete license is distributed at
  `THIRD_PARTY_LICENSES/MEDIABUNNY-MPL-2.0.txt`.
- libFLAC uses the Xiph BSD license. The complete license is distributed at
  `THIRD_PARTY_LICENSES/LIBFLAC-XIPH-BSD.txt`.

`manifest.json`, this README, `bridge.c`, `build.sh`, and `verify.mjs` must
accompany the binary in source/relink materials for each published asset
version.
