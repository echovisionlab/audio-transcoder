import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CODEC_ASSET_VERSION = '0.0.0-development';
export const DEFAULT_CODEC_ASSET_ABI_VERSION = 1;

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..');

const BASE64_ASSETS = [
  {
    id: 'ogg-opus',
    path: 'wasm/ogg-opus.wasm',
    sourcePath: 'src/stream/runtime/ogg-opus-wasm-binary.ts',
    base64Constant: 'OGG_OPUS_WASM_BASE64',
    sha256Constant: 'OGG_OPUS_WASM_SHA256',
  },
  {
    id: 'resampler-fast',
    path: 'wasm/resampler-fast.wasm',
    sourcePath: 'src/stream/resampler-wasm-fast-binary.ts',
    base64Constant: 'RESAMPLER_WASM_BASE64',
    sha256Constant: 'RESAMPLER_WASM_SHA256',
  },
  {
    id: 'resampler-balanced',
    path: 'wasm/resampler-balanced.wasm',
    sourcePath: 'src/stream/resampler-wasm-balanced-binary.ts',
    base64Constant: 'RESAMPLER_WASM_BASE64',
    sha256Constant: 'RESAMPLER_WASM_SHA256',
  },
  {
    id: 'resampler-best',
    path: 'wasm/resampler-best.wasm',
    sourcePath: 'src/stream/resampler-wasm-best-binary.ts',
    base64Constant: 'RESAMPLER_WASM_BASE64',
    sha256Constant: 'RESAMPLER_WASM_SHA256',
  },
];

const AAC_SOURCE_PATH = 'src/stream/runtime/aac.generated.mjs';
const AAC_BUILD_MANIFEST_PATH = 'codec-build/aac/manifest.json';
const RAW_BUILD_ASSETS = [
  {
    id: 'flac',
    path: 'wasm/flac.wasm',
    sourcePath: 'codec-build/flac/flac.wasm',
    manifestPath: 'codec-build/flac/manifest.json',
  },
  {
    id: 'mp3',
    path: 'wasm/mp3.wasm',
    sourcePath: 'codec-build/mp3/mp3.wasm',
    manifestPath: 'codec-build/mp3/manifest.json',
  },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function findSingleMatch(source, pattern, description) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1 || matches[0][1] === undefined) {
    throw new Error(
      `Expected exactly one ${description}; found ${matches.length}.`,
    );
  }
  return matches[0][1];
}

function decodeBase64Asset(source, asset) {
  const base64 = findSingleMatch(
    source,
    new RegExp(
      `const\\s+${escapeRegExp(asset.base64Constant)}\\s*=\\s*'([A-Za-z0-9+/=]+)'\\s*;`,
      'gu',
    ),
    asset.base64Constant,
  );
  const declaredSha256 = findSingleMatch(
    source,
    new RegExp(
      `export\\s+const\\s+${escapeRegExp(asset.sha256Constant)}\\s*=\\s*'([0-9a-f]{64})'\\s*;`,
      'gu',
    ),
    asset.sha256Constant,
  );
  const bytes = Buffer.from(base64, 'base64');

  if (bytes.toString('base64') !== base64) {
    throw new Error(`${asset.sourcePath} contains non-canonical base64.`);
  }
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== declaredSha256) {
    throw new Error(
      `${asset.sourcePath} declares ${declaredSha256}, but contains ${actualSha256}.`,
    );
  }

  return bytes;
}

async function validateWasm(asset, bytes) {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x00 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d
  ) {
    throw new Error(`${asset.id} does not start with the WebAssembly magic bytes.`);
  }
  await WebAssembly.compile(bytes);
}

