# Third-party notices

`@echovisionlab/audio-transcoder` is licensed separately under the PolyForm
Noncommercial License 1.0.0 in `LICENSE.md`. Third-party components retain the
licenses below; the Echo Vision Lab license does not restrict rights granted directly by
those licenses.

The repository contains the referenced license texts under
`THIRD_PARTY_LICENSES/` and pinned source/build or provenance material under
`codec-build/` and `vendor/`. A production distribution can include the engine
JavaScript and Worker plus separately served raw codec/resampler WebAssembly.
Downstream distributors should make this notice, the applicable complete
license texts, and the required source/relink offer available with the deployed
artifacts. Distributors remain responsible for meeting all source,
modification, relinking, notice, and offer-duration requirements. This summary
is not legal advice; the included license texts control.

For each released package version, the corresponding Echo Vision Lab source and relink
material is the public repository tag `v<package-version>` at
`https://github.com/echovisionlab/audio-transcoder`. Release tags must not be moved or
deleted. The exact upstream source archive URLs and SHA-256 digests are recorded
below. A package or CDN URL exists only after that exact version is published.

## Emscripten compiler toolchains

The generated AAC, Ogg Opus, MP3, FLAC, and resampler modules contain
runtime/support code produced by pinned Emscripten compiler toolchains.
Emscripten is offered under the MIT license and the University of
Illinois/NCSA Open Source License.

- AAC: Emscripten `5.0.7`, compiler source tag commit
  `263db4cffa6f9fc2ec514a70abac81362ea41849`, arm64 image manifest
  `emscripten/emsdk@sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c`.
- MP3 and FLAC: Emscripten `5.0.7`, the same compiler source tag commit and
  arm64 image manifest as AAC.
- Ogg Opus: Emscripten `4.0.20`, emsdk tag commit
  `e4fe26ef59168ff44f4c23c466e497bf60b3411e`, compiler source tag commit
  `6913738ec5371a88c4af5a80db0ab42bad3de681`, and emscripten-releases
  revision `c387d7a7e9537d0041d2c3ae71b7538cc978104e` recorded by that SDK.
- Resampler: Emscripten `5.0.7`, compiler source tag commit
  `263db4cffa6f9fc2ec514a70abac81362ea41849`, image manifest
  `emscripten/emsdk@sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c`.
