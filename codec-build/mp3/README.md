# Raw MP3 encoder provenance and rebuild

The browser MP3 encoder uses a raw, standalone WebAssembly build of LAME
3.100. It runs directly inside the existing Echo Vision Lab transcoder Worker and never
creates the nested Blob Worker used by `@mediabunny/mp3-encoder` 1.50.9.

Pinned inputs:

- LAME `3.100`, official SourceForge archive
  `lame-3.100.tar.gz`, SHA-256
  `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`.
- Emscripten SDK `5.0.7`, arm64 image manifest
  `sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c`
  (`emcc` commit `263db4cffa6f9fc2ec514a70abac81362ea41849`).
- The MediaBunny 1.50.9 source package and repository commit
  `794b84884f1e23cb6241689b3563190d138bbd9a`, whose npm `gitHead` points
  at that exact commit. Its checked-in upstream LAME module has raw-WASM
  SHA-256 `d0b109db83c153b81ba0080fa2163664dff1e341b154edda6d40bc4b6fbc355e`.

MediaBunny's documented recipe compiles LAME with `-O3 -msimd128`, statically
links its small MPL-2.0 bridge, and asks Emscripten to inline the WASM into a
single JavaScript file. The Echo Vision Lab build retains LAME 3.100 and SIMD but uses
`-Oz -flto`, a stable `mp3_*` ABI, and standalone raw WASM. JavaScript
supplies already-downloaded and integrity-verified bytes; the codec does not
select a URL or asset provider.

Run `./codec-build/mp3/build.sh` from any directory with Docker available.
The script downloads and verifies the official source archive, checks the
pinned compiler version, builds LAME without its decoder or frontend, links
the bridge, and checks the result against the committed artifact SHA-256.

Use `--verify-reproduction --output-dir DIR` for an isolated audited build and
`--source-dir DIR` to use `lame-3.100.tar.gz` locally. After modifying covered
source, pass its root with `--source-tree DIR` and use `--relink --output-dir
DIR`; this permits a new hash without overwriting a path inside the repository.

The complete bridge and build instructions are distributed so recipients can
modify the LGPL-covered LAME code and relink `mp3.wasm`. Keep the LAME license
at `THIRD_PARTY_LICENSES/LAME-3.100-LGPL-2.0-or-later.txt` and the MediaBunny
MPL-2.0 license at `THIRD_PARTY_LICENSES/MEDIABUNNY-MPL-2.0.txt` with every
binary distribution. This provenance record supplements rather than replaces
the project's release-time license checklist.
