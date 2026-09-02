import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const containsLargeBase64Literal = (source) =>
  /['"`][A-Za-z0-9+/]{1024,}={0,2}['"`]/u.test(source);
const execFileAsync = promisify(execFile);
const repositoryRootUrl = new URL("../", import.meta.url);
const repositoryRootPath = fileURLToPath(repositoryRootUrl);
const verificationStartedAt = performance.now();

const packageJsonUrl = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8"));
const releasePleaseConfig = JSON.parse(
  await readFile(
    new URL("../release-please-config.json", import.meta.url),
    "utf8",
  ),
);
const releaseWorkflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const licenseText = await readFile(
  new URL("../LICENSE.md", import.meta.url),
  "utf8",
);
const thirdPartyText = await readFile(
  new URL("../THIRD_PARTY_NOTICES.md", import.meta.url),
  "utf8",
);
const aacBuildManifest = JSON.parse(
  await readFile(
    new URL("../codec-build/aac/manifest.json", import.meta.url),
    "utf8",
  ),
);
const flacBuildManifest = JSON.parse(
  await readFile(
    new URL("../codec-build/flac/manifest.json", import.meta.url),
    "utf8",
  ),
);
const mp3BuildManifest = JSON.parse(
  await readFile(
    new URL("../codec-build/mp3/manifest.json", import.meta.url),
    "utf8",
  ),
);
const codecAssetManifest = JSON.parse(
  await readFile(
    new URL("../codec-assets/manifest.json", import.meta.url),
    "utf8",
  ),
);
const aacBuildReadme = await readFile(
  new URL("../codec-build/aac/README.md", import.meta.url),
  "utf8",
);
const aacBuildScript = await readFile(
  new URL("../codec-build/aac/build.sh", import.meta.url),
  "utf8",
);
const aacBridgeSource = await readFile(
  new URL("../codec-build/aac/bridge.c", import.meta.url),
  "utf8",
);
const aacSourceArtifact = await readFile(
  new URL("../src/stream/runtime/aac.generated.mjs", import.meta.url),
);
const aacBuiltArtifact = await readFile(
  new URL("../dist/stream/runtime/aac.generated.mjs", import.meta.url),
);
const aacSourceGlue = aacSourceArtifact.toString("utf8");
const aacBuiltGlue = aacBuiltArtifact.toString("utf8");
const oggOpusBuildScript = await readFile(
  new URL("../scripts/ogg-opus-build-wasm.sh", import.meta.url),
  "utf8",
);
const oggOpusProvenance = await readFile(
  new URL("../vendor/ogg-opus/ogg-opus-PROVENANCE.md", import.meta.url),
  "utf8",
);
const resamplerProvenance = await readFile(
  new URL("../vendor/resampler/libsamplerate-PROVENANCE.md", import.meta.url),
  "utf8",
);
const resamplerBuildScript = await readFile(
  new URL("../scripts/resampler-build-wasm.sh", import.meta.url),
  "utf8",
);
const thirdPartyLicenseFiles = [
  "EMSCRIPTEN-MIT-AND-UIUC-NCSA.txt",
  "LAME-3.100-LGPL-2.0-or-later.txt",
  "LIBFLAC-XIPH-BSD.txt",
  "LIBOPUSENC-LIBOPUS-LIBOGG-XIPH-BSD.txt",
  "LIBSAMPLERATE-BSD-2-CLAUSE.txt",
  "MEDIABUNNY-MPL-2.0.txt",
];
const publicApi = await import("../dist/index.js");

if (
  packageJson.author !== "Echo Vision Lab" ||
  codecAssetManifest.version !== packageJson.version ||
  packageJson.license !== "PolyForm-Noncommercial-1.0.0" ||
  !licenseText.startsWith(
    "Required Notice: Copyright 2026 Echo Vision Lab. All rights reserved.",
  ) ||
  !licenseText.includes("# PolyForm Noncommercial License 1.0.0")
) {
  throw new Error("Package ownership and license metadata must agree");
}

const requiredNoticeText = [
  "summary is not legal advice",
  "MPL-2.0",
  "794b84884f1e23cb6241689b3563190d138bbd9a",
  "LAME 3.100",
  "LGPL-2.0-or-later",
  "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e",
  "lame-3.100.tar.gz",
  "mpglib/libmpgdecoder.la",
  "3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c",
  "COPYING.Xiph",
  "FFmpeg 8.1.2",
  "LGPL-2.1-or-later",
  "38b88335f99e76ed89ff3c93f877fdefce736c13",
  "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c",
  aacBuildManifest.artifact.sha256,
  aacBuildManifest.wasmArtifact.sha256,
  "codec-build/aac/",
  "codec-build/aac/LICENSE.FFMPEG-LGPL-2.1.txt",
  "codec-build/aac/LICENSE.BRIDGE-MPL-2.0.txt",
  "Emscripten compiler toolchains",
  "Emscripten `5.0.7`",
  "263db4cffa6f9fc2ec514a70abac81362ea41849",
  "emscripten/emsdk@sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c",
  "Emscripten `4.0.20`",
  "e4fe26ef59168ff44f4c23c466e497bf60b3411e",
  "6913738ec5371a88c4af5a80db0ab42bad3de681",
  "c387d7a7e9537d0041d2c3ae71b7538cc978104e",
  "emscripten/emsdk@sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c",
  "THIRD_PARTY_LICENSES/EMSCRIPTEN-MIT-AND-UIUC-NCSA.txt",
  "libopusenc 0.3",
  "f616d3aff9b2034547894ccb8ab56c36cf1a4acb0d922c5d7119f97bbe58642c",
  "libopus 1.6.1",
  "6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1",
  "libogg 1.3.6",
  "5c8253428e181840cd20d41f3ca16557a9cc04bad4a3d04cce84808677fa1061",
  "vendor/ogg-opus/ogg-opus-PROVENANCE.md",
  "aee38d0bc797d0d1a3774ef574af1d5d248d2398",
  "deefc369f627b256724c4785bf32de5a839d8672f573aa17b1c89d6974dee3b3",
  "vendor/resampler/libsamplerate-PROVENANCE.md",
  flacBuildManifest.artifact.sha256,
  flacBuildManifest.libflac.archiveSha256,
  "codec-build/flac/",
  mp3BuildManifest.artifact.sha256,
  "codec-build/mp3/",
  "47d03b079057d17bbefcf3b17ea92fc2b0a6ba027b5ea13154b4e2f35177b7d0",
  "d68f10254f7b694990092943930e43bc4fa9a2f9775da452490764a062112f1c",
  "2c2bf7a58a90af6c8dcb76a98dc90a042cec538e326ae67f6d69aa907d9f93a0",
  "https://github.com/Vanilagy/mediabunny/tree/018c2ca67b728610e61fce23a2bdd23c8a2126c6",
  "https://github.com/Vanilagy/mediabunny/tree/794b84884f1e23cb6241689b3563190d138bbd9a/packages/mp3-encoder",
  "https://github.com/Vanilagy/mediabunny/tree/794b84884f1e23cb6241689b3563190d138bbd9a/packages/flac-encoder",
  "https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz",
  "https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/mp3-encoder/README.md#building-and-development",
  "https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/mp3-encoder/src/lame-bridge.c",
  "https://github.com/xiph/flac/tree/3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c",
  "https://github.com/xiph/flac/blob/3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c/COPYING.Xiph",
  "https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/flac-encoder/README.md#building-and-development",
  "https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/flac-encoder/src/bridge.c",
  "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz",
  "https://github.com/emscripten-core/emscripten",
  "https://github.com/emscripten-core/emsdk",
  "https://downloads.xiph.org/releases/opus/libopusenc-0.3.tar.gz",
  "https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz",
  "https://downloads.xiph.org/releases/ogg/libogg-1.3.6.tar.xz",
  "https://github.com/libsndfile/libsamplerate/tree/aee38d0bc797d0d1a3774ef574af1d5d248d2398",
  "https://github.com/libsndfile/libsamplerate/blob/aee38d0bc797d0d1a3774ef574af1d5d248d2398/COPYING",
  ...thirdPartyLicenseFiles.map(
    (fileName) => `THIRD_PARTY_LICENSES/${fileName}`,
  ),
];

const requiredPackageFileEntries = [
  "LICENSE.md",
  "THIRD_PARTY_LICENSES",
  "THIRD_PARTY_NOTICES.md",
  ...["aac", "flac", "mp3"].flatMap((codec) => [
    `codec-build/${codec}/README.md`,
    `codec-build/${codec}/bridge.c`,
    `codec-build/${codec}/build.sh`,
    `codec-build/${codec}/manifest.json`,
    `codec-build/${codec}/verify.mjs`,
  ]),
  "codec-build/aac/patch-generated-glue.mjs",
  "codec-build/aac/LICENSE.BRIDGE-MPL-2.0.txt",
  "codec-build/aac/LICENSE.FFMPEG-LGPL-2.1.txt",
  "scripts/ogg-opus-build-wasm.sh",
  "scripts/ogg-opus-embed-wasm.mjs",
  "scripts/codec-asset-package-contract.mjs",
  "scripts/resampler-build-wasm.sh",
  "scripts/resampler-embed-wasm.mjs",
  "scripts/verify-release-state.mjs",
  "scripts/verify-published-codec-assets.mjs",
  "vendor",
];
const forbiddenDependencies = [
  "@alexanderolsen/libsamplerate-js",
  "@mediabunny/flac-encoder",
  "@mediabunny/mp3-encoder",
];
const dependencySections = [
  packageJson.dependencies,
  packageJson.devDependencies,
  packageJson.optionalDependencies,
  packageJson.peerDependencies,
];
const normalizedThirdPartyText = thirdPartyText.replace(/\s+/gu, " ");
const missingRequiredNoticeText = requiredNoticeText.find(
  (required) =>
    !normalizedThirdPartyText.toLowerCase().includes(required.toLowerCase()),
);

if (
  packageJson.dependencies?.mediabunny !== "1.55.1" ||
  dependencySections.some((dependencies) =>
    forbiddenDependencies.some(
      (dependency) => dependencies?.[dependency] !== undefined,
    ),
  ) ||
  requiredPackageFileEntries.some((path) => !packageJson.files?.includes(path))
) {
  throw new Error("Package dependencies and source-material files must agree");
}

const trustedPublishSteps = [
  "node ./scripts/verify-release-state.mjs",
  "node ./scripts/verify-published-codec-assets.mjs",
  "npm publish --access public --provenance",
];
const trustedPublishPositions = trustedPublishSteps.map((step) =>
  releaseWorkflow.indexOf(step),
);
const trustedPublishOrderIsValid = trustedPublishPositions.every(
  (position, index) =>
    position >= 0 &&
    (index === 0 || position > trustedPublishPositions[index - 1]),
);

if (
  packageJson.scripts?.prepublishOnly !== undefined ||
  packageJson.scripts?.["codec-assets:verify-published"] !==
    "node ./scripts/verify-published-codec-assets.mjs" ||
  !releaseWorkflow.includes("id-token: write") ||
  !releaseWorkflow.includes("runs-on: ubuntu-latest") ||
  !releaseWorkflow.includes(
    "needs.release-please.outputs.release_created == 'true'",
  ) ||
  !releaseWorkflow.includes(
    "ref: ${{ needs.release-please.outputs.tag_name }}",
  ) ||
  releaseWorkflow.includes("workflow_dispatch") ||
  releaseWorkflow.includes("@echovisionlab/audio-transcoder-codecs") ||
  releaseWorkflow.includes("NODE_AUTH_TOKEN") ||
  releaseWorkflow.includes("NPM_TOKEN") ||
  !releasePleaseConfig.packages?.["."]?.["extra-files"]?.some(
    (entry) =>
      entry?.type === "json" &&
      entry.path === "codec-assets/manifest.json" &&
      entry.jsonpath === "$.version",
  ) ||
  !trustedPublishOrderIsValid
) {
  throw new Error(
    "Release automation must verify the exact GitHub-tag assets before publishing the engine through npm OIDC",
  );
}

if (
  aacBuildManifest.schemaVersion !== 1 ||
  aacBuildManifest.artifact?.path !== "src/stream/runtime/aac.generated.mjs" ||
  aacBuildManifest.artifact?.sizeBytes !== aacSourceArtifact.byteLength ||
  aacBuildManifest.artifact?.sha256 !== sha256(aacSourceArtifact) ||
  sha256(aacBuiltArtifact) !== aacBuildManifest.artifact.sha256 ||
  aacSourceArtifact.byteLength > 64 * 1024 ||
  containsLargeBase64Literal(aacSourceGlue) ||
  containsLargeBase64Literal(aacBuiltGlue) ||
  !aacSourceGlue.includes("instantiateWasm") ||
  aacSourceGlue.includes("aac.generated.wasm") ||
  aacBuiltGlue.includes("aac.generated.wasm") ||
  !aacSourceGlue.includes("runtime asset loader through instantiateWasm") ||
  aacBuildManifest.wasmArtifact?.path !== "codec-build/aac/aac.wasm" ||
  aacBuildManifest.wasmArtifact?.sha256 !==
    codecAssetManifest.assets?.aac?.sha256 ||
  aacBuildManifest.wasmArtifact?.sizeBytes !==
    codecAssetManifest.assets?.aac?.bytes ||
  aacBuildManifest.ffmpeg?.archiveSha256 !==
    "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c" ||
  aacBuildManifest.ffmpeg?.commit !==
    "38b88335f99e76ed89ff3c93f877fdefce736c13" ||
  aacBuildManifest.ffmpeg?.license !== "LGPL-2.1-or-later" ||
  aacBuildManifest.bridge?.license !== "MPL-2.0" ||
  aacBuildManifest.toolchain?.emscriptenVersion !== "5.0.7" ||
  aacBuildManifest.toolchain?.emccCommit !==
    "263db4cffa6f9fc2ec514a70abac81362ea41849" ||
  aacBuildManifest.toolchain?.image !==
    "emscripten/emsdk@sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c" ||
  !aacBuildReadme.includes("modify the LGPL-covered FFmpeg code and relink") ||
  !aacBuildScript.includes("--disable-gpl") ||
  !aacBuildScript.includes("--disable-nonfree") ||
  !aacBuildScript.includes("--enable-encoder=aac") ||
  !aacBridgeSource.includes("Mozilla Public") ||
  !aacBridgeSource.includes("License, v. 2.0") ||
  !aacBuildManifest.bridge?.licensePath ||
  !aacBuildManifest.ffmpeg?.licensePath
) {
  throw new Error("Bundled AAC artifact and corresponding source must agree");
}

const expectedOggOpusHash =
  "ec1d29d65a7e1957e9551e55cc1a74d3679dc8d4c26df4287350590cc1e7734a";
const expectedOggOpusSha256Pins = [
  "5c8253428e181840cd20d41f3ca16557a9cc04bad4a3d04cce84808677fa1061",
  "6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1",
  "f616d3aff9b2034547894ccb8ab56c36cf1a4acb0d922c5d7119f97bbe58642c",
].sort();
const expectedOggOpusCommitPins = [
  "6913738ec5371a88c4af5a80db0ab42bad3de681",
  "c387d7a7e9537d0041d2c3ae71b7538cc978104e",
  "e4fe26ef59168ff44f4c23c466e497bf60b3411e",
].sort();
const collectUniquePins = (source, length) =>
  [
    ...new Set(
      source.match(
        new RegExp(`(?<![0-9a-f])[0-9a-f]{${length}}(?![0-9a-f])`, "gu"),
      ) ?? [],
    ),
  ].sort();
const oggBuildAssignments = Object.fromEntries(
  oggOpusBuildScript
    .split("\n")
    .map((line) => line.match(/^([A-Z0-9_]+)=([^\s]+)$/u))
    .filter((match) => match !== null)
    .map((match) => [match[1], match[2]]),
);
if (
  JSON.stringify(collectUniquePins(oggOpusProvenance, 64)) !==
    JSON.stringify(expectedOggOpusSha256Pins) ||
  JSON.stringify(collectUniquePins(oggOpusProvenance, 40)) !==
    JSON.stringify(expectedOggOpusCommitPins) ||
  !/Emscripten compiler\s+\|\s+tag `4\.0\.20`/u.test(oggOpusProvenance) ||
  codecAssetManifest.assets?.["ogg-opus"]?.sha256 !== expectedOggOpusHash ||
  oggBuildAssignments.EMSCRIPTEN_VERSION !== "4.0.20" ||
  oggBuildAssignments.EMSDK_COMMIT !==
    "e4fe26ef59168ff44f4c23c466e497bf60b3411e" ||
  oggBuildAssignments.LIBOPUSENC_SHA256 !==
    "f616d3aff9b2034547894ccb8ab56c36cf1a4acb0d922c5d7119f97bbe58642c" ||
  oggBuildAssignments.LIBOPUS_SHA256 !==
    "6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1" ||
  oggBuildAssignments.LIBOGG_SHA256 !==
    "5c8253428e181840cd20d41f3ca16557a9cc04bad4a3d04cce84808677fa1061" ||
  !oggOpusBuildScript.includes('git -C "$OGG_OPUS_EMSDK_ROOT" rev-parse HEAD')
) {
  throw new Error("Bundled Ogg Opus provenance or toolchain pins drifted");
}

const expectedResamplerHashes = {
  best: "47d03b079057d17bbefcf3b17ea92fc2b0a6ba027b5ea13154b4e2f35177b7d0",
  balanced: "d68f10254f7b694990092943930e43bc4fa9a2f9775da452490764a062112f1c",
  fast: "2c2bf7a58a90af6c8dcb76a98dc90a042cec538e326ae67f6d69aa907d9f93a0",
};
if (
  Object.entries(expectedResamplerHashes).some(
    ([quality, expectedSha256]) =>
      codecAssetManifest.assets?.[`resampler-${quality}`]?.sha256 !==
      expectedSha256,
  ) ||
  !resamplerProvenance.includes("aee38d0bc797d0d1a3774ef574af1d5d248d2398") ||
  !resamplerProvenance.includes(
    "deefc369f627b256724c4785bf32de5a839d8672f573aa17b1c89d6974dee3b3",
  ) ||
  !resamplerProvenance.includes("Emscripten 5.0.7 image manifest") ||
  !resamplerProvenance.includes(
    "emscripten/emsdk@sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c",
  ) ||
  !resamplerProvenance.includes("263db4cffa6f9fc2ec514a70abac81362ea41849") ||
  !resamplerProvenance.includes("complete coefficient table") ||
  !resamplerProvenance.includes("scripts/resampler-build-wasm.sh") ||
  !resamplerBuildScript.includes("EMSCRIPTEN_VERSION=5.0.7") ||
  !resamplerBuildScript.includes(
    "EMSCRIPTEN_IMAGE='emscripten/emsdk@sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c'",
  ) ||
  !resamplerBuildScript.includes("--platform linux/arm64/v8")
) {
  throw new Error("Bundled resampler provenance is incomplete");
}

const expectedCodecAssetIds = [
  "aac",
  "flac",
  "mp3",
  "ogg-opus",
  "resampler-fast",
  "resampler-balanced",
  "resampler-best",
];
if (
  codecAssetManifest.schemaVersion !== 1 ||
  codecAssetManifest.abiVersion !== 1 ||
  JSON.stringify(Object.keys(codecAssetManifest.assets ?? {})) !==
    JSON.stringify(expectedCodecAssetIds)
) {
  throw new Error("Codec asset build manifest identity or ABI drifted");
}

for (const assetId of expectedCodecAssetIds) {
  const descriptor = codecAssetManifest.assets[assetId];
  const bytes = await readFile(
    new URL(`../codec-assets/${descriptor.path}`, import.meta.url),
  );
  if (
    descriptor.bytes !== bytes.byteLength ||
    descriptor.sha256 !== sha256(bytes) ||
    !WebAssembly.validate(bytes)
  ) {
    throw new Error(
      `Codec asset build manifest has an invalid ${assetId} entry`,
    );
  }
}

const rawCodecBuilds = {
  aac: {
    artifact: aacBuildManifest.wasmArtifact,
    manifest: aacBuildManifest,
  },
  flac: {
    artifact: flacBuildManifest.artifact,
    manifest: flacBuildManifest,
  },
  mp3: {
    artifact: mp3BuildManifest.artifact,
    manifest: mp3BuildManifest,
  },
};
for (const [codec, { artifact, manifest }] of Object.entries(rawCodecBuilds)) {
  const asset = codecAssetManifest.assets[codec];
  const bridge = await readFile(
    new URL(`../${manifest.bridge.path}`, import.meta.url),
  );
  if (
    manifest.schemaVersion !== 1 ||
    artifact.sha256 !== asset.sha256 ||
    artifact.sizeBytes !== asset.bytes ||
    sha256(bridge) !== manifest.bridge.sha256 ||
    manifest.toolchain?.emscriptenVersion !== "5.0.7" ||
    manifest.toolchain?.emccCommit !==
      "263db4cffa6f9fc2ec514a70abac81362ea41849"
  ) {
    throw new Error(`${codec} source, relink, and asset manifests drifted`);
  }
}

if (
  flacBuildManifest.abiVersion !== 1 ||
  flacBuildManifest.bridge?.sourceCommit !==
    "794b84884f1e23cb6241689b3563190d138bbd9a" ||
  flacBuildManifest.bridge?.sourcePackage !==
    "@mediabunny/flac-encoder@1.50.9" ||
  flacBuildManifest.libflac?.commit !==
    "3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c" ||
  flacBuildManifest.libflac?.archiveSha256 !==
    "4ace54db53e274f6c73999a644b0a11410f67e5c35c06e4aaa8e5457bbf59f9d" ||
  mp3BuildManifest.abiVersion !== 1 ||
  mp3BuildManifest.bridge?.sourcePackageGitHead !==
    "794b84884f1e23cb6241689b3563190d138bbd9a" ||
  mp3BuildManifest.lame?.version !== "3.100" ||
  mp3BuildManifest.lame?.archiveSha256 !==
    "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e" ||
  mp3BuildManifest.runtime?.nestedWorker !== false
) {
  throw new Error("Raw FLAC or MP3 provenance manifest drifted");
}

for (const fileName of thirdPartyLicenseFiles) {
  await readFile(
    new URL(`../THIRD_PARTY_LICENSES/${fileName}`, import.meta.url),
  );
}

if (
  packageJson.exports?.["./worker"]?.import !== "./dist/worker/entry.js" ||
  packageJson.exports?.["./stream-worker"]?.import !==
    "./dist/stream/worker-entry.js" ||
  !packageJson.sideEffects?.includes("./dist/worker/entry.js") ||
  !packageJson.sideEffects?.includes("./dist/stream/worker-entry.js")
) {
  throw new Error("Worker exports and side-effect metadata must agree");
}

for (const mapPath of ["../dist/index.js.map"]) {
  const sourceMap = JSON.parse(
    await readFile(new URL(mapPath, import.meta.url), "utf8"),
  );
  if (
    !Array.isArray(sourceMap.sources) ||
    !Array.isArray(sourceMap.sourcesContent) ||
    sourceMap.sourcesContent.length !== sourceMap.sources.length ||
    sourceMap.sourcesContent.some((source) => typeof source !== "string")
  ) {
    throw new Error(`${mapPath} must embed every referenced source`);
  }
}

const { stdout: packJson } = await execFileAsync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    cwd: repositoryRootPath,
    maxBuffer: 16 * 1024 * 1024,
  },
);
const [packResult] = JSON.parse(packJson);
const maximumPackedBytes = 512 * 1024;
const maximumUnpackedBytes = 2 * 1024 * 1024;
if (
  packResult === undefined ||
  !Array.isArray(packResult.files) ||
  !Number.isSafeInteger(packResult.size) ||
  !Number.isSafeInteger(packResult.unpackedSize) ||
  packResult.size > maximumPackedBytes ||
  packResult.unpackedSize > maximumUnpackedBytes
) {
  throw new Error(
    `Root package must remain below ${maximumPackedBytes} packed and ${maximumUnpackedBytes} unpacked bytes`,
  );
}
const packedPaths = packResult.files.map(({ path }) => path);
const packedPathSet = new Set(packedPaths);
const forbiddenGeneratedRuntimeModule =
  /(?:^|\/)(?:ogg-opus-wasm-binary|resampler-wasm-(?:best|balanced|fast)-binary)\.(?:d\.ts|js|mjs|ts)(?:\.map)?$/u;