async function readAacAsset(repositoryRoot) {
  const sourceFile = resolve(repositoryRoot, AAC_SOURCE_PATH);
  const sourceBytes = await readFile(sourceFile);
  const buildManifest = JSON.parse(
    await readFile(resolve(repositoryRoot, AAC_BUILD_MANIFEST_PATH), 'utf8'),
  );

  if (buildManifest.artifact?.path !== AAC_SOURCE_PATH) {
    throw new Error(
      `${AAC_BUILD_MANIFEST_PATH} does not describe ${AAC_SOURCE_PATH}.`,
    );
  }
  if (
    buildManifest.artifact.sizeBytes !== sourceBytes.byteLength ||
    buildManifest.artifact.sha256 !== sha256(sourceBytes)
  ) {
    throw new Error(`${AAC_SOURCE_PATH} does not match its build manifest.`);
  }
  const wasmPath = buildManifest.wasmArtifact?.path;
  if (typeof wasmPath !== 'string') {
    throw new Error(`${AAC_BUILD_MANIFEST_PATH} does not declare AAC WASM.`);
  }
  const wasmBytes = await readFile(resolve(repositoryRoot, wasmPath));
  if (
    buildManifest.wasmArtifact.sizeBytes !== wasmBytes.byteLength ||
    buildManifest.wasmArtifact.sha256 !== sha256(wasmBytes)
  ) {
    throw new Error(`${wasmPath} does not match its build manifest.`);
  }
  return wasmBytes;
}

async function readRawBuildAsset(repositoryRoot, asset, abiVersion) {
  const bytes = await readFile(resolve(repositoryRoot, asset.sourcePath));
  const buildManifest = JSON.parse(
    await readFile(resolve(repositoryRoot, asset.manifestPath), 'utf8'),
  );
  if (
    buildManifest.schemaVersion !== 1 ||
    buildManifest.abiVersion !== abiVersion ||
    buildManifest.artifact?.path !== asset.sourcePath ||
    buildManifest.artifact.sizeBytes !== bytes.byteLength ||
    buildManifest.artifact.sha256 !== sha256(bytes)
  ) {
    throw new Error(
      `${asset.sourcePath} does not match its ABI ${abiVersion} build manifest.`,
    );
  }
  return bytes;
}

function validateManifestInputs(version, abiVersion) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new TypeError('Codec asset version must be a non-empty string.');
  }
  if (!Number.isSafeInteger(abiVersion) || abiVersion < 1) {
    throw new TypeError('Codec asset ABI version must be a positive integer.');
  }
}

export async function prepareCodecAssets({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  outputDirectory = resolve(repositoryRoot, 'codec-assets'),
  version = DEFAULT_CODEC_ASSET_VERSION,
  abiVersion = DEFAULT_CODEC_ASSET_ABI_VERSION,
} = {}) {
  validateManifestInputs(version, abiVersion);

  const assets = [
    {
      id: 'aac',
      path: 'wasm/aac.wasm',
      bytes: await readAacAsset(repositoryRoot),
    },
  ];

  for (const asset of RAW_BUILD_ASSETS) {
    assets.push({
      id: asset.id,
      path: asset.path,
      bytes: await readRawBuildAsset(repositoryRoot, asset, abiVersion),
    });
  }

  for (const asset of BASE64_ASSETS) {
    const source = await readFile(
      resolve(repositoryRoot, asset.sourcePath),
      'utf8',
    );
    assets.push({
      id: asset.id,
      path: asset.path,
      bytes: decodeBase64Asset(source, asset),
    });
  }

  for (const asset of assets) {
    await validateWasm(asset, asset.bytes);
  }

  const manifest = {
    schemaVersion: 1,
    version,
    abiVersion,
    assets: Object.fromEntries(
      assets.map((asset) => [
        asset.id,
        {
          path: asset.path,
          bytes: asset.bytes.byteLength,
          sha256: sha256(asset.bytes),
        },
      ]),
    ),
  };

  for (const asset of assets) {
    const output = resolve(outputDirectory, asset.path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, asset.bytes);
  }
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    resolve(outputDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return manifest;
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    const hasValue = value !== undefined && !value.startsWith('--');
    if (argument === '--output-dir' && hasValue) {
      options.outputDirectory = resolve(value);
    } else if (argument === '--version' && hasValue) {
      options.version = value;
    } else if (argument === '--abi-version' && hasValue) {
      options.abiVersion = Number(value);
    } else {
      throw new Error(
        'Usage: node scripts/prepare-codec-assets.mjs [--output-dir <path>] [--version <version>] [--abi-version <integer>]',
      );
    }
    index += 1;
  }
  return options;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const manifest = await prepareCodecAssets(parseArguments(process.argv.slice(2)));
  for (const [id, asset] of Object.entries(manifest.assets)) {
    console.log(`${id}: ${asset.bytes} bytes (${asset.sha256})`);
  }
}
