import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import webpack from "webpack";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

test("Webpack bundles the consumer package without a colocated AAC WASM file", async (context) => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), "audio-transcoder-webpack-"),
  );
  context.after(() => rm(fixtureRoot, { force: true, recursive: true }));

  const packagePath = join(
    fixtureRoot,
    "node_modules",
    "@echovisionlab",
    "audio-transcoder",
  );
  await mkdir(dirname(packagePath), { recursive: true });
  await symlink(repositoryRoot, packagePath, "dir");
  await writeFile(
    join(fixtureRoot, "entry.mjs"),
    [
      "import { createAudioTranscoderStreamWorkerPool } from '@echovisionlab/audio-transcoder';",
      "globalThis.audioTranscoderConsumer = createAudioTranscoderStreamWorkerPool;",
    ].join("\n"),
  );

  const stats = await bundleWithWebpack({
    context: fixtureRoot,
    devtool: false,
    entry: "./entry.mjs",
    mode: "development",
    output: {
      clean: true,
      filename: "consumer.js",
      path: join(fixtureRoot, "bundle"),
    },
    target: "web",
  });
  const errors = stats.toJson({ all: false, errors: true }).errors ?? [];
  assert.equal(
    stats.hasErrors(),
    false,
    errors.map((error) => error.message).join("\n"),
  );

  const assets = stats.toJson({ all: false, assets: true }).assets ?? [];
  assert.equal(
    assets.some(({ name }) => name.endsWith(".wasm")),
    false,
    `Unexpected package-bundled WASM asset: ${assets.map(({ name }) => name).join(", ")}`,
  );
  const bundleSources = await Promise.all(
    assets
      .filter(({ name }) => name.endsWith(".js"))
      .map(({ name }) => readFile(join(fixtureRoot, "bundle", name), "utf8")),
  );
  assert.doesNotMatch(bundleSources.join("\n"), /aac\.generated\.wasm/u);
});

function bundleWithWebpack(configuration) {
  return new Promise((resolve, reject) => {
    const compiler = webpack(configuration);
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error !== null) {
          reject(error);
          return;
        }
        if (closeError !== null) {
          reject(closeError);
          return;
        }
        if (stats === undefined) {
          reject(new Error("Webpack completed without compilation stats."));
          return;
        }
        resolve(stats);
      });
    });
  });
}
