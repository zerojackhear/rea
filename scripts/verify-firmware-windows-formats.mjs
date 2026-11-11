import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
const R = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "win32")
  throw new Error("Requires a real Windows host");
const [manifestPath, ...names] = process.argv.slice(2);
if (!manifestPath || !process.env.REA_UNBLOB_COMMAND)
  throw new Error(
    "Pass a fixture receipt and set REA_UNBLOB_COMMAND to its inventoried python.exe",
  );
const fixture = JSON.parse(await readFile(manifestPath, "utf8"));
assert(
  Array.isArray(fixture.cases) &&
    fixture.cases.length > 0 &&
    fixture.cases.length <= 100,
);
for (const spec of fixture.cases) {
  assert.match(spec.name, /^[a-z0-9][a-z0-9-]{0,79}$/);
  assert(
    ["complete", "partial"].includes(spec.coverage),
    "Every fixture needs an explicit expected coverage",
  );
  assert(
    spec.expected_sha256 === null ||
      /^[a-f0-9]{64}$/.test(spec.expected_sha256),
  );
}
assert.equal(
  new Set(fixture.cases.map((c) => c.name)).size,
  fixture.cases.length,
);
const requested = new Set(
  names.length ? names : fixture.cases.map((c) => c.name),
);
const selected = fixture.cases.filter((c) => requested.has(c.name));
assert.equal(selected.length, requested.size, "unknown selected case");
const fixtureDir = dirname(manifestPath),
  env = { ...process.env };
