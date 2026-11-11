import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMcpSettings,
  saveMcpSettings,
  desktopMcpConfiguration,
} from "./mcp-settings.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "rea-mcp-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("handoff is off by default, persists explicitly, backs up changes and is idempotent", async (t) => {
  const root = await fixture(t);
  assert.equal((await loadMcpSettings(root)).reviewAfterAnalysis, false);
  assert.deepEqual(await readdir(root), []);
  await saveMcpSettings(root, true);
  assert.equal((await loadMcpSettings(root)).reviewAfterAnalysis, true);
  await saveMcpSettings(root, true);
  assert.deepEqual(await readdir(root), ["mcp-settings.json"]);
  await saveMcpSettings(root, false);
  assert.equal((await loadMcpSettings(root)).reviewAfterAnalysis, false);
  const backup = (await readdir(root)).filter((name) => name.endsWith(".bak"));
  assert.equal(backup.length, 1);
  assert.equal(
    JSON.parse(await readFile(join(root, backup[0]), "utf8"))
      .reviewAfterAnalysis,
    true,
  );
});
test("concurrent user changes are serialized and failed input cannot poison a later save", async (t) => {
  const root = await fixture(t);
  await assert.rejects(saveMcpSettings(root, "true"), /布尔值/);
  await Promise.all([
    saveMcpSettings(root, true),
    saveMcpSettings(root, false),
  ]);
  assert.equal((await loadMcpSettings(root)).reviewAfterAnalysis, false);
});
test("malformed settings stay untouched rather than being overwritten with defaults", async (t) => {
  const root = await fixture(t);
  const path = join(root, "mcp-settings.json");
  const original = JSON.stringify({
    schemaVersion: 1,
    reviewAfterAnalysis: "true",
    additional: "preserve",
  });
  await writeFile(path, original);
  await assert.rejects(saveMcpSettings(root, true));
  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual(await readdir(root), ["mcp-settings.json"]);
});
test("oversized settings cannot create an unbounded configuration read", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "mcp-settings.json"), " ".repeat(4097));
  await assert.rejects(loadMcpSettings(root), /常规文件/);
});
test("copyable MCP config uses argv and only explicitly configured provider paths", async (t) => {
  const root = await fixture(t);
  const nodePath = join(root, "有空格 node.exe");
  const coreRoot = join(root, "core");
  await writeFile(
    join(root, "providers.json"),
    JSON.stringify({ JAVA_HOME: root }),
  );
  let configuration = await desktopMcpConfiguration({
    directory: root,
    nodePath,
    coreRoot,
  });
  assert.deepEqual(configuration.mcpServers.rea, {
    command: nodePath,
    args: [join(coreRoot, "scripts/rea.mjs"), "mcp"],
    env: { JAVA_HOME: root, REA_MCP_REVIEW_AFTER_ANALYSIS: "0" },
  });
  await saveMcpSettings(root, true);
  configuration = await desktopMcpConfiguration({
    directory: root,
    nodePath,
    coreRoot,
  });
  assert.equal(
    configuration.mcpServers.rea.env.REA_MCP_REVIEW_AFTER_ANALYSIS,
    "1",
  );
  assert.equal(Object.keys(configuration.mcpServers.rea.env).length, 2);
  await assert.rejects(
    desktopMcpConfiguration({ directory: root, nodePath: "node", coreRoot }),
    /路径/,
  );
});
