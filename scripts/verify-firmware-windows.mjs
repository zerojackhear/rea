import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
const R = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "win32")
  throw new Error("Requires a real Windows x64 host");
const P = join(R, ".cache/windows-firmware-verification");
await mkdir(P, { recursive: true });
const require = createRequire(join(R, "package.json"));
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client"))
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client/stdio"))
);
const out = join(P, "public-appcontainer-" + randomUUID().slice(0, 8));
await mkdir(out);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined),
);
if (!env.REA_UNBLOB_COMMAND)
  throw new Error(
    "Set REA_UNBLOB_COMMAND to the inventoried Windows runtime python.exe",
  );
const payload = Buffer.from(
  "REA independently generated Windows firmware fixture\n",
);
const header = Buffer.alloc(512);
header.write("hello.txt");
header.write("0000644\0", 100);
header.write("0000000\0", 108);
header.write("0000000\0", 116);
header.write(payload.length.toString(8).padStart(11, "0") + "\0", 124);
header.write("00000000000\0", 136);
header.fill(32, 148, 156);
header[156] = 48;
header.write("ustar\0", 257);
header.write("00", 263);
header.write(
  [...header]
    .reduce((a, b) => a + b, 0)
    .toString(8)
    .padStart(6, "0") + "\0 ",
  148,
);
const tar = Buffer.concat([
  header,
  payload,
  Buffer.alloc((512 - (payload.length % 512)) % 512),
  Buffer.alloc(1024),
]);
await writeFile(join(out, "regular.tar"), tar);
const local = [],
  central = [];
let position = 0;
for (const [name, data] of [
  ["inner.tar", tar],
  ["raw\0hidden.bin", payload],
  ["path\\literal.txt", payload],
]) {
  const filename = Buffer.from(name);
  const crc = crc32(data);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50);
  h.writeUInt16LE(20, 4);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(data.length, 18);
  h.writeUInt32LE(data.length, 22);
  h.writeUInt16LE(filename.length, 26);
  local.push(h, filename, data);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50);
  c.writeUInt16LE(20, 4);
  c.writeUInt16LE(20, 6);
  c.writeUInt32LE(crc, 16);
  c.writeUInt32LE(data.length, 20);
  c.writeUInt32LE(data.length, 24);
  c.writeUInt16LE(filename.length, 28);
  c.writeUInt32LE(position, 42);
  central.push(c, filename);
  position += h.length + filename.length + data.length;
}
const cd = Buffer.concat(central),
  end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(3, 8);
end.writeUInt16LE(3, 10);
end.writeUInt32LE(cd.length, 12);
end.writeUInt32LE(position, 16);
await writeFile(
  join(out, "source-names.zip"),
  Buffer.concat([...local, cd, end]),
);
const cases = [];
async function validate(evidence, expectComplete) {
  assert.equal(evidence.operation, "extract_firmware");
  const value = evidence.normalized_result;
  for (const f of value.files) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(f.path))
        .digest("hex"),
      f.sha256,
    );
    assert.equal((await stat(f.path)).size, f.size);
  }
  assert(value.files.length > 0);
  if (expectComplete) assert.equal(value.coverage, "complete");
  else {
    assert.equal(value.coverage, "partial");
    assert(value.diagnostics.some((d) => d.report?.path === "raw\0hidden.bin"));
    assert(
      value.diagnostics.some((d) => d.report?.path === "path\\literal.txt"),
    );
  }
  return {
    coverage: value.coverage,
    files: value.files.map((f) => ({
      path: f.relative_path,
      bytes: f.size,
      sha256: f.sha256,
    })),
    diagnostics: value.diagnostics,
    limitations: evidence.limitations,
  };
}
async function cli(name, input) {
  const begin = Date.now();
  const argv = [
    join(R, "scripts/rea.mjs"),
    "extract-firmware",
    input,
    join(out, name + "-files"),
    "--format",
    "json",
  ];
  const child = spawn(process.execPath, argv, {
    cwd: R,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  await writeFile(join(out, name + ".stdout"), stdout);
  await writeFile(join(out, name + ".stderr"), stderr);
  assert.equal(status, 0, stderr);
  const result = JSON.parse(stdout);
  await writeFile(join(out, name + ".json"), JSON.stringify(result, null, 2));
  const summary = await validate(result, true);
  cases.push({
    name,
    adapter: "cli",
    elapsed_ms: Date.now() - begin,
    ...summary,
  });
  console.log(JSON.stringify(cases.at(-1)));
}
let transport, client;
try {
  await cli("tar-cli", join(out, "regular.tar"));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(R, "scripts/rea.mjs"), "mcp"],
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (b) => (stderr += b));
  client = new Client({
    name: "rea-windows-production-verifier",
    version: "1",
  });
  await client.connect(transport, { timeout: 30000 });
  const listed = await client.listTools();
  assert(listed.tools.some((t) => t.name === "extract_firmware"));
  for (const [name, input, complete] of [
    ["tar-mcp", join(out, "regular.tar"), true],
    ["zip-names-mcp", join(out, "source-names.zip"), false],
  ]) {
    const begin = Date.now();
    const result = await client.callTool(
      {
        name: "extract_firmware",
        arguments: {
          path: input,
          output_directory: join(out, name + "-files"),
        },
      },
      { timeout: 180000 },
    );
    await writeFile(join(out, name + ".json"), JSON.stringify(result, null, 2));
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const summary = await validate(result.structuredContent, complete);
    cases.push({
      name,
      adapter: "mcp",
      elapsed_ms: Date.now() - begin,
      ...summary,
    });
    console.log(JSON.stringify(cases.at(-1)));
  }
  assert.deepEqual(cases[0].files, cases[1].files);
  await writeFile(join(out, "mcp.stderr"), stderr);
  await writeFile(
    join(out, "receipt.json"),
    JSON.stringify({ status: "passed", cases }, null, 2),
  );
} catch (e) {
  await writeFile(
    join(out, "receipt.json"),
    JSON.stringify({ status: "failed", error: e.stack, cases }, null, 2),
  );
  console.error(e);
  process.exitCode = 1;
} finally {
  await client?.close();
  await transport?.close();
  console.log("Evidence: " + out);
}
