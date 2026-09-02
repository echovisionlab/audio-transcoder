import { createHash } from "node:crypto";

export const CODEC_ASSET_PACKAGE_NAME =
  "@echovisionlab/audio-transcoder-codec-assets-fixture";
export const CODEC_ASSET_PACKAGE_DESCRIPTION =
  "Private local fixture for version-locked @echovisionlab/audio-transcoder WebAssembly assets.";
export const CODEC_ASSET_PACKAGE_PUBLISH_BLOCK_MESSAGE =
  "Codec asset fixtures are private and must not be published.";
export const CODEC_ASSET_PACKAGE_PUBLISH_GUARD = `node -e "throw new Error('${CODEC_ASSET_PACKAGE_PUBLISH_BLOCK_MESSAGE}')"`;

export const CODEC_ASSET_LEGAL_FILES = Object.freeze(
  [
    {
      packagePath: "LICENSE.md",
      sourcePath: "codec-assets/LICENSE.md",
    },
    {
      packagePath: "LICENSE.POLYFORM.md",
      sourcePath: "LICENSE.md",
    },
    {
      packagePath: "README.md",
      sourcePath: "codec-assets/README.md",
    },
    {
      packagePath: "THIRD_PARTY_NOTICES.md",
      sourcePath: "THIRD_PARTY_NOTICES.md",
    },
    {
      packagePath: "THIRD_PARTY_LICENSES/EMSCRIPTEN-MIT-AND-UIUC-NCSA.txt",
      sourcePath: "THIRD_PARTY_LICENSES/EMSCRIPTEN-MIT-AND-UIUC-NCSA.txt",
    },
    {
      packagePath: "THIRD_PARTY_LICENSES/LAME-3.100-LGPL-2.0-or-later.txt",
      sourcePath: "THIRD_PARTY_LICENSES/LAME-3.100-LGPL-2.0-or-later.txt",
    },
    {
      packagePath: "THIRD_PARTY_LICENSES/LIBFLAC-XIPH-BSD.txt",
      sourcePath: "THIRD_PARTY_LICENSES/LIBFLAC-XIPH-BSD.txt",
    },
    {
      packagePath:
        "THIRD_PARTY_LICENSES/LIBOPUSENC-LIBOPUS-LIBOGG-XIPH-BSD.txt",
      sourcePath: "THIRD_PARTY_LICENSES/LIBOPUSENC-LIBOPUS-LIBOGG-XIPH-BSD.txt",
    },
    {
      packagePath: "THIRD_PARTY_LICENSES/LIBSAMPLERATE-BSD-2-CLAUSE.txt",
      sourcePath: "THIRD_PARTY_LICENSES/LIBSAMPLERATE-BSD-2-CLAUSE.txt",
    },
    {
      packagePath: "THIRD_PARTY_LICENSES/MEDIABUNNY-MPL-2.0.txt",
      sourcePath: "THIRD_PARTY_LICENSES/MEDIABUNNY-MPL-2.0.txt",
    },
    {
      packagePath: "codec-build/aac/LICENSE.BRIDGE-MPL-2.0.txt",
      sourcePath: "codec-build/aac/LICENSE.BRIDGE-MPL-2.0.txt",
    },
    {
      packagePath: "codec-build/aac/LICENSE.FFMPEG-LGPL-2.1.txt",
      sourcePath: "codec-build/aac/LICENSE.FFMPEG-LGPL-2.1.txt",
    },
  ].map(Object.freeze),
);

export const CODEC_ASSET_PACKAGE_FILES = Object.freeze([
  "LICENSE.md",
  "LICENSE.POLYFORM.md",
  "README.md",
  "THIRD_PARTY_LICENSES",
  "THIRD_PARTY_NOTICES.md",
  "codec-build/aac/LICENSE.BRIDGE-MPL-2.0.txt",
  "codec-build/aac/LICENSE.FFMPEG-LGPL-2.1.txt",
  "manifest.json",
  "wasm",
]);

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
