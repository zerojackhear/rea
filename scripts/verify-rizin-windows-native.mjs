import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const R = fileURLToPath(new URL("..", import.meta.url));
assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
const P = join(R, ".cache/windows-native-rest-20261110");
const tool = JSON.parse(
  await readFile(join(P, "current-windows-rizin-fixed.json"), "utf8"),
);
const original = JSON.parse(
  await readFile(join(P, "current-windows-rizin.json"), "utf8"),
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
assert.equal(sha(await readFile(tool.command)), tool.sha256);
const out = join(P, "rizin-public-" + randomUUID().slice(0, 8));
await mkdir(out);
await writeFile(
  join(out, "verifier.mjs"),
  await readFile(fileURLToPath(import.meta.url)),
);
const env = {
  ...process.env,
  REA_RIZIN_COMMAND: tool.command,
  PATH: dirname(tool.command) + ";" + process.env.PATH,
};
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
  currentSession,
  stderr = "";
const names = process.argv.slice(2);
const alive = (pid) => native.call("debugger_process_start", [pid]);
const debugState = (pid) => native.call("debugger_process_debug_state", [pid]);
async function save() {
  await writeFile(
    join(out, "receipt.json"),
    JSON.stringify(
      {
        status: "running",
        results,
        tool,
        fixture,
        nativeManifest: JSON.parse(
          await readFile(join(R, "native/windows/build/manifest.json"), "utf8"),
        ),
      },
      null,
      2,
    ),
  );
}
async function test(name, run) {
  if (names.length && !names.includes(name)) return;
  const started = performance.now();
  try {
    await run();
    results.push({
      name,
      status: "passed",
      elapsed_ms: Math.round(performance.now() - started),
    });
  } catch (error) {
    results.push({ name, status: "failed", error: error.stack });
  }
  console.log(JSON.stringify(results.at(-1)));
  await save();
}
async function sink(name) {
  const path = join(out, name + ".txt");
  await writeFile(path, "PREFIX\n");
  return path;
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
      JSON.stringify(response).slice(0, 1200),
    );
    return response;
  }
  assert.notEqual(
    response.isError,
    true,
    JSON.stringify(response).slice(0, 1800),
  );
  return toolContract(name).outputSchema.parse(response.structuredContent);
}
async function start(output, path = fixture.command) {
  const started = await call("start_rizin_debug_session", {
    path,
    inferior_tty: output,
  });
  currentSession = started.session_id;
  return started;
}
async function command(value) {
  const evidence = await call("rizin_debug_command", {
    session_id: currentSession,
    command: value,
  });
  const result = evidence.normalized_result;
  assert.equal(result.completion_status, "complete");
  assert.equal(result.output_truncated, false);
  return result.output;
}
async function close() {
  const result = await call("close_rizin_debug_session", {
    session_id: currentSession,
  });
  currentSession = undefined;
  assert.equal(result.target_state, "unknown");
  return result;
}
function rowsPid(text) {
  const rows = JSON.parse(text);
  const row = rows.find((x) => /^w32dbg:\/\/[1-9]\d*$/u.test(x.uri));
  assert(row, text);
  return Number(row.uri.slice(9));
}
async function untilEnded(pid) {
  const end = Date.now() + 9000;
  while (Date.now() < end) {
    if (alive(pid) === null) return;
    await delay(30);
  }
  throw new Error("Self-owned finite target did not end");
}
async function lateOutput(pid, output) {
  await untilEnded(pid);
  const text = await readFile(output, "utf8");
  assert(text.startsWith("PREFIX\n"), "Existing output must not be truncated");
  assert(
    text.includes("AFTER_DETACH stdout") &&
      text.includes("AFTER_DETACH stderr"),
    text,
  );
  return text;
}
async function cli(name, output, selectedTool = tool, expectError = false) {
  const child = spawn(
    process.execPath,
    [
      join(R, "scripts/rea.mjs"),
      "debug-with-rizin",
      fixture.command,
      "olj",
      "--inferior-tty",
      output,
      "--format",
      "json",
    ],
    {
      cwd: R,
      env: {
        ...env,
        REA_RIZIN_COMMAND: selectedTool.command,
        PATH: dirname(selectedTool.command) + ";" + process.env.PATH,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(30000),
    },
  );
  let stdout = "",
    errors = "";
  child.stdout.on("data", (b) => {
    stdout += b;
    assert(Buffer.byteLength(stdout) < 4 * 1024 * 1024);
  });
  child.stderr.on("data", (b) => {
    errors += b;
    assert(Buffer.byteLength(errors) < 4 * 1024 * 1024);
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  await writeFile(join(out, name + ".stdout"), stdout);
  await writeFile(join(out, name + ".stderr"), errors);
  const value = JSON.parse(stdout || errors);
  if (expectError) {
    assert(JSON.stringify(value).includes("dbg.windows.stdio"));
    assert.equal(await readFile(output, "utf8"), "PREFIX\n");
    return;
  }
  assert.equal(code, 0, errors);
  const evidence = toolContract("rizin_debug_command").outputSchema.parse(
    value,
  );
  assert.equal(evidence.normalized_result.completion_status, "complete");
  const pid = rowsPid(evidence.normalized_result.output);
  const state = debugState(pid);
  assert(
    state && !state.attached,
    "CLI close must leave a detached live target",
  );
  await lateOutput(pid, output);
}
try {
  await test("cli-live-detach", async () => cli("cli", await sink("cli")));
  await test("cli-old-provider-rejected", async () =>
    cli("old", await sink("old"), original, true));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(R, "scripts/rea.mjs"), "mcp"],
    cwd: R,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (b) => (stderr += b));
  client = new Client({ name: "rea-rizin-windows-verifier", version: "1" });
  await client.connect(transport, { timeout: 30000 });
  const catalog = await client.listTools();
  assert(
    catalog.tools
      .find((x) => x.name === "start_rizin_debug_session")
      ?.description.includes("Windows x64"),
  );
  await test("mcp-live-detach", async () => {
    const output = await sink("mcp");
    await start(output);
    const pid = rowsPid(await command("olj"));
    const before = debugState(pid);
    assert.equal(before.attached, true);
    const registers = JSON.parse(await command("drj"));
    assert.equal(typeof registers.rip, "number");
    await close();
    const after = debugState(pid);
    assert.equal(after.startTime, before.startTime);
    assert.equal(after.attached, false);
    const text = await lateOutput(pid, output);
    await writeFile(
      join(out, "detached-target.json"),
      JSON.stringify({ before, after, later_output: text }, null, 2),
    );
  });
  await test("mcp-exitkill-change-refused", async () => {
    const output = await sink("unsafe-config");
    await start(output);
    const pid = rowsPid(await command("olj"));
    const before = debugState(pid);
    await command("e dbg.exitkills=true");
    await call(
      "close_rizin_debug_session",
      { session_id: currentSession },
      true,
    );
    assert.equal(alive(pid), before.startTime);
    assert.equal(debugState(pid).attached, true);
    await command("e dbg.exitkills=false");
    await close();
    await lateOutput(pid, output);
  });
  await test("mcp-invalid-output-recovery", async () => {
    await call(
      "start_rizin_debug_session",
      { path: fixture.command, inferior_tty: join(out, "missing.txt") },
      true,
    );
    const output = await sink("recovery");
    await start(output);
    const pid = rowsPid(await command("olj"));
    await close();
    await lateOutput(pid, output);
    await client.ping();
  });
  await test("mcp-unsupported-backend-rejected", async () => {
    const output = await sink("unsupported-backend");
    await call(
      "start_rizin_debug_session",
      { path: fixture.command, inferior_tty: output, backend: "gdb" },
      true,
    );
    assert.equal(await readFile(output, "utf8"), "PREFIX\n");
    await client.ping();
  });
  await test("mcp-missing-target-rejected", async () => {
    const output = await sink("missing-target");
    await call(
      "start_rizin_debug_session",
      { path: join(out, "absent.exe"), inferior_tty: output },
      true,
    );
    assert.equal(await readFile(output, "utf8"), "PREFIX\n");
    await client.ping();
  });
  await test("mcp-invalid-executable-recovery", async () => {
    const output = await sink("invalid-executable"),
      path = join(out, "not-an-executable.exe");
    await writeFile(path, "self-owned non-executable negative fixture\n");
    const result = await call(
      "start_rizin_debug_session",
      { path, inferior_tty: output },
      true,
    );
    assert(
      !JSON.stringify(result).includes("cleanup_incomplete"),
      JSON.stringify(result),
    );
    assert.equal(await readFile(output, "utf8"), "PREFIX\n");
    await client.ping();
  });
  await test("mcp-unicode-spaced-path", async () => {
    const path = join(out, "空 格 #&测试.exe");
    await copyFile(fixture.command, path);
    assert.equal(sha(await readFile(path)), fixture.sha256);
    const output = await sink("输出 & = 文件");
    await start(output, path);
    const pid = rowsPid(await command("olj"));
    await close();
    await lateOutput(pid, output);
  });
} catch (error) {
  results.push({ name: "verifier", status: "failed", error: error.stack });
} finally {
  if (currentSession) {
    try {
      await command("e dbg.exitkills=false");
      await close();
    } catch (error) {
      results.push({
        name: "retained-cleanup",
        status: "failed",
        error: error.stack,
      });
    }
  }
  await client?.close();
  await writeFile(join(out, "mcp.stderr"), stderr);
  await save();
}
const receipt = JSON.parse(await readFile(join(out, "receipt.json"), "utf8"));
receipt.status =
  results.length && results.every((x) => x.status === "passed")
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
