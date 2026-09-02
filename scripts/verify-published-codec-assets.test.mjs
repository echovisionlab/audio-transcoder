import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AUDIO_TRANSCODER_CODEC_ASSET_BASE_PATH,
  AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
  AUDIO_TRANSCODER_CODEC_ASSET_REPOSITORY,
} from '../dist/index.js';
import { CODEC_ASSET_LEGAL_FILES } from './codec-asset-package-contract.mjs';
import { verifyPublishedCodecAssets } from './verify-published-codec-assets.mjs';

const repositoryBaseUrl =
  `https://cdn.jsdelivr.net/gh/${AUDIO_TRANSCODER_CODEC_ASSET_REPOSITORY}` +
  `@v${AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version}`;
const assetBaseUrl =
  `${repositoryBaseUrl}/${AUDIO_TRANSCODER_CODEC_ASSET_BASE_PATH}`;
const remotePackage = Object.freeze({
  name: '@echovisionlab/audio-transcoder',
  repository: Object.freeze({
    type: 'git',
    url: 'git+https://github.com/echovisionlab/audio-transcoder.git',
  }),
  version: AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version,
});
const runtimeAssetUrls = Object.values(
  AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets,
).map(({ path }) => `${assetBaseUrl}/${path}`);
const legalFileUrls = CODEC_ASSET_LEGAL_FILES.map(
  ({ sourcePath }) => `${repositoryBaseUrl}/${sourcePath}`,
);

test('verifies the exact release tag, manifest, raw WASM, and legal file presence', async () => {
  const requests = [];
  const verified = [];

  await verifyPublishedCodecAssets({
    fetchAsset: createFixtureFetch({
      onRequest(url) {
        requests.push(url);
      },
    }),
    log(message) {
      verified.push(message);
    },
  });

  assert.deepEqual(requests, [
    `${repositoryBaseUrl}/package.json`,
    `${assetBaseUrl}/manifest.json`,
    ...runtimeAssetUrls,
    ...legalFileUrls,
  ]);
  assert.equal(
    verified.length,
    runtimeAssetUrls.length + legalFileUrls.length,
  );
});

test('fails closed when the exact release tag is unavailable', async () => {
  await assert.rejects(
    verifyPublishedCodecAssets({
      fetchAsset: async () => new Response(null, { status: 404 }),
      log() {},
    }),
    /HTTP 404/u,
  );
});

test('fails closed when the release manifest differs from the engine', async () => {
  await assert.rejects(
    verifyPublishedCodecAssets({
      fetchAsset: createFixtureFetch({
        manifest: {
          ...AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
          abiVersion: AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.abiVersion + 1,
        },
      }),
      log() {},
    }),
    /manifest does not match/u,
  );
});

for (const [field, value, message] of [
  ['name', 'wrong-package', /package name does not match/u],
  ['version', '9.9.9', /package version does not match/u],
]) {
  test(`fails closed when release package ${field} differs`, async () => {
    await assert.rejects(
      verifyPublishedCodecAssets({
        fetchAsset: createFixtureFetch({
          packageJson: { ...remotePackage, [field]: value },
        }),
        log() {},
      }),
      message,
    );
  });
}

test('fails closed when the release repository differs', async () => {
  await assert.rejects(
    verifyPublishedCodecAssets({
      fetchAsset: createFixtureFetch({
        packageJson: {
          ...remotePackage,
          repository: { type: 'git', url: 'https://example.test/wrong.git' },
        },
      }),
      log() {},
    }),
    /repository does not match/u,
  );
});

for (const descriptor of CODEC_ASSET_LEGAL_FILES) {
  const targetUrl = `${repositoryBaseUrl}/${descriptor.sourcePath}`;
  test(`fails closed when ${descriptor.sourcePath} is missing`, async () => {
    await assert.rejects(
      verifyPublishedCodecAssets({
        fetchAsset: createFixtureFetch({
          override(url) {
            return url === targetUrl
              ? new Response(null, { status: 404 })
              : undefined;
          },
        }),
        log() {},
      }),
      /HTTP 404/u,
    );
  });
}

function createFixtureFetch({
  manifest = AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
  onRequest = () => undefined,
  override = () => undefined,
  packageJson = remotePackage,
} = {}) {
  return async (input) => {
    const url = String(input);
    onRequest(url);
    const overridden = override(url);
    if (overridden !== undefined) {
      return overridden;
    }
    if (url === `${repositoryBaseUrl}/package.json`) {
      return jsonResponse(packageJson);
    }
    if (url === `${assetBaseUrl}/manifest.json`) {
      return jsonResponse(manifest);
    }

    const asset = Object.values(
      AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets,
    ).find(({ path }) => url === `${assetBaseUrl}/${path}`);
    if (asset !== undefined) {
      return fileResponse(`codec-assets/${asset.path}`);
    }
    const legalFile = CODEC_ASSET_LEGAL_FILES.find(
      ({ sourcePath }) => url === `${repositoryBaseUrl}/${sourcePath}`,
    );
    if (legalFile !== undefined) {
      return fileResponse(legalFile.sourcePath);
    }
    return new Response(null, { status: 404 });
  };
}

async function fileResponse(sourcePath) {
  const bytes = await readFile(new URL(`../${sourcePath}`, import.meta.url));
  return new Response(bytes);
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}
