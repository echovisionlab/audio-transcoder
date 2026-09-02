import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const scripts = [
  'codec-build/aac/build.sh',
  'codec-build/mp3/build.sh',
  'codec-build/flac/build.sh',
  'scripts/ogg-opus-build-wasm.sh',
  'scripts/resampler-build-wasm.sh',
];

test('all relink builders document isolated reproduction and relink modes', async () => {
  for (const script of scripts) {
    const { stdout } = await execFileAsync(`${repositoryRoot}/${script}`, ['--help']);
    assert.match(stdout, /--verify-reproduction/u, script);
    assert.match(stdout, /--relink/u, script);
    assert.match(stdout, /--source-dir/u, script);
    assert.match(stdout, /--output-dir/u, script);
  }
});

test('all relink builders require an explicit output directory', async () => {
  for (const script of scripts) {
    await assert.rejects(
      execFileAsync(`${repositoryRoot}/${script}`, ['--relink']),
      /--relink requires --output-dir/u,
      script,
    );
  }
});

test('all relink builders reject output inside the repository', async () => {
  for (const script of scripts) {
    await assert.rejects(
      execFileAsync(`${repositoryRoot}/${script}`, [
        '--relink',
        '--output-dir',
        repositoryRoot,
      ]),
      /--output-dir must be outside the repository/u,
      script,
    );
  }
});

test('rejected output directories are not created before validation', async (context) => {
  const parent = await mkdtemp(join(repositoryRoot, '.relink-contract-'));
  const rejectedDirectory = join(parent, 'must-not-be-created');
  context.after(() => rm(parent, { force: true, recursive: true }));

  for (const script of scripts) {
    await assert.rejects(
      execFileAsync(`${repositoryRoot}/${script}`, [
        '--relink',
        '--output-dir',
        rejectedDirectory,
      ]),
      /--output-dir must be an existing directory/u,
      script,
    );
    await assert.rejects(access(rejectedDirectory), undefined, script);
  }
});

test('LGPL builders accept modified source trees only in relink mode', async () => {
  for (const script of scripts.slice(0, 3)) {
    await assert.rejects(
      execFileAsync(`${repositoryRoot}/${script}`, [
        '--source-tree',
        repositoryRoot,
      ]),
      /--source-tree is valid only with --relink/u,
      script,
    );
  }
});

test('builders reject conflicting build modes', async () => {
  for (const script of scripts) {
    await assert.rejects(
      execFileAsync(`${repositoryRoot}/${script}`, [
        '--relink',
        '--verify-reproduction',
        '--output-dir',
        '/tmp',
      ]),
      /Choose exactly one build mode/u,
      script,
    );
  }
});
