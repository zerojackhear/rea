// Caller-supplied static fixture; never executes the selected target.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { runOwnedCommand } from "../dist/process/OwnedCommand.js";
import { requireMcpOperationResult } from "./lib/mcp-verifier-results.mjs";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    procedure: { type: "string" },
    caller: { type: "string" },
    marker: { type: "string" },
    report: { type: "string" },
  },
});
for (const name of ["target", "procedure", "caller", "marker", "report"])
  assert.ok(values[name], `--${name} is required`);
const executable = process.env.REA_KUNA_COMMAND;
assert.ok(
  executable && isAbsolute(executable),
  "REA_KUNA_COMMAND must be an absolute native executable path",
);
const target = resolve(values.target);
const report = resolve(values.report);
const root = fileURLToPath(new URL("../", import.meta.url));
const entrypoint = join(root, "scripts/rea.mjs");
await mkdir(dirname(report), { recursive: true });
const workspace = await mkdtemp(join(dirname(report), "kuna-native-"));
const cache = join(workspace, "cache 中文");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = digest(await readFile(target));
const records = [];
const environment = {
  ...process.env,
  REA_KUNA_CACHE_DIR: cache,
  REA_LOG_LEVEL: "silent",
};
for (const phase of ["cold", "fresh-session-cache"]) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "rea-kuna-native-verifier", version: "1" });
  let opened = false;
  const call = async (name, args = {}) => {
    const started = performance.now();
    const response = await client.callTool(
      { name, arguments: args },
      { timeout: 180000 },
    );
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const value = requireMcpOperationResult(response, name);
    records.push({
      phase,
      name,
      elapsed_ms: performance.now() - started,
      evidence: response.structuredContent,
    });
    return { value, evidence: response.structuredContent };
  };
  try {
    await client.connect(transport);
    await call("open_binary", { path: target, provider_id: "kuna" });
    opened = true;
    const listed = await call("list_procedures");
    assert.ok(listed.value.some((x) => x.address === values.procedure));
    const pseudo = await call("procedure_pseudo_code", {
      procedure: values.procedure,
    });
    assert.equal(pseudo.evidence.subject.digest.sha256, original);
    assert.equal(pseudo.evidence.provider.id, "kuna");
    assert.ok(typeof pseudo.value === "string" && pseudo.value.length > 0);
    const assembly = await call("procedure_assembly", {
      procedure: values.procedure,
    });
    assert.ok(assembly.value.includes(values.procedure));
    const exported = await call("procedure_pseudo_code", {
      procedure: values.procedure,
    });
    const source = exported.evidence.raw_result.source;
    assert.equal(source.kind, "project-export");
    const bytes = await readFile(join(source.directory, source.file));
    assert.equal(digest(bytes), source.file_sha256);
    assert.ok(
      bytes
        .subarray(source.byte_offset, source.byte_offset + source.byte_length)
        .toString("utf8")
        .includes(exported.value),
    );
    const callers = await call("procedure_callers", {
      procedure: values.procedure,
    });
    assert.ok(JSON.stringify(callers.value).includes(values.caller));
    const strings = await call("list_strings");
    assert.ok(JSON.stringify(strings.value).includes(values.marker));
    const dossier = await call("analyze_function", {
      procedure: values.procedure,
    });
    assert.equal(dossier.evidence.provider.id, "kuna");
  } finally {
    const failures = [];
    for (const cleanup of [
      async () => {
        if (opened) await call("close_binary");
      },
      () => client.close(),
      () => transport.close(),
    ])
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(failures, "Kuna verification cleanup failed");
  }
  assert.deepEqual(await readdir(join(cache, "staging")), []);
}
const cli = await runOwnedCommand(
  {
    command: process.execPath,
    arguments: [
      entrypoint,
      "decompile",
      target,
      values.procedure,
      "--provider",
      "kuna",
      "--format",
      "json",
    ],
    runId: randomUUID(),
    cwd: root,
    hostEnvironment: environment,
  },
  { timeoutMs: 180000, diagnosticBytes: 16 * 1024 * 1024 },
);
const evidence = JSON.parse(cli.stdout.text);
assert.equal(evidence.subject.digest.sha256, original);
assert.equal(evidence.provider.id, "kuna");
assert.ok(
  typeof evidence.normalized_result === "string" &&
    evidence.normalized_result.length > 0,
);
records.push({ phase: "cli", name: "decompile", evidence });
assert.equal(digest(await readFile(target)), original);
await writeFile(
  report,
  JSON.stringify(
    {
      status: "passed",
      host: process.platform,
      workspace,
      target_sha256: original,
      executable_sha256: digest(await readFile(executable)),
      records,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify({ status: "passed", calls: records.length, report }),
);
