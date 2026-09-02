import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyReleaseState } from "./verify-release-state.mjs";

const HEAD = "1234567890abcdef1234567890abcdef12345678";

test("accepts only a clean exact Release Please tag at HEAD", async (context) => {
  const root = await fixture(context, "1.2.3");
  const state = await verifyReleaseState({
    repositoryRoot: root,
    execFile: gitStub(),
  });
  assert.deepEqual(state, { head: HEAD, tag: "v1.2.3", version: "1.2.3" });
});

test("rejects a dirty worktree before resolving the tag", async (context) => {
  const root = await fixture(context, "1.2.3");
  await assert.rejects(
    verifyReleaseState({
      repositoryRoot: root,
      execFile: gitStub({ status: "?? unexpected.txt\n" }),
    }),
    /requires a clean worktree/u,
  );
});

test("rejects a tag that is not at HEAD", async (context) => {
  const root = await fixture(context, "1.2.3");
  await assert.rejects(
    verifyReleaseState({
      repositoryRoot: root,
      execFile: gitStub({
        taggedCommit: "abcdef1234567890abcdef1234567890abcdef12",
      }),
    }),
    /v1\.2\.3 resolves to/u,
  );
});

test("rejects a tag that is not published by the canonical repository at HEAD", async (context) => {
  const root = await fixture(context, "1.2.3");
  await assert.rejects(
    verifyReleaseState({
      repositoryRoot: root,
      execFile: gitStub({
        remoteTaggedCommit: "abcdef1234567890abcdef1234567890abcdef12",
      }),
    }),
    /Public v1\.2\.3 resolves to/u,
  );
});

test("accepts an annotated public tag peeled to HEAD", async (context) => {
  const root = await fixture(context, "1.2.3");
  const state = await verifyReleaseState({
    repositoryRoot: root,
    execFile: gitStub({
      annotatedTagObject: "abcdef1234567890abcdef1234567890abcdef12",
    }),
  });
  assert.deepEqual(state, { head: HEAD, tag: "v1.2.3", version: "1.2.3" });
});

test("rejects non-exact versions", async (context) => {
  const root = await fixture(context, "0.0.0-development");
  await assert.rejects(
    verifyReleaseState({ repositoryRoot: root, execFile: gitStub() }),
    /must be exact SemVer/u,
  );
});

async function fixture(context, version) {
  const root = await mkdtemp(join(tmpdir(), "audio-transcoder-release-state-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ version })}\n`,
  );
  return root;
}

function gitStub({
  annotatedTagObject,
  remoteTaggedCommit = HEAD,
  status = "",
  taggedCommit = HEAD,
} = {}) {
  return async (_file, arguments_) => {
    const command = arguments_.join(" ");
    if (command === "status --porcelain=v1 --untracked-files=all") {
      return { stdout: status };
    }
    if (command === "rev-parse --verify HEAD^{commit}") {
      return { stdout: `${HEAD}\n` };
    }
    if (command === "rev-parse --verify refs/tags/v1.2.3^{commit}") {
      return { stdout: `${taggedCommit}\n` };
    }
    if (
      command ===
      "ls-remote --exit-code https://github.com/echovisionlab/audio-transcoder.git refs/tags/v1.2.3 refs/tags/v1.2.3^{}"
    ) {
      const direct = annotatedTagObject ?? remoteTaggedCommit;
      const peeled = annotatedTagObject
        ? `${remoteTaggedCommit}\trefs/tags/v1.2.3^{}\n`
        : "";
      return { stdout: `${direct}\trefs/tags/v1.2.3\n${peeled}` };
    }
    throw new Error(`Unexpected git command: ${command}`);
  };
}
