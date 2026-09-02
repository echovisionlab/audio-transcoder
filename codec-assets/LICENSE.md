# Runtime codec asset license information

These runtime assets contain components under multiple licenses.

AudioTranscoder-authored packaging, bridge, and build material is covered by the
PolyForm Noncommercial License 1.0.0 reproduced in the repository root
[`LICENSE.md`](../LICENSE.md) and staged as `LICENSE.POLYFORM.md` in local fixtures,
unless a file or notice says otherwise. Third-party components retain their own
licenses, and the Echo Vision Lab license does not restrict rights granted directly by
those licenses.

The WebAssembly files incorporate or are generated from FFmpeg, LAME,
libFLAC, libopusenc, Opus, libogg, libsamplerate, MediaBunny-derived bridge
source, and Emscripten support code. `THIRD_PARTY_NOTICES.md` identifies the
exact components and modifications. The applicable complete license texts are
in `THIRD_PARTY_LICENSES/` and `codec-build/aac/`.

Corresponding modified source, build scripts, manifests, and relink
instructions are available in the public repository at the Git tag matching
the engine version that references these assets:

```text
https://github.com/echovisionlab/audio-transcoder/tree/v<package-version>
```

The license texts control if this summary differs from them. This summary is
not legal advice.
