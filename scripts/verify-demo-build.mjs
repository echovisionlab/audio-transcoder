import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from 'node:zlib';

const expectedAssetIds = [
  'aac',
  'flac',
  'mp3',
  'ogg-opus',
  'resampler-balanced',
  'resampler-best',
  'resampler-fast',
];
const distUrl = new URL('../examples/vite/dist/', import.meta.url);
const distPath = fileURLToPath(distUrl);
const packagedAssetsUrl = new URL(
  '../.artifacts/codec-assets-package/',
  import.meta.url,
);
const viteManifest = JSON.parse(
  await readFile(new URL('.vite/manifest.json', distUrl), 'utf8'),
);
const packagedManifestText = await readFile(
  new URL('manifest.json', packagedAssetsUrl),
  'utf8',
);
const packagedManifest = JSON.parse(packagedManifestText);
const deployedManifestText = await readFile(
  new URL('manifest.json', distUrl),
  'utf8',
);
const deployedManifest = JSON.parse(deployedManifestText);
const indexHtml = await readFile(new URL('index.html', distUrl), 'utf8');
const outputPaths = (await listFiles(distPath)).sort();
const javascript = new Map();

for (const relativePath of outputPaths) {
  if (!relativePath.endsWith('.js')) continue;

  const contents = await readFile(new URL(relativePath, distUrl));
  javascript.set(relativePath, {
    brotliBytes: brotliCompressSync(contents, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    }).byteLength,
    bytes: contents.byteLength,
    code: contents.toString('utf8'),
    gzipBytes: gzipSync(contents, { level: 9 }).byteLength,
  });
}

assert(
  JSON.stringify(deployedManifest) === JSON.stringify(packagedManifest),
  'The deployed codec manifest differs from the staged codec package manifest',
);
assert(
  deployedManifest.schemaVersion === 1,
  `Expected codec manifest schema 1, received ${String(deployedManifest.schemaVersion)}`,
);

const assetEntries = Object.entries(deployedManifest.assets).sort(
  ([left], [right]) => left.localeCompare(right),
);
assert(
  JSON.stringify(assetEntries.map(([assetId]) => assetId)) ===
    JSON.stringify(expectedAssetIds),
  `Expected exactly the seven codec asset IDs ${expectedAssetIds.join(', ')}`,
);

const expectedWasmPaths = [];
for (const [assetId, descriptor] of assetEntries) {
  const expectedPath = `wasm/${assetId}.wasm`;
  assert(
    descriptor.path === expectedPath,
    `${assetId} must use the stable path ${expectedPath}, received ${String(descriptor.path)}`,
  );
  expectedWasmPaths.push(expectedPath);

  const [deployedBytes, packagedBytes] = await Promise.all([
    readFile(new URL(descriptor.path, distUrl)),
    readFile(new URL(descriptor.path, packagedAssetsUrl)),
  ]);
  assert(
    deployedBytes.byteLength === descriptor.bytes,
    `${descriptor.path} has ${deployedBytes.byteLength} bytes; manifest requires ${descriptor.bytes}`,
  );
  assert(
    deployedBytes.equals(packagedBytes),
    `${descriptor.path} differs from the staged codec package`,
  );
  assert(
    sha256(deployedBytes) === descriptor.sha256,
    `${descriptor.path} does not match its manifest SHA-256`,
  );
  assert(
    WebAssembly.validate(deployedBytes),
    `${descriptor.path} is not a valid WebAssembly module`,
  );
}

const actualWasmPaths = outputPaths.filter((path) => path.endsWith('.wasm'));
assert(
  JSON.stringify(actualWasmPaths) === JSON.stringify(expectedWasmPaths),
  `Expected only ${expectedWasmPaths.join(', ')}, received ${actualWasmPaths.join(', ')}`,
);

const entryRecord = Object.values(viteManifest).find(
  (record) => record.isEntry === true && record.src === 'index.html',
);
assert(entryRecord, 'Vite manifest does not contain the index.html entry');
assert(
  javascript.has(entryRecord.file),
  `Vite entry is missing: ${entryRecord.file}`,
);

const mainGraph = collectStaticGraph([entryRecord.file]);
const workerReferences = unique(
  [...mainGraph].flatMap((path) =>
    extractWorkerSpecifiers(javascript.get(path).code)
      .map((specifier) => resolveJavascript(path, specifier))
      .filter(Boolean),
  ),
);
assert(
  workerReferences.length === 1,
  `Expected one package Worker, found ${workerReferences.length}`,
);

const workerPath = workerReferences[0];
const workerGraph = collectFullGraph([workerPath]);
for (const path of workerGraph) {
  assert(
    countWorkerConstructors(javascript.get(path).code) === 0,
    `Worker graph creates a nested Worker: ${path}`,
  );
}

const allJavaScript = [...javascript.values()]
  .map(({ code }) => code)
  .join('\n');
