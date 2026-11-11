import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AGENT_REVIEW_INSTRUCTIONS } from "../dist/server/agentReview.js";
import { toolContract } from "../dist/contracts/toolContracts.js";
const { values } = parseArgs({
  options: { target: { type: "string" }, report: { type: "string" } },
});
assert.ok(values.target && values.report, "--target and --report are required");
const root = fileURLToPath(new URL("../", import.meta.url));
const target = resolve(values.target),
  report = resolve(values.report);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const before = sha(await readFile(target));
await mkdir(dirname(report), { recursive: true });
const runs = [];
for (const enabled of [false, true]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  );
  if (enabled) env.REA_MCP_REVIEW_AFTER_ANALYSIS = "1";
  else delete env.REA_MCP_REVIEW_AFTER_ANALYSIS;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "scripts/rea.mjs"), "mcp"],
    env,
    stderr: "pipe",
  });
  const client = new Client({
    name: "rea-agent-neutral-handoff-verification",
    version: "1",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-65536);
  });
  const start = Date.now();
  try {
    await client.connect(transport);
    const instructions = client.getInstructions();
    assert.equal(instructions.includes(AGENT_REVIEW_INSTRUCTIONS), enabled);
    const reply = await client.callTool(
      { name: "inspect_binary_layout", arguments: { path: target } },
      undefined,
      { timeout: 60000 },
    );
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    const evidence = toolContract("inspect_binary_layout").outputSchema.parse(
      reply.structuredContent,
    );
    assert.equal(evidence.normalized_result.artifact.sha256, before);
    assert.equal(
      JSON.parse(reply.content[0].text).evidence_id,
      evidence.evidence_id,
    );
    assert.equal(reply._meta?.provenance?.untrusted_content, true);
    assert.equal(reply.content.length, enabled ? 2 : 1);
    assert.equal(reply._meta?.["rea/agent_review"]?.enabled === true, enabled);
    if (enabled)
      assert.ok(reply.content[1].text.includes(AGENT_REVIEW_INSTRUCTIONS));
    const failure = await client.callTool(
      {
        name: "inspect_binary_layout",
        arguments: { path: target + ".missing" },
      },
      undefined,
      { timeout: 60000 },
    );
    assert.equal(failure.isError, true);
    assert.equal(failure._meta?.["rea/agent_review"], undefined);
    runs.push({
      enabled,
      instructions,
      reply,
      expected_failure: failure,
      elapsed_ms: Date.now() - start,
      response_bytes: Buffer.byteLength(JSON.stringify(reply)),
      performance_scope:
        "Separate new MCP processes; no target execution. CPU, peak process-family memory and agent tokens are unmeasured; response bytes are not token counts.",
    });
  } finally {
    await client.close();
    await transport.close();
    await writeFile(
      join(dirname(report), `mcp-agent-review-${enabled}.stderr.log`),
      stderr,
    );
  }
}
assert.equal(sha(await readFile(target)), before);
assert.deepEqual(
  runs[0].reply.structuredContent.normalized_result,
  runs[1].reply.structuredContent.normalized_result,
);
await writeFile(
  report,
  JSON.stringify(
    {
      status: "passed",
      platform: process.platform,
      target,
      target_sha256: before,
      target_executed: false,
      runs,
      scope:
        "Real MCP stdio handshake and production pwntools ELF analysis. Client model behavior or its user-notification UI is not established by protocol tests.",
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    status: "passed",
    report,
    modes: runs.map((r) => ({
      enabled: r.enabled,
      elapsed_ms: r.elapsed_ms,
      response_bytes: r.response_bytes,
    })),
  }),
);
