import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const R = fileURLToPath(new URL("..", import.meta.url));
assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
const P = join(R, ".cache/windows-native-rest-20261110");
const gdb = JSON.parse(
  await readFile(join(P, "current-windows-gdb.json"), "utf8"),
);
const fixture = JSON.parse(
  await readFile(join(P, "current-debugger-fixture.json"), "utf8"),
);
const sha = (b) => createHash("sha256").update(b).digest("hex");
assert.equal(sha(await readFile(fixture.command)), fixture.sha256);
assert.equal(
  fixture.sha256,
  "57eb74dc8da744c972ee479022b08073a07be38fcaeac41eca45f8196de262fd",
);
const out = join(P, "gdb-public-" + randomUUID().slice(0, 8));
await mkdir(out);
await writeFile(
  join(out, "verifier.mjs"),
  await readFile(fileURLToPath(import.meta.url)),
);
const env = {
  ...process.env,
  REA_GDB_COMMAND: gdb.command,
  PATH: dirname(gdb.command) + ";" + process.env.PATH,
  PYTHONHOME: dirname(dirname(gdb.command)),
};
delete env.PYTHONPATH;
const require = createRequire(join(R, "package.json"));
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client"))
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client/stdio"))
);
const { toolContract } = await import(
  pathToFileURL(join(R, "dist/contracts/toolContracts.js"))
);
const { requireWindowsNativeAuthority } = await import(
  pathToFileURL(join(R, "dist/windows/WindowsNativeLoader.js"))
);
const native = requireWindowsNativeAuthority();
const results = [];
let ordinal = 0,
  client,
  transport,
  stderr = "",
  currentSession;
const names = process.argv.slice(2),
  selected = (name) => !names.length || names.includes(name);
const save = () =>
  writeFile(
    join(out, "receipt.json"),
    JSON.stringify(
      {
        status: results.some((x) => x.status === "failed")
          ? "failed"
          : "running",
        results,
        fixture,
        command: gdb.command,
        nativeManifest: JSON.parse(
          require("node:fs").readFileSync(
            join(R, "native/windows/build/manifest.json"),
            "utf8",
          ),
        ),
      },
      null,
      2,
    ),
  );
