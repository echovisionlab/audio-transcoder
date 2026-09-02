# Ogg Opus WASM provenance and rebuild

The raw `wasm/ogg-opus.wasm` codec asset is built from unmodified official Xiph
release archives plus `ogg-opus-libopusenc-bridge.c` in this directory. The
bridge uses libopusenc's pull API; libogg validates every emitted page.

| Component                  | Official archive                                                       | SHA-256                                                            |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| libopusenc 0.3             | `https://downloads.xiph.org/releases/opus/libopusenc-0.3.tar.gz`       | `f616d3aff9b2034547894ccb8ab56c36cf1a4acb0d922c5d7119f97bbe58642c` |
| libopus 1.6.1              | `https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz`           | `6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1` |
| libogg 1.3.6               | `https://downloads.xiph.org/releases/ogg/libogg-1.3.6.tar.xz`          | `5c8253428e181840cd20d41f3ca16557a9cc04bad4a3d04cce84808677fa1061` |
| Emscripten SDK             | emsdk tag `4.0.20`, commit `e4fe26ef59168ff44f4c23c466e497bf60b3411e`  | selected and checked by the build script                           |
| Emscripten compiler        | tag `4.0.20`, source commit `6913738ec5371a88c4af5a80db0ab42bad3de681` | compiler release selected by the pinned SDK                        |
| emscripten-releases bundle | revision `c387d7a7e9537d0041d2c3ae71b7538cc978104e`                    | release revision recorded by the pinned SDK manifest               |

Rebuild from the repository root:

```sh
git clone --depth 1 --branch 4.0.20 \
  https://github.com/emscripten-core/emsdk.git /tmp/audio-transcoder-emsdk-4.0.20
/tmp/audio-transcoder-emsdk-4.0.20/emsdk install 4.0.20
/tmp/audio-transcoder-emsdk-4.0.20/emsdk activate 4.0.20
OGG_OPUS_EMSDK_ROOT=/tmp/audio-transcoder-emsdk-4.0.20 \
  ./scripts/ogg-opus-build-wasm.sh
```

Use `--verify-reproduction --output-dir DIR` to write audited raw WASM outside
the checkout. `--source-dir DIR` consumes the three pinned Xiph archives from
that directory. After modifying the bridge, use `--relink --output-dir DIR`;
the output may have a new hash and cannot overwrite a path inside the repository.

The script fails closed on any archive hash, emsdk commit, or compiler-version
mismatch and prints the final WASM import table. Its generated TypeScript file
is now only a deterministic repository build fixture: `prepare-codec-assets`
extracts and verifies the raw bytes when staging the version-matched codec asset
package. The engine npm package excludes that fixture and all raw WASM. At
runtime the caller explicitly selects a self-hosted or exact-version jsDelivr
source, and the provider verifies decoded byte size and SHA-256 before
compilation.

Runtime controls are deliberately fixed: serial `0x41554430` (`AUD0`), 20 ms
frames and muxing delay, zero decision delay, zero comment padding, complexity
10, VBR enabled (the preset bitrate is its target), unconstrained VBR, and DTX
disabled. OPE supplies the OpusHead pre-skip and the exact end granule. The
bridge rejects any EOS granule other than `pre_skip + source_frames` at 48 kHz.
The module has a fixed 1 MiB stack and grows linear memory only up to 64 MiB;
each encoder instance owns its linear memory and releases it on settlement.

libopusenc and libogg use the 3-clause BSD license. libopus uses the 3-clause
BSD license; the official archive also contains its codec patent grant. The
repository's package-level third-party notices must list all three components
before release.