- Official compiler source: [Emscripten](https://github.com/emscripten-core/emscripten)
- Official SDK source: [emsdk](https://github.com/emscripten-core/emsdk)
- Full compiler license text: `THIRD_PARTY_LICENSES/EMSCRIPTEN-MIT-AND-UIUC-NCSA.txt`

## MediaBunny runtime 1.55.1 and encoder sources 1.50.9

Applies to the installed `mediabunny` runtime at `1.55.1` and to the AAC, MP3,
and FLAC bridge source adapted from MediaBunny `1.50.9`. The official encoder
extension packages are provenance inputs; the Echo Vision Lab runtime uses its own raw-WASM
bridges, not those packages' nested Worker distributions.

- Copyright: MediaBunny contributors
- License: MPL-2.0
- Runtime source revision: [018c2ca67b728610e61fce23a2bdd23c8a2126c6](https://github.com/Vanilagy/mediabunny/tree/018c2ca67b728610e61fce23a2bdd23c8a2126c6)
- Encoder source revision: [794b84884f1e23cb6241689b3563190d138bbd9a](https://github.com/Vanilagy/mediabunny/tree/794b84884f1e23cb6241689b3563190d138bbd9a)
- AAC extension source and bridge: [packages/aac-encoder](https://github.com/Vanilagy/mediabunny/tree/794b84884f1e23cb6241689b3563190d138bbd9a/packages/aac-encoder)
- MP3 extension source and bridge: [packages/mp3-encoder](https://github.com/Vanilagy/mediabunny/tree/794b84884f1e23cb6241689b3563190d138bbd9a/packages/mp3-encoder)
- FLAC extension source and bridge: [packages/flac-encoder](https://github.com/Vanilagy/mediabunny/tree/794b84884f1e23cb6241689b3563190d138bbd9a/packages/flac-encoder)
- AAC source package: `https://registry.npmjs.org/@mediabunny/aac-encoder/-/aac-encoder-1.50.9.tgz`, SHA-256 `6d606df0b5eeff05a89519c0e8177f40aea89531a3d0bd31c3c1bb2a442ea9fb`
- MP3 source package: `https://registry.npmjs.org/@mediabunny/mp3-encoder/-/mp3-encoder-1.50.9.tgz`, SHA-256 `4b626599ef23c7b610c33989bbe7fbfcb0f3d3e975dd92f17bb5ef07ce7b2b47`
- FLAC source package: `https://registry.npmjs.org/@mediabunny/flac-encoder/-/flac-encoder-1.50.9.tgz`, SHA-256 `97582e9a34a9831020a5fd7bedcd05c676c32c2ddcb0f7c50f30f19c373e1f39`
- Full license: `THIRD_PARTY_LICENSES/MEDIABUNNY-MPL-2.0.txt`

Keep the MPL notices with distributions. If MPL-covered files are modified and
distributed, make the corresponding covered source available as required by
the MPL.

## FFmpeg 8.1.2 native AAC encoder

The raw AAC-LC output module statically links a minimal build of FFmpeg's
native AAC encoder with `libavcodec` and `libavutil`. GPL and nonfree components,
programs, protocols, demuxers, muxers, networking, and threading are disabled.
The MediaBunny-derived bridge remains MPL-2.0 and is present in repository
source form with its modifications identified.

- FFmpeg license: LGPL-2.1-or-later
- Exact tag and commit: `n8.1.2`, `38b88335f99e76ed89ff3c93f877fdefce736c13`
- Official source archive: [ffmpeg-8.1.2.tar.xz](https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz)
- Archive SHA-256: `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`
- Generated thin JavaScript glue SHA-256:
  `e1e8467b25fa8401580617ed359067b07c8ceaf5ae662112265040cdba686283`
- Raw `aac.wasm` SHA-256:
  `90c75819c422afbbb2feb0ba8e9e4ec94a004d800799cfa083182359e5497efc`
- Raw `aac.wasm` size: `511450` bytes
- Complete pinned build, bridge source, manifest, and relink instructions: `codec-build/aac/`
- FFmpeg license: `codec-build/aac/LICENSE.FFMPEG-LGPL-2.1.txt`
- Bridge license: `codec-build/aac/LICENSE.BRIDGE-MPL-2.0.txt`

Keep the LGPL and MPL notices with distributions. The repository build material records
the exact upstream source, compiler image, bridge source, build command, and
artifact hash so recipients can modify the covered code and rebuild/relink the
WebAssembly module. Downstream distributors remain responsible for satisfying
the source and relinking requirements for the exact deployed artifact.

## LAME 3.100 in the MP3 encoder

The raw Echo Vision Lab MP3 asset statically links LAME 3.100 through an MPL-2.0 bridge
adapted from `@mediabunny/mp3-encoder@1.50.9`. LAME 3.100's project `COPYING`
is the GNU Library General Public License, version 2, with the "or any later
version" option; its SPDX identifier is `LGPL-2.0-or-later`.

- Project: [LAME MP3 Encoder](https://lame.sourceforge.io/)
- Official license page: [license.txt](https://lame.sourceforge.io/license.txt)
- Exact source archive: [lame-3.100.tar.gz](https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz)
- Archive SHA-256: `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`
- MediaBunny build recipe: [MP3 encoder README at the published revision](https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/mp3-encoder/README.md#building-and-development)
- MediaBunny bridge source: [lame-bridge.c](https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/mp3-encoder/src/lame-bridge.c)
- AudioTranscoder bridge, pinned build, manifest, verifier, and relink instructions:
  `codec-build/mp3/`
- Raw `mp3.wasm` SHA-256:
  `b0e3a6768c25baf7103557f31ac0f18f86be721796e999605cc9544090e72315`
- Raw `mp3.wasm` size: `127587` bytes
- Full license: `THIRD_PARTY_LICENSES/LAME-3.100-LGPL-2.0-or-later.txt`

The upstream recipe and Echo Vision Lab build configure LAME without its decoder and link
`libmp3lame.a`. LAME's own build files define that option as excluding the
mpg123 decoder and omit `mpglib/libmpgdecoder.la` from the library link. The raw
asset therefore contains the encoder, not the decoder/mpglib library. This
narrows the shipped component set; it does not remove the LAME LGPL
obligations. The Echo Vision Lab bridge replaces the upstream nested Blob Worker and
inlined glue with a synchronous ABI in the existing transcoder Worker.

For a final web distribution, retain the acknowledgment and license and satisfy
the LGPL source/relinking requirements for the exact deployed WASM and bridge.
The pinned source archive and local bridge/build recipe make that assessment,
rebuild, and source retrieval reproducible. The matching public Echo Vision Lab release
tag preserves the modified bridge and relink recipe for the package version.

## libFLAC in the FLAC encoder

The raw Echo Vision Lab FLAC asset statically links the libFLAC revision identified by
`@mediabunny/flac-encoder@1.50.9` as `FLAC git-3f1ecff8 20260304`. Its
MPL-2.0 bridge is adapted from that package but executes synchronously inside
the existing transcoder Worker, with no nested Blob Worker.

- Component license: Xiph BSD (3-Clause-style)
- Exact source revision: [3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c](https://github.com/xiph/flac/tree/3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c)
- Source archive SHA-256:
  `4ace54db53e274f6c73999a644b0a11410f67e5c35c06e4aaa8e5457bbf59f9d`
- License at that revision: [COPYING.Xiph](https://github.com/xiph/flac/blob/3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c/COPYING.Xiph)
- MediaBunny build recipe: [FLAC encoder README at the published revision](https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/flac-encoder/README.md#building-and-development)
- MediaBunny bridge source: [bridge.c](https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/flac-encoder/src/bridge.c)
- AudioTranscoder bridge, pinned build, manifest, verifier, and relink instructions:
  `codec-build/flac/`
- Raw `flac.wasm` SHA-256:
  `c5af8358bb1ccc99ef3922c15a676aa8c07915ac7c5635cf3a599375fc56ee86`
- Raw `flac.wasm` size: `112070` bytes
- Full license: `THIRD_PARTY_LICENSES/LIBFLAC-XIPH-BSD.txt`

Binary distributions must reproduce the copyright notice, conditions, and
disclaimer in their documentation and/or other supplied materials.

## libopusenc 0.3, libopus 1.6.1, and libogg 1.3.6 in Ogg Opus output

The raw Ogg Opus stream writer links the official Xiph release archives
below into a dedicated WebAssembly module. The package bridge uses
libopusenc's pull API while libogg validates emitted pages.

- Component licenses: Xiph BSD (3-Clause-style)
- libopusenc 0.3 archive: [libopusenc-0.3.tar.gz](https://downloads.xiph.org/releases/opus/libopusenc-0.3.tar.gz)
- libopusenc SHA-256: `f616d3aff9b2034547894ccb8ab56c36cf1a4acb0d922c5d7119f97bbe58642c`
- libopus 1.6.1 archive: [opus-1.6.1.tar.gz](https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz)
- libopus SHA-256: `6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1`
- libogg 1.3.6 archive: [libogg-1.3.6.tar.xz](https://downloads.xiph.org/releases/ogg/libogg-1.3.6.tar.xz)
- libogg SHA-256: `5c8253428e181840cd20d41f3ca16557a9cc04bad4a3d04cce84808677fa1061`
- Rebuild inputs and bridge: `vendor/ogg-opus/ogg-opus-PROVENANCE.md`
- Raw `ogg-opus.wasm` SHA-256:
  `ec1d29d65a7e1957e9551e55cc1a74d3679dc8d4c26df4287350590cc1e7734a`
- Raw `ogg-opus.wasm` size: `222658` bytes
- Full licenses and Opus patent-license references: `THIRD_PARTY_LICENSES/LIBOPUSENC-LIBOPUS-LIBOGG-XIPH-BSD.txt`

Binary distributions must reproduce the copyright notices, conditions, and
disclaimers in their documentation and/or other supplied materials. The
libopus license also identifies the royalty-free patent-license references
reproduced in the full license file.

## libsamplerate

The raw sample-rate converter is built directly from libsamplerate at
revision `aee38d0bc797d0d1a3774ef574af1d5d248d2398`. The package emits separate
WASM modules for the existing `best`, `balanced`, and `fast` sinc converters so
one conversion loads only its selected quality. The `best` module retains the
complete upstream highest-quality coefficient table.

- libsamplerate license: BSD-2-Clause
- Exact libsamplerate source: [aee38d0bc797d0d1a3774ef574af1d5d248d2398](https://github.com/libsndfile/libsamplerate/tree/aee38d0bc797d0d1a3774ef574af1d5d248d2398)
- Source archive SHA-256: `deefc369f627b256724c4785bf32de5a839d8672f573aa17b1c89d6974dee3b3`
- libsamplerate license at that revision: [COPYING](https://github.com/libsndfile/libsamplerate/blob/aee38d0bc797d0d1a3774ef574af1d5d248d2398/COPYING)
- Rebuild inputs and bridge: `vendor/resampler/libsamplerate-PROVENANCE.md`
- Full license: `THIRD_PARTY_LICENSES/LIBSAMPLERATE-BSD-2-CLAUSE.txt`
- Best WASM SHA-256: `47d03b079057d17bbefcf3b17ea92fc2b0a6ba027b5ea13154b4e2f35177b7d0`
- Balanced WASM SHA-256: `d68f10254f7b694990092943930e43bc4fa9a2f9775da452490764a062112f1c`
- Fast WASM SHA-256: `2c2bf7a58a90af6c8dcb76a98dc90a042cec538e326ae67f6d69aa907d9f93a0`

Binary distributions must reproduce the copyright notice, conditions, and
disclaimer in their documentation and/or other supplied materials.
