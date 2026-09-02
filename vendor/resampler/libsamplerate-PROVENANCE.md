# libsamplerate resampler WASM provenance

- Source: `libsndfile/libsamplerate`
- Revision: `aee38d0bc797d0d1a3774ef574af1d5d248d2398`
- Source archive SHA-256: `deefc369f627b256724c4785bf32de5a839d8672f573aa17b1c89d6974dee3b3`
- License: BSD-2-Clause (the complete text is distributed at
  `THIRD_PARTY_LICENSES/LIBSAMPLERATE-BSD-2-CLAUSE.txt`)
- Toolchain: Emscripten 5.0.7 image manifest
  `emscripten/emsdk@sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c`
- Emscripten compiler source tag commit:
  `263db4cffa6f9fc2ec514a70abac81362ea41849`

`scripts/resampler-build-wasm.sh` downloads and verifies the pinned archive,
then emits one module for each existing quality contract. Each module compiles
only its selected sinc coefficient table; the runtime loads exactly one module
for a conversion session. In particular, the `best` build enables upstream
`SINC_BEST_QUALITY` unchanged, including its complete coefficient table. No
quality table, passband, supported sample-rate range, or channel count is
reduced by this split.

Use `scripts/resampler-build-wasm.sh --verify-reproduction --output-dir DIR`
for isolated audited raw WASM output and `--source-dir DIR` to use the pinned
archive locally. After modifying the bridge, use `--relink --output-dir DIR`;
the complete best-quality table remains enabled and no path inside the
repository can be overwritten.