async function test(name, run) {
  if (!selected(name)) return;
  const start = performance.now();
  try {
    await run();
    results.push({
      name,
      status: "passed",
      elapsed_ms: Math.round(performance.now() - start),
    });
  } catch (error) {
    results.push({ name, status: "failed", error: error.stack });
  }
  console.log(JSON.stringify(results.at(-1)));
  await save();
}
async function call(name, args = {}, expectError = false) {
  const response = await client.callTool(
    { name, arguments: args },
    { timeout: 20000 },
  );
  await writeFile(
    join(out, String(++ordinal).padStart(3, "0") + "-" + name + ".json"),
    JSON.stringify(response, null, 2),
  );
  if (expectError) {
    assert.equal(
      response.isError,
      true,
      JSON.stringify(response).slice(0, 1000),
    );
    return response;
  }
  assert.notEqual(
    response.isError,
    true,
    JSON.stringify(response).slice(0, 1600),
  );
  return toolContract(name).outputSchema.parse(response.structuredContent);
}
async function command(value) {
  const result = await call("gdb_console", {
    session_id: currentSession,
    command: value,
  });
  assert.equal(result.normalized_result.completion_status, "complete");
  assert.equal(result.normalized_result.output_truncated, false);
  assert(
    !/\^error(?:,|$)/u.test(result.normalized_result.mi),
    JSON.stringify(result.normalized_result).slice(0, 1000),
  );
  return result.normalized_result;
}
async function start(sink) {
  const result = await call(
    "start_gdb_session",
    sink ? { inferior_tty: sink } : {},
  );
  currentSession = result.session_id;
  return result;
}
async function close() {
  const result = await call("close_gdb_session", {
    session_id: currentSession,
  });
  currentSession = undefined;
  return result;
}
async function sink(name) {
  const path = join(out, name + ".txt");
  await writeFile(path, "");
  return path;
}
async function inferiorPid() {
  const result = await command("info inferiors");
  const match = /process\s+(\d+)/u.exec(result.console);
  assert(match, result.console);
  return Number(match[1]);
}
const alive = (pid) => native.call("debugger_process_start", [pid]);
async function untilEnded(pid) {
  const end = Date.now() + 9000;
  while (Date.now() < end) {
    if (alive(pid) === null) return;
    await delay(50);
  }
  throw new Error("Self-owned finite target did not end");
}
async function recover() {
  if (!currentSession) return;
  try {
    await command("continue");
  } catch {
    /* Only the finite test inferior may need resuming. */
  }
  await delay(4000);
  try {
    await close();
  } catch (error) {
    console.error("Retained session cleanup:", error.message);
  }
}
async function cli(name, cmd, output, expectError = false) {
  const child = spawn(
    process.execPath,
    [
      join(R, "scripts/rea.mjs"),
      "debug-with-gdb",
      cmd,
      "--inferior-tty",
      output,
      "--format",
      "json",
    ],
    {
      cwd: R,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(20000),
    },
  );
  let stdout = "",
    errors = "";
  child.stdout.on("data", (b) => {
    stdout += b;
    assert(Buffer.byteLength(stdout) < 4 * 1024 * 1024);
  });
  child.stderr.on("data", (b) => (errors += b));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  await writeFile(join(out, name + ".stdout"), stdout);
  await writeFile(join(out, name + ".stderr"), errors);
  const value = JSON.parse(stdout || errors);
  if (expectError) {
    assert(code !== 0 || value._tag || value.error);
    assert(JSON.stringify(value).includes("NTFS"));
    return;
  }
  assert.equal(code, 0, errors);
  const evidence = toolContract("gdb_console").outputSchema.parse(value);
  assert.equal(evidence.normalized_result.completion_status, "complete");
  return evidence.normalized_result;
}
try {
  await test("cli-version", async () => {
    const result = await cli(
      "version",
      "show version",
      await sink("cli-version"),
    );
    assert(result.console.includes("GNU gdb"));
  });
  await test("cli-load-pe", async () => {
    const result = await cli(
      "file",
      "file " + fixture.command.replaceAll("\\", "/"),
      await sink("cli-file"),
    );
    assert(!result.mi.includes("^error"), result.mi);
  });
  await test("cli-reject-missing-output", () =>
    cli("missing", "show version", join(out, "absent.txt"), true));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(R, "scripts/rea.mjs"), "mcp"],
    cwd: R,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (b) => (stderr += b));
  client = new Client({ name: "rea-windows-debugger-verifier", version: "1" });
  await client.connect(transport, { timeout: 30000 });
  const catalog = await client.listTools();
  assert(
    catalog.tools
      .find((x) => x.name === "start_gdb_session")
      ?.description.includes("Windows x64"),
  );
  await test("mcp-no-inferior", async () => {
    await start();
    const version = await command("show version");
    assert(version.console.includes("GNU gdb"));
    assert.equal((await close()).target_state, "none_observed");
  });
  await test("mcp-live-detach", async () => {
    const output = await sink("mcp-detach");
    await start(output);
    await command("set mi-async on");
    await command("file " + fixture.command.replaceAll("\\", "/"));
    await command("break rea_fixture_pause");
    const run = await command("run");
    assert(
      run.records.some((line) => line.includes('reason="breakpoint-hit"')),
    );
    await delay(150);
    const pid = await inferiorPid();
    const identity = alive(pid);
    assert(identity);
    await delay(100);
    const status = await call("gdb_session_status", {
      session_id: currentSession,
    });
    assert.equal(status.inferior_tty_verified, true);
    assert.equal((await close()).target_state, "unknown");
    assert.equal(
      alive(pid),
      identity,
      "Detached target must survive debugger close",
    );
    await untilEnded(pid);
    const text = await readFile(output, "utf8");
    assert(
      text.includes("AFTER_DETACH stdout") &&
        text.includes("AFTER_DETACH stderr"),
      text,
    );
    await writeFile(
      join(out, "detached-target.json"),
      JSON.stringify(
        {
          pid,
          creation_identity: identity,
          survived: true,
          later_output: text,
        },
        null,
        2,
      ),
    );
  });
  await recover();
  await test("mcp-output-change-refused", async () => {
    const output = await sink("mcp-changed"),
      other = await sink("mcp-other");
    await start(output);
    await command("set mi-async on");
    await command("file " + fixture.command.replaceAll("\\", "/"));
    await command("break rea_fixture_pause");
    const run = await command("run");
    assert(
      run.records.some((line) => line.includes('reason="breakpoint-hit"')),
    );
    await delay(150);
    const pid = await inferiorPid();
    await delay(100);
    await command("set inferior-tty " + other.replaceAll("\\", "/"));
    const rejected = await call(
      "close_gdb_session",
      { session_id: currentSession },
      true,
    );
    assert(JSON.stringify(rejected).includes("durable"));
    assert(alive(pid));
    await command("continue");
    await untilEnded(pid);
    await close();
  });
  await recover();
  await test("mcp-invalid-output-recovery", async () => {
    await call("start_gdb_session", { inferior_tty: out }, true);
    await call(
      "start_gdb_session",
      { inferior_tty: join(out, "absent.txt") },
      true,
    );
    await start(await sink("recovery"));
    await command("show version");
    await close();
    await client.ping();
  });
} catch (error) {
  results.push({ name: "verifier", status: "failed", error: error.stack });
} finally {
  await recover();
  await client?.close();
  await writeFile(join(out, "mcp.stderr"), stderr);
  await save();
}
const receipt = JSON.parse(await readFile(join(out, "receipt.json"), "utf8"));
receipt.status = results.every((x) => x.status === "passed")
  ? "passed"
  : "failed";
await writeFile(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(
  JSON.stringify({
    out,
    status: receipt.status,
    passed: results.filter((x) => x.status === "passed").length,
    failed: results.filter((x) => x.status === "failed").length,
  }),
);
if (receipt.status !== "passed") process.exitCode = 1;
