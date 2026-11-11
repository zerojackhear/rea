// Analyze caller-built PSP fixtures without executing them or invoking a compiler.
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
import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import { parseAnalysisSnapshot } from "../dist/domain/analysisSnapshot.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { functionDossierSchema } from "../dist/domain/hopperValues.js";
import { runOwnedCommand } from "../dist/process/OwnedCommand.js";
import {
  assertPspLoadedImage,
  assertPspProbe,
  parsePspReadelfAbi,
} from "../tests/conformance/ghidra/psp-fixture.mjs";
import {
  requireMcpOperationResult,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";

const { values } = parseArgs({
  options: {
    fixtures: { type: "string" },
    report: { type: "string" },
    "without-extension": { type: "boolean", default: false },
  },
});
assert.ok(
  values.fixtures && values.report,
  "--fixtures and --report are required",
);
assert.ok(isAbsolute(process.env.GHIDRA_INSTALL_DIR ?? ""));
assert.ok(isAbsolute(process.env.JAVA_HOME ?? ""));
const root = fileURLToPath(new URL("../", import.meta.url));
const report = resolve(values.report);
await mkdir(dirname(report), { recursive: true });
const workspace = await mkdtemp(join(dirname(report), "psp-native-"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtures = [];
for (const [name, expected] of [
  ["a", 7],
  ["b", 11],
]) {
  const directory = join(resolve(values.fixtures), name);
  const generationBytes = await readFile(join(directory, "generation.json"));
  const recorded = JSON.parse(generationBytes.toString("utf8"));
  assert.equal(recorded.executed_target, false);
  assert.equal(recorded.global_value, expected);
  for (const source of ["main.c", "probe.S", "Makefile"])
    assert.equal(
      hash(await readFile(join(root, "tests/conformance/psp", source))),
      recorded.source_sha256[source],
    );
  assert.deepEqual(
    parsePspReadelfAbi(recorded.readelf),
    recorded.mips.abiFlags,
  );
  const path = join(workspace, `自有 PSP ${name}.elf`);
  await copyFile(join(directory, "rea_psp_fixture.elf"), path);
  assert.equal(hash(await readFile(path)), recorded.sha256);
  const parsed = await parseBinaryTarget(path);
  if (!parsed.ok) throw parsed.error;
  assert.equal(parsed.value.architecture, "mips");
  assert.deepEqual(parsed.value.mips.abiFlags, recorded.mips.abiFlags);
  assert.equal(parsed.value.mips.flags, 0x10a23001);
  fixtures.push({
    ...recorded,
    path,
    generation_sha256: hash(generationBytes),
  });
}
const [a, b] = fixtures;
assert.notEqual(a.sha256, b.sha256);
assert.equal(a.symbols.rea_psp_global, b.symbols.rea_psp_global);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined),
);
env.REA_ANALYSIS_PROVIDER = "ghidra";
env.REA_LOG_LEVEL = "silent";
env.REA_PROCESS_RUN_ID = randomUUID();
const entrypoint = join(root, "scripts/rea.mjs");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env,
  stderr: "pipe",
});
const client = new Client({
  name: "rea-psp-native-verification",
  version: "1",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-65536);
});
const calls = [];
async function call(name, args = {}, error = false) {
  const reply = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 240000,
  });
  const result = error
    ? requireMcpToolError(reply)
    : requireMcpOperationResult(reply, name);
  calls.push({ name, arguments: args, expected_error: error, result });
  return result;
}
async function cli() {
  const result = await runOwnedCommand(
    {
      command: process.execPath,
      arguments: [
        entrypoint,
        "function",
        a.path,
        "rea_psp_entry",
        "--provider",
        "ghidra",
        "--json",
      ],
      cwd: root,
      runId: randomUUID(),
      hostEnvironment: env,
    },
    {
      timeoutMs: 300000,
      diagnosticBytes: 16 * 1024 * 1024,
      acceptNonZeroExit: values["without-extension"],
    },
  );
  await writeFile(join(workspace, "cli.json"), result.stdout.text);
  await writeFile(join(workspace, "cli.stderr.log"), result.stderr.text);
  return result;
}
let failure;
let snapshot;
try {
  await client.connect(transport);
  if (values["without-extension"]) {
    const error = await call(
      "open_binary",
      { path: a.path, provider_id: "ghidra" },
      true,
    );
    assert.match(JSON.stringify(error), /PSP_EXTENSION_UNAVAILABLE/u);
    const result = await cli();
    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stdout.text + result.stderr.text,
      /PSP_EXTENSION_UNAVAILABLE/u,
    );
  } else {
    const target = await call("open_binary", {
      path: a.path,
      provider_id: "ghidra",
    });
    assert.equal(target.sha256, a.sha256);
    const image = await call("inspect_native_load_image");
    assertPspLoadedImage(image.observations, a.sha256);
    const procedures = await call("list_procedures");
    for (const name of ["rea_psp_entry", "rea_psp_leaf", "rea_psp_probe"]) {
      const procedure = procedures.find((p) => p.value === name);
      assert.ok(procedure, name);
      assert.equal(BigInt(procedure.address), BigInt(a.symbols[name]));
    }
    const probe = a.symbols.rea_psp_probe;
    assertPspProbe(
      await call("inspect_native_instruction", { address: probe }),
      await call("inspect_native_instruction", {
        address: `0x${(BigInt(probe) + 4n).toString(16)}`,
      }),
    );
    const marker = "rea-psp-source-owned-fixture\0";
    assert.equal(
      (
        await call("read_bytes", {
          address: a.symbols.rea_psp_marker,
          length: Buffer.byteLength(marker),
        })
      ).bytes_hex,
      Buffer.from(marker).toString("hex"),
    );
    const callees = await call("procedure_callees", {
      procedure: a.symbols.rea_psp_entry,
    });
    assert.ok(
      callees.some(
        (address) => BigInt(address) === BigInt(a.symbols.rea_psp_leaf),
      ),
    );
    const assembly = await call("procedure_assembly", {
      procedure: a.symbols.rea_psp_entry,
    });
    assert.ok(assembly.trim().length > 0);
    const dossier = functionDossierSchema.parse(
      await call("analyze_function", { procedure: a.symbols.rea_psp_entry }),
    );
    assert.ok(dossier.pseudocode.trim().length > 0);
    const mapping = await call("address_to_file_offset", {
      address: a.symbols.rea_psp_entry,
    });
    const bytes = await call("read_bytes", {
      address: a.symbols.rea_psp_entry,
      length: 16,
    });
    assert.equal(
      bytes.bytes_hex,
      (await readFile(a.path))
        .subarray(mapping.file_offset, mapping.file_offset + 16)
        .toString("hex"),
    );
    const word = await call("read_bytes", {
      address: a.symbols.rea_psp_global,
      length: 4,
    });
    assert.equal(word.bytes_hex, "07000000");
    const snapshotPath = join(workspace, "psp.snapshot.json");
    await call("close_binary", { snapshot_path: snapshotPath });
    const snapshotBytes = await readFile(snapshotPath);
    const saved = parseAnalysisSnapshot(
      JSON.parse(snapshotBytes.toString("utf8")),
    );
    const parameters = saved.binding.analysis_profile.parameters;
    assert.equal(parameters.language_id, "Allegrex:LE:32:default");
    assert.equal(parameters.mips_elf.flags, 0x10a23001);
    assert.match(parameters.psp_extension.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(
      saved.evidence_bundle.records.some((record) =>
        JSON.stringify(record).includes("VFPU prefix"),
      ),
    );
    for (const record of saved.evidence_bundle.records)
      assert.equal(parseEvidence(record).subject?.architecture, "mips");
    snapshot = {
      path: snapshotPath,
      sha256: hash(snapshotBytes),
      evidence_records: saved.evidence_bundle.records.length,
      profile: parameters,
    };
    await call("open_binary", {
      path: a.path,
      provider_id: "ghidra",
      snapshot_path: snapshotPath,
    });
    assert.deepEqual(await call("list_procedures"), procedures);
    assert.equal(
      (
        await call("read_bytes", {
          address: a.symbols.rea_psp_global,
          length: 4,
        })
      ).bytes_hex,
      "07000000",
    );
    await call("close_binary");
    for (const fixture of [b, a]) {
      assert.equal(
        (
          await call("open_binary", {
            path: fixture.path,
            provider_id: "ghidra",
          })
        ).sha256,
        fixture.sha256,
      );
      const expected = Buffer.alloc(4);
      expected.writeUInt32LE(fixture.global_value);
      assert.equal(
        (
          await call("read_bytes", {
            address: fixture.symbols.rea_psp_global,
            length: 4,
          })
        ).bytes_hex,
        expected.toString("hex"),
      );
      await call("close_binary");
    }
    await call(
      "open_binary",
      { path: b.path, provider_id: "ghidra", snapshot_path: snapshotPath },
      true,
    );
    await call("open_binary", { path: a.path, provider_id: "ghidra" });
    await call("close_binary");
    const result = await cli();
    assert.equal(result.exitCode, 0, result.stderr.text);
    const evidence = parseEvidence(JSON.parse(result.stdout.text));
    assert.equal(evidence.subject?.digest.sha256, a.sha256);
    assert.equal(evidence.subject?.architecture, "mips");
    const cliDossier = functionDossierSchema.parse(evidence.normalized_result);
    assert.equal(cliDossier.procedure.address, dossier.procedure.address);
    assert.ok(cliDossier.pseudocode.trim().length > 0);
  }
  for (const fixture of fixtures)
    assert.equal(hash(await readFile(fixture.path)), fixture.sha256);
} catch (cause) {
  failure = cause;
} finally {
  try {
    await client.close();
  } finally {
    await transport.close();
  }
  await writeFile(join(workspace, "mcp.stderr.log"), stderr);
}
await writeFile(
  report,
  JSON.stringify(
    {
      status: failure ? "failed" : "passed",
      platform: process.platform,
      arch: process.arch,
      workspace,
      target_executed: false,
      missing_extension: values["without-extension"],
      mcp_calls: calls.length,
      cli_calls: 1,
      fixtures,
      snapshot,
      calls,
      failure: failure ? String(failure.stack ?? failure) : null,
      cleanup:
        "MCP close awaited; whole process family must be verified by the invoking native Job owner",
      limitations: [
        "Static ELF32 Allegrex only; no PSP emulation, PRX/PBP/ISO or complete VFPU prefix semantics",
        "Fixture generation may use Linux; provider analysis runs on the recorded host",
      ],
    },
    null,
    2,
  ),
  { flag: "wx" },
);
if (failure) throw failure;
console.log(
  JSON.stringify({
    report,
    status: "passed",
    mcp_calls: calls.length,
    cli_calls: 1,
  }),
);
