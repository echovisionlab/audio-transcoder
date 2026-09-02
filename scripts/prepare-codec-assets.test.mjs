import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

import {
  DEFAULT_CODEC_ASSET_ABI_VERSION,
  DEFAULT_CODEC_ASSET_VERSION,
  prepareCodecAssets,
} from "./prepare-codec-assets.mjs";

const EXPECTED_ASSET_IDS = [
  "aac",
  "flac",
  "mp3",
  "ogg-opus",
  "resampler-fast",
  "resampler-balanced",
  "resampler-best",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("extracts deterministic, valid raw WASM assets and a matching manifest", async (context) => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "audio-transcoder-codec-assets-"),
  );
  context.after(async () => {
    await rm(outputDirectory, { recursive: true, force: true });
  });

  const firstManifest = await prepareCodecAssets({ outputDirectory });
  const firstManifestBytes = await readFile(
    resolve(outputDirectory, "manifest.json"),
  );

  assert.equal(firstManifest.schemaVersion, 1);
  assert.equal(firstManifest.version, DEFAULT_CODEC_ASSET_VERSION);
  assert.equal(firstManifest.abiVersion, DEFAULT_CODEC_ASSET_ABI_VERSION);
  assert.deepEqual(Object.keys(firstManifest.assets), EXPECTED_ASSET_IDS);

  for (const id of EXPECTED_ASSET_IDS) {
    const asset = firstManifest.assets[id];
    const path = resolve(outputDirectory, asset.path);
    assert.ok(path.startsWith(`${resolve(outputDirectory)}${sep}`));

    const bytes = await readFile(path);
    assert.equal(bytes.byteLength, asset.bytes);
    assert.equal(sha256(bytes), asset.sha256);
    assert.equal(WebAssembly.validate(bytes), true);
  }

  const secondManifest = await prepareCodecAssets({ outputDirectory });
  const secondManifestBytes = await readFile(
    resolve(outputDirectory, "manifest.json"),
  );
  assert.deepEqual(secondManifest, firstManifest);
  assert.deepEqual(secondManifestBytes, firstManifestBytes);
});
