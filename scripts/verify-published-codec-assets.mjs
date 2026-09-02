import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  AUDIO_TRANSCODER_CODEC_ASSET_BASE_PATH,
  AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
  AUDIO_TRANSCODER_CODEC_ASSET_REPOSITORY,
  createAudioTranscoderCodecAssetProvider,
  createAudioTranscoderJsDelivrAssetSource,
} from '../dist/index.js';
import { CODEC_ASSET_LEGAL_FILES } from './codec-asset-package-contract.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;

export async function verifyPublishedCodecAssets({
  fetchAsset = globalThis.fetch.bind(globalThis),
  log = console.log,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive integer.');
  }

  const source = createAudioTranscoderJsDelivrAssetSource();
  const repositoryBaseUrl =
    `https://cdn.jsdelivr.net/gh/${source.repository}@${source.tag}`;
  const assetBaseUrl = `${repositoryBaseUrl}/${source.basePath}`;
  const fetchWithTimeout = (input, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      init.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([init.signal, timeoutSignal]);
    return fetchAsset(input, { ...init, signal });
  };
  const readJson = async (url) => {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    return response.json();
  };
  const readBytes = async (url) => {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };

  const remotePackage = await readJson(`${repositoryBaseUrl}/package.json`);
  assert.equal(
    remotePackage.name,
    '@echovisionlab/audio-transcoder',
    'Release tag package name does not match the engine contract.',
  );
  assert.equal(
    remotePackage.version,
    AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version,
    'Release tag package version does not match the engine contract.',
  );
  assert.deepEqual(
    remotePackage.repository,
    {
      type: 'git',
      url: 'git+https://github.com/echovisionlab/audio-transcoder.git',
    },
    'Release tag repository does not match the public source contract.',
  );

  assert.equal(source.repository, AUDIO_TRANSCODER_CODEC_ASSET_REPOSITORY);
  assert.equal(source.basePath, AUDIO_TRANSCODER_CODEC_ASSET_BASE_PATH);

  const remoteManifest = await readJson(`${assetBaseUrl}/manifest.json`);
  assert.deepEqual(
    remoteManifest,
    AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
    'Published codec asset manifest does not match the engine contract.',
  );

  const provider = createAudioTranscoderCodecAssetProvider({
    source,
    fetch: fetchWithTimeout,
  });
  for (const assetName of Object.keys(
    AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets,
  )) {
    const bytes = await provider.load(assetName);
    assert.equal(
      WebAssembly.validate(bytes),
      true,
      `Published runtime asset is not valid WebAssembly: ${assetName}`,
    );
    log(`Verified ${provider.resolveUrl(assetName)}`);
  }

  for (const descriptor of CODEC_ASSET_LEGAL_FILES) {
    const url = `${repositoryBaseUrl}/${descriptor.sourcePath}`;
    await readBytes(url);
    log(`Verified ${url}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await verifyPublishedCodecAssets();
}
