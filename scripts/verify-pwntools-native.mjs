// Static Windows/Linux analysis of caller-built fixtures. Generation is separate.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { runOwnedCommand } from "../dist/process/OwnedCommand.js";
import { requireMcpOperationResult } from "./lib/mcp-verifier-results.mjs";
import { connectRecordedCrash } from "./verify/recorded-crash/public.mjs";
const { values } = parseArgs({
  options: { fixtures: { type: "string" }, report: { type: "string" } },
});
assert.ok(
  values.fixtures && values.report,
  "--fixtures and --report are required",
);
assert.ok(
  isAbsolute(process.env.REA_PWNTOOLS_PYTHON ?? ""),
  "REA_PWNTOOLS_PYTHON is required",
);
const fixtures = resolve(values.fixtures),
  report = resolve(values.report);
const root = fileURLToPath(new URL("../", import.meta.url));
const entrypoint = join(root, "scripts/rea.mjs");
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(dirname(report), { recursive: true });
const workspace = await mkdtemp(join(dirname(report), "pwntools-native-"));
const layoutPath = join(workspace, "布局 sample.elf");
await copyFile(join(fixtures, "protected.elf"), layoutPath);
const corePath = join(workspace, "转储 sample.core");
await copyFile(join(fixtures, "recording.core"), corePath);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env: environment,
  stderr: "pipe",
});
const client = new Client({ name: "rea-pwntools-native", version: "1" });
let core;
const records = [];
function checkLimits(value) {
  if (process.platform === "win32")
    assert.ok(
      value.limitations.some((line) =>
        line.includes('"job_memory_bytes": 3221225472'),
      ),
    );
}
try {
  await client.connect(transport);
  for (const name of [
    "protected",
    "plain",
    "relocatable",
    "library",
    "packed-relative",
  ]) {
    const path =
      name === "protected" ? layoutPath : join(fixtures, name + ".elf");
    const bytes = await readFile(path);
    let previous;
    for (const mode of ["cli", "mcp"]) {
      let value;
      if (mode === "cli") {
        const command = await runOwnedCommand(
          {
            command: process.execPath,
            arguments: [entrypoint, "inspect-binary-layout", path, "--json"],
            cwd: root,
            runId: randomUUID(),
            hostEnvironment: environment,
          },
          { timeoutMs: 60000, diagnosticBytes: 16 * 1024 * 1024 },
        );
        value = JSON.parse(command.stdout.text).normalized_result;
      } else {
        const response = await client.callTool(
          { name: "inspect_binary_layout", arguments: { path } },
          { timeout: 60000 },
        );
        assert.notEqual(response.isError, true, JSON.stringify(response));
        value = requireMcpOperationResult(response, "inspect_binary_layout");
      }
      assert.equal(value.artifact.sha256, hash(bytes));
      assert.equal(value.artifact.bytes, bytes.length);
      assert.equal(value.runtime_load_base, null);
      assert.equal(value.linkage.runtime_library_paths, null);
      checkLimits(value);
      if (name === "protected") {
        assert.deepEqual(value.mitigations, {
          evidence_kind: "inferred",
          position_independent: true,
          nx_indicator: true,
          executable_stack_indicator: false,
          stack_canary_indicator: true,
          relro: "Full",
        });
        assert.ok(
          value.linkage.got.some((item) => item.display_name === "snprintf"),
        );
        assert.ok(
          value.linkage.plt.some((item) => item.display_name === "snprintf"),
        );
      }
      if (name === "plain") {
        assert.equal(value.mitigations.position_independent, false);
        assert.equal(value.mitigations.stack_canary_indicator, false);
        assert.equal(value.mitigations.executable_stack_indicator, true);
        assert.equal(value.mitigations.relro, null);
      }
      if (name === "relocatable") {
        assert.equal(value.image_type, "ET_REL");
        assert.equal(value.entry_point.meaning, "not-applicable");
        assert.ok(
          value.symbols.some(
            (symbol) => symbol.value_meaning === "section-offset",
          ),
        );
      }
      if (name === "packed-relative") {
        assert.ok(value.packed_relative_relocations.length > 0);
        for (const table of value.packed_relative_relocations) {
          const offset = Number(BigInt(table.location.offset)),
            size = Number(BigInt(table.location.bytes));
          assert.deepEqual(
            Buffer.from(table.encoded_bytes_base64, "base64"),
            bytes.subarray(offset, offset + size),
          );
          assert.equal(table.addends, null);
        }
      }
      if (previous) assert.deepEqual(value, previous);
      else previous = value;
      assert.deepEqual(await readFile(path), bytes);
      records.push({ operation: "inspect_binary_layout", mode, name, value });
    }
  }
  core = await connectRecordedCrash({ entrypoint, environment });
  for (const mode of ["cli", "mcp"]) {
    const value = await core.inspect(mode, corePath);
    assert.equal(value.threads.length, 2);
    assert.ok(
      value.threads.some((thread) =>
        thread.registers.some(
          (register) =>
            register.name === "rdi" && register.value === "0x1122334455667788",
        ),
      ),
    );
    assert.ok(
      value.threads.some((thread) =>
        thread.registers.some(
          (register) =>
            register.name === "r12" && register.value === "0xfedcba9876543210",
        ),
      ),
    );
    assert.ok(
      value.signals.some(
        (signal) => signal.number === 11 && signal.fault_address === "0x123",
      ),
    );
    checkLimits(value);
    records.push({
      operation: "inspect_recorded_crash",
      mode,
      name: "original",
      value,
    });
    for (const [name, category] of [
      ["linux-osabi"],
      ["extended-program-count"],
      ["zero-note-tail"],
      ["negative-pid"],
      ["opaque-owner"],
      ["unknown-signals"],
      ["missing-notes"],
      ["historical-pid-collision"],
      ["solaris-osabi", "unsupported_target"],
      ["freebsd-osabi", "unsupported_target"],
      ["unsupported-abi-version", "unsupported_target"],
      ["truncated-header", "invalid_input"],
      ["truncated-status", "invalid_input"],
      ["truncated-owner", "invalid_input"],
      ["nonzero-note-tail", "invalid_input"],
    ]) {
      const observed = await core.inspect(
        mode,
        join(fixtures, name + ".core"),
        category ? { category } : {},
      );
      if (name === "negative-pid")
        assert.ok(
          observed.threads.some((thread) => thread.historical_pid === -2),
        );
      if (name === "historical-pid-collision") {
        assert.ok(
          observed.threads.some((thread) => thread.historical_pid === 12345),
        );
        assert.equal(observed.live_process_identity, "unknown");
      }
      records.push({
        operation: "inspect_recorded_crash",
        mode,
        name,
        value: observed,
      });
    }
  }
} finally {
  const failures = [];
  for (const cleanup of [
    async () => {
      if (core) await core.close();
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
    throw new AggregateError(failures, "Pwntools verification cleanup failed");
}
await writeFile(
  report,
  JSON.stringify(
    {
      status: "passed",
      host: process.platform,
      workspace,
      cases: records.length,
      fixture_generation_sha256: hash(
        await readFile(join(fixtures, "generation.json")),
      ),
      records,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify({ status: "passed", cases: records.length, report }),
);