const P = join(R, ".cache/windows-firmware-verification");
await mkdir(P, { recursive: true });
const out = join(P, "native-formats-" + randomUUID().slice(0, 8));
await mkdir(out);
const verifierSource = await readFile(fileURLToPath(import.meta.url));
const runtimeManifest = await readFile(
  join(dirname(env.REA_UNBLOB_COMMAND), "rea-unblob-runtime.json"),
);
const admission = {
  fixture_manifest: manifestPath,
  fixture_manifest_sha256: createHash("sha256")
    .update(await readFile(manifestPath))
    .digest("hex"),
  runtime_manifest_sha256: createHash("sha256")
    .update(runtimeManifest)
    .digest("hex"),
  verifier_sha256: createHash("sha256").update(verifierSource).digest("hex"),
};
await writeFile(join(out, "verifier.mjs"), verifierSource);
await writeFile(join(out, "runtime-manifest.json"), runtimeManifest);
await writeFile(
  join(out, "admission.json"),
  JSON.stringify(admission, null, 2),
);
const cases = [];
const require = createRequire(join(R, "package.json"));
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client"))
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client/stdio"))
);
async function check(evidence, spec) {
  assert.equal(evidence.operation, "extract_firmware");
  const value = evidence.normalized_result;
  if (spec.coverage !== null)
    assert.equal(
      value.coverage,
      spec.coverage,
      JSON.stringify(value.diagnostics),
    );
  for (const file of value.files) {
    const bytes = await readFile(file.path);
    assert.equal(bytes.length, file.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  if (spec.expected_sha256)
    assert(
      value.files.some((f) => f.sha256 === spec.expected_sha256),
      "expected payload absent",
    );
  if (spec.coverage === "partial")
    assert(
      value.diagnostics.length || value.extraction_gaps?.length,
      "missing partial evidence",
    );
  if (spec.must_diagnostic)
    assert(
      JSON.stringify(value.diagnostics).includes(spec.must_diagnostic),
      "required failure reason absent",
    );
  if (spec.sparse_unknown_ranges) {
    const maps = value.files.filter((file) =>
      file.path.endsWith("sparse-map.json"),
    );
    assert.equal(maps.length, 1, "missing sparse source-content mapping");
    const mapping = JSON.parse(await readFile(maps[0].path, "utf8"));
    assert.equal(mapping.source_format, "android-sparse");
    assert.equal(mapping.materialization_complete, true);
    assert.deepEqual(
      mapping.unknown_ranges.map(({ output_offset, bytes }) => ({
        output_offset,
        bytes,
      })),
      spec.sparse_unknown_ranges,
    );
    const raw = await readFile(
      join(dirname(maps[0].path), mapping.output_file),
    );
    for (const { output_offset, bytes } of mapping.unknown_ranges)
      assert(
        raw
          .subarray(output_offset, output_offset + bytes)
          .every((byte) => byte === 0),
      );
  }
  if (spec.archive_streams || spec.archive_path_base64) {
    const maps = value.files.filter((f) => f.path.endsWith("archive-map.json"));
    assert.equal(maps.length, 1, "missing unique legacy archive mapping");
    const mapping = JSON.parse(await readFile(maps[0].path, "utf8"));
    const streams = mapping.entries.filter((entry) => !entry.directory);
    for (const entry of streams) {
      assert.equal(typeof entry.resource_fork, "boolean");
      assert.equal(typeof entry.directory, "boolean");
      assert.equal(typeof entry.encoding_known, "boolean");
      assert.equal(entry.status, "complete");
      assert.match(entry.exported_name, /^\d{5}\.bin$/);
      assert(
        value.files.some(
          (file) =>
            file.path === join(dirname(maps[0].path), entry.exported_name) &&
            file.sha256 === entry.sha256 &&
            file.size === entry.bytes,
        ),
        "mapped fork missing from retained Evidence",
      );
    }
    if (spec.archive_streams) {
      const coordinate = (name, resource, bytes, sha256) =>
        JSON.stringify([name, resource, bytes, sha256]);
      assert.deepEqual(
        streams
          .map((entry) =>
            coordinate(
              entry.display_name,
              entry.resource_fork,
              entry.bytes,
              entry.sha256,
            ),
          )
          .sort(),
        spec.archive_streams
          .map((entry) =>
            coordinate(
              entry.source_path,
              entry.resource_fork,
              entry.bytes,
              entry.sha256,
            ),
          )
          .sort(),
        "independent legacy data/resource fork oracle mismatch",
      );
    }
    if (spec.archive_path_base64)
      assert.deepEqual(
        streams.map((entry) => entry.decoder_path_base64),
        spec.archive_path_base64,
      );
  }
  if (spec.must_no_complete_archive_entries) {
    for (const file of value.files.filter((f) =>
      f.path.endsWith("archive-map.json"),
    )) {
      const mapping = JSON.parse(await readFile(file.path, "utf8"));
      assert(!mapping.entries.some((entry) => entry.status === "complete"));
    }
  }
  if (spec.streams) {
    const maps = value.files.filter((f) => f.path.endsWith("stream-map.json"));
    assert.equal(maps.length, 1, "missing unique NTFS stream mapping");
    const mapping = JSON.parse(await readFile(maps[0].path, "utf8"));
    assert.equal(mapping.source_format, "ntfs");
    assert.equal(mapping.entries.length, Object.keys(spec.streams).length);
    for (const entry of mapping.entries) {
      assert.equal(entry.status, "complete");
      assert.equal(
        entry.sha256,
        spec.streams[entry.source_path],
        "independent NTFS stream oracle mismatch",
      );
      assert.match(entry.exported_name, /^\d+\.bin$/);
      const path = join(dirname(maps[0].path), entry.exported_name);
      assert(
        value.files.some((f) => f.path === path && f.sha256 === entry.sha256),
        "mapped stream missing from retained Evidence",
      );
    }
  }
  return {
    coverage: value.coverage,
    files: value.files.map((f) => ({
      path: f.relative_path,
      bytes: f.size,
      sha256: f.sha256,
    })),
    diagnostics: value.diagnostics,
    gaps: value.extraction_gaps,
  };
}
async function run(spec, adapter, client) {
  const name = spec.name + "-" + adapter,
    start = Date.now();
  try {
    let evidence;
    if (adapter === "cli") {
      const child = spawn(
        process.execPath,
        [
          join(R, "scripts/rea.mjs"),
          "extract-firmware",
          spec.path,
          join(out, name + "-files"),
          "--format",
          "json",
        ],
        {
          cwd: R,
          env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          signal: AbortSignal.timeout(180000),
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      const code = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      await writeFile(join(out, name + ".stdout"), stdout);
      await writeFile(join(out, name + ".stderr"), stderr);
      assert.equal(code, 0, stderr);
      evidence = JSON.parse(stdout);
    } else {
      const response = await client.callTool(
        {
          name: "extract_firmware",
          arguments: {
            path: spec.path,
            output_directory: join(out, name + "-files"),
          },
        },
        { timeout: 180000 },
      );
      await writeFile(
        join(out, name + ".response.json"),
        JSON.stringify(response, null, 2),
      );
      assert.notEqual(
        response.isError,
        true,
        "MCP error; see retained response",
      );
      evidence = response.structuredContent;
    }
    await writeFile(
      join(out, name + ".evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    cases.push({
      name,
      status: "passed",
      elapsed_ms: Date.now() - start,
      ...(await check(evidence, spec)),
    });
  } catch (error) {
    cases.push({
      name,
      status: "failed",
      elapsed_ms: Date.now() - start,
      error: error.stack,
    });
  }
  console.log(
    JSON.stringify({
      name,
      status: cases.at(-1).status,
      coverage: cases.at(-1).coverage,
      error: cases.at(-1).error?.slice(0, 600),
    }),
  );
  await writeFile(
    join(out, "receipt.json"),
    JSON.stringify({ status: "running", fixtures: fixtureDir, cases }, null, 2),
  );
}
for (const spec of selected) await run(spec, "cli");
let client, transport;
try {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(R, "scripts/rea.mjs"), "mcp"],
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (b) => (stderr += b));
  client = new Client({ name: "rea-native-format-verifier", version: "1" });
  await client.connect(transport, { timeout: 30000 });
  for (const name of requested)
    await run(
      fixture.cases.find((c) => c.name === name),
      "mcp",
      client,
    );
  await writeFile(join(out, "mcp.stderr"), stderr);
} finally {
  await client?.close();
  await transport?.close();
}
const status = cases.every((c) => c.status === "passed") ? "passed" : "failed";
await writeFile(
  join(out, "receipt.json"),
  JSON.stringify({ status, fixtures: fixtureDir, cases }, null, 2),
);
console.log(JSON.stringify({ status, evidence: out }));
if (status !== "passed") process.exitCode = 1;
