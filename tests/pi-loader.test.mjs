import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("Pi loads the package's extension with both tools and its command", async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-cdp-loader-"));
  try {
    const result = await discoverAndLoadExtensions([join(root, "arc-cdp-search.ts")], root, agentDir);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings ?? [], []);
    assert.equal(result.extensions.length, 1);
    assert.deepEqual([...result.extensions[0].tools.keys()], ["google_search", "visit_page"]);
    assert.ok(result.extensions[0].commands.has("cdp-search"));
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
