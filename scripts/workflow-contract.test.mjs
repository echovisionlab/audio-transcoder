import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("GitHub Actions workflows use the engine CI and package release contract", async () => {
  const ci = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  const release = await readFile(
    new URL(".github/workflows/release.yml", root),
    "utf8",
  );

  assert.match(ci, /pull_request:\s+branches:\s+- main/u);
  assert.doesNotMatch(ci, /push:\s+branches:\s+- main/u);
  assert.doesNotMatch(ci, /workflow_dispatch:/u);
  assert.match(ci, /name: Validate/u);
  assert.match(ci, /browser: \[chromium, firefox, webkit\]/u);
  assert.match(release, /name: Release Please/u);
  assert.match(release, /name: Publish Package/u);
  assert.match(release, /token: \$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(release, /secrets\.|self-hosted/u);
  assert.doesNotMatch(release, /pnpm check|pnpm test/u);

  for (const source of [ci, release]) {
    for (const action of source.matchAll(
      /^\s*(?:-\s*)?uses: ([^@]+)@([^\s]+)/gmu,
    )) {
      assert.match(
        action[2],
        /^[0-9a-f]{40}$/u,
        `${action[1]} must use a full SHA`,
      );
    }
  }
});
