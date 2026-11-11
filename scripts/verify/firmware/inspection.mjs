// Real inspection lane, independent of extraction and external fixture compilers.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { runOwnedCommand } from "../../../dist/process/OwnedCommand.js";
const { values } = parseArgs({ options: { report: { type: "string" } } });
assert.ok(
  values.report,
  "--report is required (a new retained verification receipt)",
);
const command = process.env.REA_BINWALK_COMMAND;
assert.ok(
  command && isAbsolute(command),
  "REA_BINWALK_COMMAND must be an absolute native executable path",
);
const report = resolve(values.report);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const entrypoint = join(root, "scripts/rea.mjs");
await mkdir(dirname(report), { recursive: true });
const workspace = await mkdtemp(join(dirname(report), "firmware-native-"));
const input = join(workspace, "固件 firmware.bin");
const empty = join(workspace, "no signatures.bin");
const packed = gzipSync(
  Buffer.from("REA independently produced firmware payload\n".repeat(9)),
);
const original = Buffer.concat([
  Buffer.alloc(64, 0xff),
  packed,
  Buffer.alloc(128),
]);
const noSignatures = Buffer.alloc(256, 0x61);
await writeFile(input, original);
await writeFile(empty, noSignatures);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const executableDigest = digest(await readFile(command));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env,
  stderr: "pipe",
});
const client = new Client({
  name: "rea-native-firmware-inspection",
  version: "1",
});
const records = [];
try {
  await client.connect(transport);
  for (const [path, bytes, compressed] of [
    [input, original, packed.length],
    [empty, noSignatures, null],
  ]) {
    let reference;
    for (const mode of ["cli", "mcp"]) {
      let evidence;
      if (mode === "cli") {
        const out = await runOwnedCommand(
          {
            command: process.execPath,
            arguments: [
              entrypoint,
              "inspect-firmware-regions",
              path,
              "--format",
              "json",
            ],
            cwd: root,
            runId: randomUUID(),
            hostEnvironment: env,
          },
          { timeoutMs: 150000, diagnosticBytes: 16 * 1024 * 1024 },
        );
        evidence = JSON.parse(out.stdout.text);
      } else {
        const out = await client.callTool(
          { name: "inspect_firmware_regions", arguments: { path } },
          { timeout: 150000 },
        );
        assert.notEqual(out.isError, true, JSON.stringify(out));
        evidence = out.structuredContent;
      }
      assert.equal(evidence.subject.digest.sha256, digest(bytes));
      assert.equal(
        evidence.normalized_result.engine.executable_sha256,
        executableDigest,
      );
      assert.equal(evidence.normalized_result.input_size, bytes.length);
      if (compressed !== null) {
        const region = evidence.normalized_result.regions.find(
          (x) => x.signature === "gzip" && x.offset === 64,
        );
        assert.ok(region, JSON.stringify(evidence));
        assert.equal(region.reported_size, compressed);
      } else assert.deepEqual(evidence.normalized_result.regions, []);
      const regions = evidence.normalized_result.regions.map(
        ({ provider_id, ...value }) => value,
      );
      if (reference) assert.deepEqual(regions, reference);
      else reference = regions;
      records.push({ mode, path, evidence });
    }
    assert.equal(digest(await readFile(path)), digest(bytes));
  }
  for (const path of [join(workspace, "missing.bin"), "relative.bin"]) {
    const response = await client.callTool({
      name: "inspect_firmware_regions",
      arguments: { path },
    });
    assert.equal(response.isError, true);
    records.push({
      mode: "mcp",
      path,
      error: response.structuredContent ?? response.content,
    });
  }
} finally {
  const failures = [];
  for (const cleanup of [() => client.close(), () => transport.close()])
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  if (failures.length)
    throw new AggregateError(failures, "Firmware verification cleanup failed");
}
await writeFile(
  report,
  JSON.stringify(
    {
      status: "passed",
      host: process.platform,
      workspace,
      executable_sha256: executableDigest,
      cases: records.length,
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