const forbiddenPackedPath = packedPaths.find(
  (path) =>
    path.endsWith(".wasm") || forbiddenGeneratedRuntimeModule.test(path),
);
if (forbiddenPackedPath !== undefined) {
  throw new Error(
    `Root package must not contain raw or generated WASM payloads: ${forbiddenPackedPath}`,
  );
}

for (const path of packedPaths) {
  const bytes = await readFile(new URL(`../${path}`, import.meta.url));
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d
  ) {
    throw new Error(`Root package contains raw WebAssembly bytes: ${path}`);
  }
  const source = bytes.toString("utf8");
  if (
    containsLargeBase64Literal(source) ||
    /(?:base64,|['"`])AGFzbQ/u.test(source)
  ) {
    throw new Error(`Root package contains an inlined binary payload: ${path}`);
  }
}

const requiredPackedEvidence = [
  "dist/stream/runtime/aac.generated.mjs",
  ...["aac", "flac", "mp3"].flatMap((codec) => [
    `codec-build/${codec}/README.md`,
    `codec-build/${codec}/bridge.c`,
    `codec-build/${codec}/build.sh`,
    `codec-build/${codec}/manifest.json`,
    `codec-build/${codec}/verify.mjs`,
  ]),
  "codec-build/aac/LICENSE.BRIDGE-MPL-2.0.txt",
  "codec-build/aac/LICENSE.FFMPEG-LGPL-2.1.txt",
  "scripts/codec-asset-package-contract.mjs",
  "scripts/verify-published-codec-assets.mjs",
  ...thirdPartyLicenseFiles.map(
    (fileName) => `THIRD_PARTY_LICENSES/${fileName}`,
  ),
  "vendor/ogg-opus/ogg-opus-PROVENANCE.md",
  "vendor/ogg-opus/ogg-opus-libopusenc-bridge.c",
  "vendor/resampler/libsamplerate-PROVENANCE.md",
  "vendor/resampler/libsamplerate-bridge.c",
];
const missingPackedEvidence = requiredPackedEvidence.find(
  (path) => !packedPathSet.has(path),
);
if (missingPackedEvidence !== undefined) {
  throw new Error(
    `Root package is missing source, relink, or license evidence: ${missingPackedEvidence}`,
  );
}

if (
  publicApi.AUDIO_TRANSCODER_CODEC_ASSET_REPOSITORY !==
    "echovisionlab/audio-transcoder" ||
  publicApi.AUDIO_TRANSCODER_CODEC_ASSET_BASE_PATH !== "codec-assets" ||
  publicApi.AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST?.version !==
    packageJson.version ||
  publicApi.AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST?.schemaVersion !== 1 ||
  publicApi.AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST?.abiVersion !== 1 ||
  JSON.stringify(publicApi.AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST?.assets) !==
    JSON.stringify(codecAssetManifest.assets) ||
  !Object.isFrozen(publicApi.AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST) ||
  !Object.isFrozen(publicApi.AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST?.assets) ||
  !Object.values(
    publicApi.AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST?.assets ?? {},
  ).every(Object.isFrozen) ||
  typeof publicApi.createAudioTranscoderCodecAssetProvider !== "function" ||
  typeof publicApi.createAudioTranscoderJsDelivrAssetSource !== "function" ||
  typeof publicApi.createSelfHostedRuntimeAssetSource !== "function"
) {
  throw new Error("Built package does not expose its version-locked asset API");
}

const jsDelivrSource = publicApi.createAudioTranscoderJsDelivrAssetSource();
if (
  jsDelivrSource.kind !== "jsdelivr-github" ||
  jsDelivrSource.repository !== "echovisionlab/audio-transcoder" ||
  jsDelivrSource.tag !== `v${packageJson.version}` ||
  jsDelivrSource.basePath !== "codec-assets"
) {
  throw new Error("Built package exposed an unpinned jsDelivr asset source");
}

const selfHostedSource = publicApi.createSelfHostedRuntimeAssetSource(
  "https://assets.example.test/audio/",
);
const fastResamplerBytes = await readFile(
  new URL("../codec-assets/wasm/resampler-fast.wasm", import.meta.url),
);
const assetStates = [];
const assetProvider = publicApi.createAudioTranscoderCodecAssetProvider({
  source: selfHostedSource,
  async fetch(input) {
    if (
      String(input) !==
      "https://assets.example.test/audio/wasm/resampler-fast.wasm"
    ) {
      throw new Error(`Unexpected package asset request: ${String(input)}`);
    }
    return new Response(fastResamplerBytes, {
      headers: { "content-length": String(fastResamplerBytes.byteLength) },
    });
  },
});
const unsubscribeAssetState = assetProvider.subscribe((state) => {
  assetStates.push(state.phase);
});
if (
  assetProvider.abiVersion !== 1 ||
  assetProvider.getState("resampler-fast").phase !== "idle" ||
  assetProvider.resolveUrl("resampler-fast") !==
    "https://assets.example.test/audio/wasm/resampler-fast.wasm"
) {
  throw new Error(
    "Built package exposed an invalid self-hosted asset provider",
  );
}
const loadedFastResampler = await assetProvider.load("resampler-fast");
unsubscribeAssetState();
if (
  sha256(loadedFastResampler) !==
    codecAssetManifest.assets["resampler-fast"].sha256 ||
  assetProvider.getState("resampler-fast").phase !== "ready" ||
  !assetStates.includes("downloading") ||
  !assetStates.includes("verifying") ||
  assetStates.at(-1) !== "ready"
) {
  throw new Error("Built package asset provider failed download verification");
}

const info = publicApi.getEngineInfo();

if (publicApi.getVersion() !== packageJson.version) {
  throw new Error("Built package version does not match package.json");
}

if (info.name !== packageJson.name || info.version !== packageJson.version) {
  throw new Error("Built engine information does not match package.json");
}

if (!Object.isFrozen(info)) {
  throw new Error("Built engine information must be immutable");
}

const progressEvents = [];
const encoded = await publicApi.audioTranscoder.encode(
  {
    channelData: [new Float32Array([-1, 0, 1])],
    sampleRate: 48_000,
  },
  "wav-pcm16",
  {
    onProgress(progress) {
      progressEvents.push(progress);
    },
  },
);
const inspection = publicApi.audioTranscoder.inspect({ data: encoded.data });

if (
  inspection.container !== "WAV" ||
  inspection.sampleRate !== 48_000 ||
  inspection.bitDepth !== 16 ||
  inspection.sourceEncoding?.kind !== "pcm" ||
  inspection.sourceEncoding.bitDepth !== 16 ||
  inspection.sourceEncoding.sampleFormat !== "integer" ||
  inspection.sourceEncoding.signedness !== "signed" ||
  inspection.sourceEncoding.endianness !== "little"
) {
  throw new Error("Built package failed the WAV encode and inspect smoke test");
}

if (
  progressEvents.length === 0 ||
  progressEvents[0].progress !== 0 ||
  progressEvents.at(-1).progress !== 1 ||
  progressEvents.some(
    ({ progress }) =>
      progress < 0 ||
      progress > 1 ||
      Math.round(progress * 1_000) / 1_000 !== progress,
  )
) {
  throw new Error("Built package exposed invalid progress values");
}

if (typeof publicApi.createAudioTranscoderWorkerEngine !== "function") {
  throw new Error("Built package does not export its Worker engine factory");
}

if (publicApi.AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES !== 64 * 1024 * 1024) {
  throw new Error(
    "Built package does not export its whole-buffer safety limit",
  );
}

const codecRuntime =
  publicApi.AUDIO_TRANSCODER_STREAM_CAPABILITIES?.codecRuntime;
const streamCapabilities = publicApi.AUDIO_TRANSCODER_STREAM_CAPABILITIES;
const expectedStreamPresets = [
  "wav-pcm16",
  "wav-pcm24",
  "wav-pcm32",
  "wav-float32",
  "aiff-pcm16",
  "aiff-pcm24",
  "aac-96kbps",
  "aac-128kbps",
  "aac-192kbps",
  "aac-256kbps",
  "ogg-opus-64kbps",
  "ogg-opus-96kbps",
  "ogg-opus-128kbps",
  "ogg-opus-192kbps",
  "mp3-128kbps",
  "mp3-192kbps",
  "mp3-256kbps",
  "mp3-320kbps",
  "flac-16bit",
  "flac-24bit",
];
const expectedMp3SampleRates = [
  ["mp3-128kbps", [16_000, 22_050, 24_000, 32_000, 44_100, 48_000]],
  ["mp3-192kbps", [32_000, 44_100, 48_000]],
  ["mp3-256kbps", [32_000, 44_100, 48_000]],
  ["mp3-320kbps", [32_000, 44_100, 48_000]],
];
const mp3OutputFormat = streamCapabilities.outputFormats.find(
  ({ id }) => id === "mp3",
);
const mp3SampleRateContractIsValid =
  mp3OutputFormat !== undefined &&
  JSON.stringify(
    mp3OutputFormat.presets.map(({ preset, target }) => [
      preset.id,
      target.sampleRate.kind === "discrete"
        ? [...target.sampleRate.values]
        : null,
    ]),
  ) === JSON.stringify(expectedMp3SampleRates);

if (
  typeof publicApi.createAudioTranscoderStreamEngine !== "function" ||
  typeof publicApi.createAudioTranscoderStreamWorkerEngine !== "function" ||
  typeof publicApi.exposeAudioTranscoderStreamWorker !== "function" ||
  typeof publicApi.createAudioTranscoderOutputSession !== "function" ||
  publicApi.AUDIO_TRANSCODER_OUTPUT_MEMORY_LIMIT_BYTES !== 128 * 1024 * 1024 ||
  typeof codecRuntime !== "object" ||
  codecRuntime === null ||
  !Array.isArray(codecRuntime.inputAdapters) ||
  streamCapabilities.outputPresets.map(({ id }) => id).join(",") !==
    expectedStreamPresets.join(",") ||
  streamCapabilities.outputFormats
    .map(
      ({ id, implementation, loading }) => `${id}:${implementation}:${loading}`,
    )
    .join(",") !==
    "wav:built-in:eager,aiff:built-in:eager,aac:runtime-asset:lazy,ogg:runtime-asset:lazy,mp3:runtime-asset:lazy,flac:runtime-asset:lazy" ||
  !mp3SampleRateContractIsValid ||
  streamCapabilities.inputFormats.length === 0 ||
  streamCapabilities.inputFormats.some(
    ({ extensionHints, mimeTypeHints }) =>
      !Object.isFrozen(extensionHints) || !Object.isFrozen(mimeTypeHints),
  ) ||
  codecRuntime.inputAdapters.join(",") !== "pcm,mediabunny" ||
  codecRuntime.encoderAdapter !== "mediabunny" ||
  codecRuntime.resamplerAdapter !== "libsamplerate-wasm" ||
  !Object.isFrozen(codecRuntime.inputAdapters) ||
  !Object.isFrozen(codecRuntime) ||
  streamCapabilities.limits.recommendedConcurrency !== 1 ||
  streamCapabilities.limits.maximumConcurrency !== 4 ||
  streamCapabilities.limits.queue.defaultMaximumQueued !== 8 ||
  streamCapabilities.limits.queue.maximumQueued !== 64 ||
  streamCapabilities.limits.sampleRate.resampling.maximum !== 192_000
) {
  throw new Error(
    "Built package exposed an invalid streaming capability matrix",
  );
}

if (
  typeof publicApi.getAudioStreamOutputEncodingOptions !== "function" ||
  typeof publicApi.getAudioStreamOutputParameters !== "function" ||
  typeof publicApi.resolveAudioStreamFormatTarget !== "function" ||
  publicApi.AUDIO_STREAM_SOURCE_SAMPLE_RATE !== "source"
) {
  throw new Error("Built package does not expose the semantic output resolver");
}

const resolvedAiffTarget = publicApi.resolveAudioStreamFormatTarget(
  {
    formatId: "aiff",
    parameters: { bitDepth: 24 },
    sampleRate: publicApi.AUDIO_STREAM_SOURCE_SAMPLE_RATE,
  },
  inspection,
);
if (
  resolvedAiffTarget.status !== "resolved" ||
  resolvedAiffTarget.preset.preset.id !== "aiff-pcm24" ||
  resolvedAiffTarget.probeTarget.channels !== 1 ||
  resolvedAiffTarget.probeTarget.sampleRate !== 48_000 ||
  resolvedAiffTarget.target.presetId !== "aiff-pcm24" ||
  "sampleRate" in resolvedAiffTarget.target
) {
  throw new Error("Built package failed the semantic AIFF target smoke test");
}

const inlineStreamEngine = publicApi.createAudioTranscoderStreamEngine();
if (
  inlineStreamEngine.getCapabilities() !== streamCapabilities ||
  typeof inlineStreamEngine.probeInputSupport !== "function"
) {
  throw new Error("Built package exposed an invalid direct stream engine");
}

const outputSession = publicApi.createAudioTranscoderOutputSession({
  memoryLimitBytes: 64,
  namespace: "package-smoke",
});
if ((await outputSession.getStorageMode()) !== "memory") {
  throw new Error(
    "Node package smoke expected the bounded memory output fallback",
  );
}
const pendingOutput = await outputSession.create();
const outputWriter = pendingOutput.stream.getWriter();
await outputWriter.write({
  data: new Uint8Array([0x64, 0x73, 0x75, 0x62]),
  position: 0,
  type: "write",
});
await outputWriter.close();
const outputArtifact = await pendingOutput.complete({
  mimeType: "application/octet-stream",
  name: "smoke.bin",
});
if (
  outputArtifact.size !== 4 ||
  outputArtifact.storage !== "memory" ||
  outputSession.getMemoryReservation().reservedBytes !== 4
) {
  throw new Error("Built package failed the bounded output-session smoke test");
}
await outputArtifact.dispose();
await outputSession.dispose();

const pool = publicApi.createAudioTranscoderWorkerPool();
const poolSnapshot = pool.getQueueSnapshot();
if (
  pool.getVersion() !== packageJson.version ||
  poolSnapshot.maxQueued !== 8 ||
  poolSnapshot.maxQueuedBytes !== 64 * 1024 * 1024 ||
  poolSnapshot.queuedBytes !== 0 ||
  poolSnapshot.workers !== 0
) {
  throw new Error("Built package failed the lazy Worker pool smoke test");
}
pool.terminate();

const streamPool = publicApi.createAudioTranscoderStreamWorkerPool({
  codecAssets: { source: selfHostedSource },
});
if (
  streamPool.getVersion() !== packageJson.version ||
  streamPool.getCapabilities() !==
    publicApi.AUDIO_TRANSCODER_STREAM_CAPABILITIES ||
  streamPool.getQueueSnapshot().workers !== 0
) {
  throw new Error(
    "Built package failed the lazy stream Worker pool smoke test",
  );
}
await streamPool.dispose();

const uncalledWorkerFactory = () => {
  throw new Error("A lazy package smoke test must not create a Worker");
};
const defaultEntryStreamPool = publicApi.createAudioTranscoderStreamWorkerPool({
  codecAssets: { source: selfHostedSource },
  workerFactory: uncalledWorkerFactory,
});
if (defaultEntryStreamPool.getCapabilities() !== streamCapabilities) {
  throw new Error("workerFactory alone must retain the default stream runtime");
}
await defaultEntryStreamPool.dispose();

const customRuntimeStreamPool = publicApi.createAudioTranscoderStreamWorkerPool(
  {
    capabilities: streamCapabilities,
    runtime: "custom",
    workerFactory: uncalledWorkerFactory,
  },
);
if (customRuntimeStreamPool.getCapabilities() !== streamCapabilities) {
  throw new Error("Custom stream runtime must expose its paired capabilities");
}
await customRuntimeStreamPool.dispose();

let rejectedUnpairedCapabilities = false;
try {
  publicApi.createAudioTranscoderStreamWorkerPool({
    capabilities: streamCapabilities,
  });
} catch (error) {
  rejectedUnpairedCapabilities = error?.code === "INVALID_CONFIGURATION";
}
if (!rejectedUnpairedCapabilities) {
  throw new Error("Unpaired custom stream capabilities must be rejected");
}

if (missingRequiredNoticeText !== undefined) {
  throw new Error(
    `Third-party notices are missing required evidence: ${missingRequiredNoticeText}`,
  );
}

console.log(
  `Verified thin root package (${packResult.size} packed bytes, ${packResult.unpackedSize} unpacked bytes) in ${Math.round(performance.now() - verificationStartedAt)} ms.`,
);