assert(
  countWorkerConstructors(allJavaScript) === 1,
  'The production JavaScript must contain only the package Worker constructor',
);
assert(
  !allJavaScript.includes('AGFzbQE'),
  'JavaScript contains a base64-encoded WebAssembly magic header',
);
assert(
  !/data:application\/wasm/i.test(allJavaScript),
  'JavaScript contains a WebAssembly data URL',
);
assert(
  !/["'`]([A-Za-z0-9+/]{65_536,}={0,2})["'`]/.test(allJavaScript),
  'JavaScript contains an unexpectedly large base64-like string payload',
);
for (const legacyPayloadName of [
  'ogg-opus-wasm-binary',
  'resampler-wasm-balanced-binary',
  'resampler-wasm-best-binary',
  'resampler-wasm-fast-binary',
]) {
  assert(
    !allJavaScript.includes(legacyPayloadName),
    `JavaScript still references embedded payload module ${legacyPayloadName}`,
  );
}
assert(
  !/new\s+Worker\s*\([^)]*(?:Blob|createObjectURL)/s.test(allJavaScript),
  'JavaScript constructs a Blob-backed Worker',
);
assert(
  [...mainGraph].some((path) =>
    javascript.get(path).code.includes('self-hosted'),
  ),
  'The app entry does not configure an explicit self-hosted codec source',
);
assert(
  !indexHtml.includes('cdn.jsdelivr.net'),
  'index.html must not load codec assets from an external CDN',
);

console.log('Verified Vite production raw-WASM delivery:');
printAsset('app entry', entryRecord.file);
printAsset('package Worker', workerPath);
printAggregate('initial app and Worker static graphs', [
  ...mainGraph,
  ...collectStaticGraph([workerPath]),
]);
printAggregate('all production JavaScript assets', javascript.keys());
for (const [assetId, descriptor] of assetEntries) {
  console.log(
    `- ${assetId}: ${descriptor.path} (${formatBytes(descriptor.bytes)}, sha256 ${descriptor.sha256})`,
  );
}

function collectFullGraph(roots) {
  const visited = new Set();
  const pending = [...roots];

  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;

    const asset = javascript.get(path);
    assert(asset, `JavaScript graph references a missing asset: ${path}`);
    visited.add(path);

    const specifiers = [
      ...extractStaticImportSpecifiers(asset.code),
      ...extractDynamicImportSpecifiers(asset.code),
    ];
    for (const specifier of specifiers) {
      const dependency = resolveJavascript(path, specifier);
      if (dependency && !visited.has(dependency)) pending.push(dependency);
    }
  }

  return visited;
}

function collectStaticGraph(roots) {
  const visited = new Set();
  const pending = [...roots];

  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;

    const asset = javascript.get(path);
    assert(asset, `JavaScript graph references a missing asset: ${path}`);
    visited.add(path);

    for (const specifier of extractStaticImportSpecifiers(asset.code)) {
      const dependency = resolveJavascript(path, specifier);
      if (dependency && !visited.has(dependency)) pending.push(dependency);
    }
  }

  return visited;
}

function resolveJavascript(importerPath, specifier) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  let resolved;

  if (cleanSpecifier.startsWith('/')) {
    resolved = posix.normalize(cleanSpecifier.slice(1));
  } else if (cleanSpecifier.startsWith('.')) {
    resolved = posix.normalize(
      posix.join(posix.dirname(importerPath), cleanSpecifier),
    );
  } else {
    return null;
  }

  assert(
    resolved !== '..' && !resolved.startsWith('../'),
    `Asset reference escapes the Vite output directory: ${specifier}`,
  );
  assert(
    javascript.has(resolved),
    `JavaScript asset does not exist: ${importerPath} -> ${specifier}`,
  );
  return resolved;
}

function extractStaticImportSpecifiers(code) {
  return unique([
    ...extractMatches(
      code,
      /\bimport(?!\s*\()\s*[^"'`;]*?\s*from\s*(["'`])([^"'`]+)\1/g,
    ),
    ...extractMatches(
      code,
      /\bimport(?!\s*\()\s*(["'`])([^"'`]+)\1/g,
    ),
  ]);
}

function extractDynamicImportSpecifiers(code) {
  return extractMatches(
    code,
    /\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
  );
}

function extractWorkerSpecifiers(code) {
  return extractMatches(
    code,
    /\bnew\s+Worker\s*\(\s*new\s+URL\s*\(\s*(["'`])([^"'`]+)\1/g,
  );
}

function countWorkerConstructors(code) {
  return [...code.matchAll(/\bnew\s+Worker\s*\(/g)].length;
}

function extractMatches(code, pattern) {
  return [...code.matchAll(pattern)].map((match) => match[2]);
}

async function listFiles(directory, prefix = '') {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      paths.push(
        ...(await listFiles(`${directory}/${entry.name}`, relativePath)),
      );
    } else if (entry.isFile()) {
      paths.push(relativePath);
    }
  }
  return paths;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function printAsset(label, path) {
  const sizes = javascript.get(path);
  console.log(`- ${label}: ${path} (${formatSizes(sizes)})`);
}

function printAggregate(label, paths) {
  const totals = { brotliBytes: 0, bytes: 0, gzipBytes: 0 };
  for (const path of new Set(paths)) {
    const asset = javascript.get(path);
    totals.bytes += asset.bytes;
    totals.gzipBytes += asset.gzipBytes;
    totals.brotliBytes += asset.brotliBytes;
  }
  console.log(`- ${label}: ${formatSizes(totals)}`);
}

function formatSizes({ brotliBytes, bytes, gzipBytes }) {
  return [
    `raw ${formatBytes(bytes)}`,
    `gzip-9 ${formatBytes(gzipBytes)}`,
    `brotli-11 ${formatBytes(brotliBytes)}`,
  ].join(', ');
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} bytes / ${(bytes / 1024).toFixed(2)} KiB`;
}

function unique(values) {
  return [...new Set(values)];
}

function assert(condition, message) {
  if (!condition) throw new Error(`Demo build verification failed: ${message}`);
}
