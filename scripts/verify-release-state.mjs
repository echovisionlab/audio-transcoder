import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);
const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CANONICAL_RELEASE_REPOSITORY = 'https://github.com/echovisionlab/audio-transcoder.git';
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export async function verifyReleaseState({
  execFile = execFileAsync,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
} = {}) {
  const root = resolve(repositoryRoot);
  const packageJson = JSON.parse(
    await readFile(resolve(root, 'package.json'), 'utf8'),
  );
  const { version } = packageJson;
  if (
    typeof version !== 'string' ||
    version === '0.0.0-development' ||
    !EXACT_SEMVER.test(version)
  ) {
    throw new Error(`Release version must be exact SemVer: ${String(version)}.`);
  }

  const status = await git(execFile, root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (status !== '') {
    throw new Error(`Release requires a clean worktree; found ${JSON.stringify(status.split(/\r?\n/u)[0])}.`);
  }

  const head = await git(execFile, root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const tag = `v${version}`;
  const taggedCommit = await git(execFile, root, [
    'rev-parse',
    '--verify',
    `refs/tags/${tag}^{commit}`,
  ]);
  if (head !== taggedCommit) {
    throw new Error(`${tag} resolves to ${taggedCommit}, but HEAD is ${head}.`);
  }

  const remoteTag = await git(execFile, root, [
    'ls-remote',
    '--exit-code',
    CANONICAL_RELEASE_REPOSITORY,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  const remoteTaggedCommit = resolveRemoteTaggedCommit(remoteTag, tag);
  if (head !== remoteTaggedCommit) {
    throw new Error(`Public ${tag} resolves to ${remoteTaggedCommit}, but HEAD is ${head}.`);
  }

  return Object.freeze({ head, tag, version });
}

function resolveRemoteTaggedCommit(output, tag) {
  const directReference = `refs/tags/${tag}`;
  const peeledReference = `${directReference}^{}`;
  const references = new Map(
    output.split(/\r?\n/u).map((line) => {
      const [object, reference, ...extra] = line.split(/\s+/u);
      if (!object || !reference || extra.length > 0) {
        throw new Error(`Unexpected public tag response: ${JSON.stringify(line)}.`);
      }
      return [reference, object];
    }),
  );
  const commit = references.get(peeledReference) ?? references.get(directReference);
  if (!commit) {
    throw new Error(`Public repository has no exact ${directReference} reference.`);
  }
  return commit;
}

async function git(execFile, cwd, arguments_) {
  const result = await execFile('git', arguments_, { cwd, encoding: 'utf8' });
  const stdout = typeof result === 'string' ? result : result?.stdout;
  if (typeof stdout !== 'string') {
    throw new Error(`Git returned no output for: git ${arguments_.join(' ')}.`);
  }
  return stdout.replace(/[\r\n]+$/u, '');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const state = await verifyReleaseState();
  console.log(`Verified ${state.tag} at ${state.head}.`);
}
