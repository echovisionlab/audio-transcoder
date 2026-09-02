import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  CODEC_ASSET_LEGAL_FILES,
  CODEC_ASSET_PACKAGE_DESCRIPTION,
  CODEC_ASSET_PACKAGE_FILES,
  CODEC_ASSET_PACKAGE_NAME,
  CODEC_ASSET_PACKAGE_PUBLISH_BLOCK_MESSAGE,
  CODEC_ASSET_PACKAGE_PUBLISH_GUARD,
  sha256,
} from './codec-asset-package-contract.mjs';

const execFileAsync = promisify(execFile);
const arguments_ = process.argv.slice(2);
if (arguments_.length > 0) {
  throw new Error(`Unknown codec asset staging argument: ${arguments_[0]}`);
}

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const packageDirectory = resolve(
  repositoryRoot,
  '.artifacts/codec-assets-package',
);
const enginePackage = JSON.parse(
  await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
);
const assetPackage = JSON.parse(
  await readFile(resolve(packageDirectory, 'package.json'), 'utf8'),
);
const manifest = JSON.parse(
  await readFile(resolve(packageDirectory, 'manifest.json'), 'utf8'),
);
const expectedIds = [
  'aac',
  'flac',
  'mp3',
  'ogg-opus',
  'resampler-fast',
  'resampler-balanced',
  'resampler-best',
];

if (
  assetPackage.name !== CODEC_ASSET_PACKAGE_NAME ||
  assetPackage.version !== enginePackage.version ||
  assetPackage.description !== CODEC_ASSET_PACKAGE_DESCRIPTION ||
  assetPackage.author !== enginePackage.author ||
  assetPackage.license !== 'SEE LICENSE IN LICENSE.md' ||
  assetPackage.private !== true ||
  assetPackage.scripts?.prepublishOnly !==
    CODEC_ASSET_PACKAGE_PUBLISH_GUARD ||
  JSON.stringify(assetPackage.repository) !==
    JSON.stringify(enginePackage.repository) ||
  assetPackage.sideEffects !== false ||
  assetPackage.publishConfig !== undefined ||
  JSON.stringify(assetPackage.files) !==
    JSON.stringify(CODEC_ASSET_PACKAGE_FILES) ||
  manifest.version !== enginePackage.version ||
  manifest.schemaVersion !== 1 ||
  manifest.abiVersion !== 1 ||
  JSON.stringify(Object.keys(manifest.assets)) !== JSON.stringify(expectedIds)
) {
  throw new Error('Codec asset package identity, version, or manifest drifted.');
}

for (const id of expectedIds) {
  const descriptor = manifest.assets[id];
  const bytes = await readFile(resolve(packageDirectory, descriptor.path));
  if (
    bytes.byteLength !== descriptor.bytes ||
    sha256(bytes) !== descriptor.sha256 ||
    !WebAssembly.validate(bytes)
  ) {
    throw new Error(`Codec asset package contains an invalid ${id} artifact.`);
  }
}

for (const descriptor of CODEC_ASSET_LEGAL_FILES) {
  const sourceBytes = await readFile(
    resolve(repositoryRoot, descriptor.sourcePath),
  );
  const packagedBytes = await readFile(
    resolve(packageDirectory, descriptor.packagePath),
  );
  if (!sourceBytes.equals(packagedBytes)) {
    throw new Error(
      `Codec package ${descriptor.packagePath} does not match ${descriptor.sourcePath}.`,
    );
  }
}

const { stdout: packOutput } = await execFileAsync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: packageDirectory },
);
const [packReport] = JSON.parse(packOutput);
const actualPackedPaths = packReport.files
  .map(({ path }) => path)
  .sort();
const expectedPackedPaths = [
  'manifest.json',
  'package.json',
  ...CODEC_ASSET_LEGAL_FILES.map(({ packagePath }) => packagePath),
  ...expectedIds.map((id) => manifest.assets[id].path),
].sort();
if (
  JSON.stringify(actualPackedPaths) !== JSON.stringify(expectedPackedPaths)
) {
  throw new Error('Codec asset npm tarball path set drifted.');
}

let publicationWasBlocked = false;
try {
  await execFileAsync(
    'npm',
    ['publish', '--dry-run', '--foreground-scripts'],
    { cwd: packageDirectory },
  );
} catch (error) {
  const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  if (output.includes(CODEC_ASSET_PACKAGE_PUBLISH_BLOCK_MESSAGE)) {
    publicationWasBlocked = true;
  } else {
    throw error;
  }
}
if (!publicationWasBlocked) {
  throw new Error('Codec asset publication guard did not block npm publish.');
}

console.log(
  `Verified ${expectedIds.length} version-locked codec assets, ${CODEC_ASSET_LEGAL_FILES.length} legal files, and the publication block for ${assetPackage.version} (${packReport.size} packed bytes).`,
);
