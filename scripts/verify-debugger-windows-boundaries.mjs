import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const R = fileURLToPath(new URL("..", import.meta.url));
assert(process.platform === "win32" && process.arch === "x64");
const names = process.argv.slice(2);
const P = join(R, ".cache/windows-native-rest-20261110");
const data = JSON.parse(
  await readFile(join(P, "current-debugger-boundary-fixtures.json"), "utf8"),
);
const admitted = {
  "x86-normal":
    "99a6c423e5950b59ebf53ca4339a1616aa98d1e47cfd201b39fd2b30d27cc022",
  "x64-normal":
    "f2bc625f4bd647e2d2d08a061c8a3c635bd60735c543315a0c467d1d72777e5d",
  "x64-switched":
    "16cc5eb219e4e8b66fb01a15f8ea949569d9004b167de25df3dad66dd2134242",
  "x64-exception":
    "d064c3801a63bfafb2f8037d592f98803905d3b0f282a13b9757111a5986586b",
};
const sha = (b) => createHash("sha256").update(b).digest("hex");
for (const [name, fixture] of Object.entries(data.fixtures)) {
  assert.equal(fixture.sha256, admitted[name]);
  assert.equal(sha(await readFile(fixture.command)), admitted[name]);
}
const out = join(P, "debugger-boundary-public-" + randomUUID().slice(0, 8));
await mkdir(out);
await copyFile(fileURLToPath(import.meta.url), join(out, "verifier.mjs"));
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
const alive = (pid) => native.call("debugger_process_start", [pid]);
const state = (pid) => native.call("debugger_process_debug_state", [pid]);
const results = [],
  tools = {};
let ordinal = 0;
const payload = Buffer.alloc(65536 * 4);
for (let chunk = 0; chunk < 4; chunk++)
  for (let i = 0; i < 65536; i++) payload[chunk * 65536 + i] = i % 251;
const tail = Buffer.concat([payload, Buffer.from("BOUNDARY_STDERR\n")]);
async function save(status = "running") {
  await writeFile(
    join(out, "receipt.json"),
    JSON.stringify(
      {
        status,
        results,
        fixtures: data,
        tools,
        nativeManifest: JSON.parse(
          await readFile(join(R, "native/windows/build/manifest.json"), "utf8"),
        ),
      },
      null,
      2,
    ),
  );
}
async function ended(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (alive(pid) === null) return;
    await delay(25);
  }
  throw new Error("Self-owned target remains live: " + pid);
}
async function test(name, fn) {
  if (names.length && !names.includes(name)) return;
  const start = performance.now();
  try {
    await fn();
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
async function fixtureFiles(name, kind) {
  const dir = join(out, name);
  await mkdir(dir);
  const exe = join(dir, "probe.exe"),
    output = join(dir, "output.bin");
  await copyFile(data.fixtures[kind].command, exe);
  assert.equal(sha(await readFile(exe)), admitted[kind]);
  await writeFile(output, "");
  return { exe, output, switched: exe + ".switched-output.bin" };
}
for (const provider of ["gdb", "rizin"]) {
  if (names.length && !names.some((name) => name.startsWith(provider + "-")))
    continue;
  const tool = JSON.parse(
    await readFile(
      join(
        P,
        provider === "gdb"
          ? "current-windows-gdb.json"
          : "current-windows-rizin-fixed.json",
      ),
      "utf8",
    ),
  );
  const env = {
    ...process.env,
    PATH: dirname(tool.command) + ";" + process.env.PATH,
    [provider === "gdb" ? "REA_GDB_COMMAND" : "REA_RIZIN_COMMAND"]:
      tool.command,
  };
  if (provider === "gdb") {
    env.PYTHONHOME = dirname(dirname(tool.command));
    delete env.PYTHONPATH;
  }
  tools[provider] = {
    command: tool.command,
    sha256: sha(await readFile(tool.command)),
  };
  let client,
    transport,
    session,
    currentPid,
    stderr = "";
  const startTool =
    provider === "gdb" ? "start_gdb_session" : "start_rizin_debug_session";
  const commandTool =
    provider === "gdb" ? "gdb_console" : "rizin_debug_command";
  const closeTool =
    provider === "gdb" ? "close_gdb_session" : "close_rizin_debug_session";
  async function call(name, args, error = false) {
    const response = await client.callTool(
      { name, arguments: args },
      { timeout: 20000 },
    );
    await writeFile(
      join(out, String(++ordinal).padStart(3, "0") + "-" + name + ".json"),
      JSON.stringify(response, null, 2),
    );
    if (error) {
      assert.equal(
        response.isError,
        true,
        JSON.stringify(response).slice(0, 1500),
      );
      return response;
    }
    assert.notEqual(
      response.isError,
      true,
      JSON.stringify(response).slice(0, 2000),
    );
    return toolContract(name).outputSchema.parse(response.structuredContent);
  }
  async function command(value) {
    const response = await call(commandTool, {
      session_id: session,
      command: value,
    });
    const result = response.normalized_result;
    assert.equal(
      result.completion_status,
      "complete",
      JSON.stringify(result).slice(0, 2000),
    );
    assert.equal(result.output_truncated, false);
    if (provider === "gdb")
      assert(
        !/\^error(?:,|$)/u.test(result.mi),
        JSON.stringify(result).slice(0, 1200),
      );
    return result;
  }
  async function close(error = false) {
    const response = await call(closeTool, { session_id: session }, error);
    if (!error) session = undefined;
    return response;
  }
  async function start(files, breakpoint) {
    session = (
      await call(startTool, {
        inferior_tty: files.output,
        ...(provider === "rizin" ? { path: files.exe } : {}),
      })
    ).session_id;
    if (provider === "gdb") {
      await command("set mi-async on");
      await command("file " + files.exe.replaceAll("\\", "/"));
      await command("break rea_boundary_pause");
      const run = await command("run");
      assert(
        run.records.some((row) => row.includes('reason="breakpoint-hit"')),
        JSON.stringify(run),
      );
      const match = /process\s+(\d+)/u.exec(
        (await command("info inferiors")).console,
      );
      assert(match);
      currentPid = Number(match[1]);
    } else {
      const rows = JSON.parse((await command("olj")).output);
      const row = rows.find((row) => /^w32dbg:\/\/[1-9]\d*$/u.test(row.uri));
      assert(row, JSON.stringify(rows));
      currentPid = Number(row.uri.slice(9));
      if (breakpoint) {
        const symbols = JSON.parse((await command("isj")).output);
        const selected = symbols.find(
          (row) =>
            row.name === "rea_boundary_pause" && row.is_imported === false,
        );
        assert(
          selected &&
            Number.isSafeInteger(selected.vaddr) &&
            selected.vaddr > 0,
        );
        await command("db @ " + selected.vaddr);
        const breakpoints = JSON.parse((await command("dblj")).output);
        assert(
          breakpoints.some((row) => row.addr === selected.vaddr),
          "The provider must list the selected breakpoint",
        );
        let reached = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          await command("dc");
          const registers = JSON.parse((await command("drj")).output || "{}");
          if (registers.rip === selected.vaddr) {
            reached = true;
            break;
          }
        }
        assert(reached, "The fixture breakpoint must actually be reached");
      }
    }
    assert(alive(currentPid));
    return currentPid;
  }
  async function resume() {
    return command(provider === "gdb" ? "continue" : "dc");
  }
  async function recover() {
    if (!session) return;
    for (let i = 0; i < 4 && currentPid && alive(currentPid) !== null; i++) {
      try {
        await resume();
      } catch (error) {
        console.error("Recovery continue: " + error.message.slice(0, 600));
        break;
      }
    }
    try {
      await close();
    } catch (error) {
      results.push({
        name: provider + "-cleanup",
        status: "failed",
        error: error.stack,
      });
    }
  }
  try {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(R, "scripts/rea.mjs"), "mcp"],
      cwd: R,
      env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (b) => {
      stderr += b;
      if (Buffer.byteLength(stderr) > 2 * 1024 * 1024)
        stderr = stderr.slice(-1024 * 1024);
    });
    client = new Client({
      name: "rea-debugger-boundary-verifier",
      version: "1",
    });
    await client.connect(transport, { timeout: 30000 });
    for (const kind of ["x64-normal", "x86-normal"]) {
      await test(provider + "-" + kind + "-exit", async () => {
        const files = await fixtureFiles(provider + "-" + kind, kind);
        const pid = await start(files, false);
        if (kind === "x86-normal") {
          const before = state(pid);
          const refusal = await close(true);
          assert(
            JSON.stringify(refusal).includes("x64"),
            JSON.stringify(refusal).slice(0, 2000),
          );
          assert(!JSON.stringify(refusal).includes("cleanup_incomplete"));
          assert.deepEqual(
            state(pid),
            before,
            "Refused close must preserve the live debug session",
          );
        }
        for (let i = 0; i < 4 && alive(pid) !== null; i++) await resume();
        await ended(pid);
        await close();
        const bytes = await readFile(files.output);
        assert(
          bytes.subarray(-tail.length).equals(tail),
          "Binary target output must be complete and outside protocol framing",
        );
        await client.ping();
        await writeFile(
          join(dirname(files.output), "observed.json"),
          JSON.stringify(
            {
              pid,
              output_bytes: bytes.length,
              output_sha256: sha(bytes),
              binary_tail_sha256: sha(tail),
            },
            null,
            2,
          ),
        );
      });
      await recover();
    }
    await test(provider + "-x64-switched-handles", async () => {
      const files = await fixtureFiles(
        provider + "-x64-switched",
        "x64-switched",
      );
      const pid = await start(files, true);
      const before = state(pid);
      const refusal = await close(true);
      assert(
        /stdout|stderr|output|sink|durable/i.test(JSON.stringify(refusal)),
        JSON.stringify(refusal),
      );
      assert(!JSON.stringify(refusal).includes("cleanup_incomplete"));
      assert.deepEqual(
        state(pid),
        before,
        "Changed output cannot authorize detach",
      );
      for (let i = 0; i < 4 && alive(pid) !== null; i++) await resume();
      await ended(pid);
      await close();
      const bytes = await readFile(files.switched);
      assert(bytes.equals(tail));
      assert(
        !(await readFile(files.output)).includes(
          Buffer.from("BOUNDARY_STDERR"),
        ),
      );
      await client.ping();
    });
    await recover();
    await test(provider + "-x64-exception-exit", async () => {
      const files = await fixtureFiles(
        provider + "-x64-exception",
        "x64-exception",
      );
      const pid = await start(files, false);
      const observations = [];
      for (let i = 0; i < 4 && alive(pid) !== null; i++)
        observations.push(await resume());
      await ended(pid);
      await close();
      assert(
        (await readFile(files.output, "utf8")).includes("BEFORE_EXCEPTION"),
      );
      if (provider === "gdb")
        assert(JSON.stringify(observations).includes("0xe0424242"));
      await client.ping();
    });
    await recover();
    await test(
      provider + (provider === "gdb" ? "-cli-x86-load" : "-cli-x86-exit"),
      async () => {
        const files = await fixtureFiles(provider + "-cli-x86", "x86-normal");
        const args =
          provider === "rizin"
            ? ["debug-with-rizin", files.exe, "dc;dc;dc;dc"]
            : ["debug-with-gdb", "file " + files.exe.replaceAll("\\", "/")];
        const child = spawn(
          process.execPath,
          [
            join(R, "scripts/rea.mjs"),
            ...args,
            "--inferior-tty",
            files.output,
            "--format",
            "json",
          ],
          {
            cwd: R,
            env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            signal: AbortSignal.timeout(30000),
          },
        );
        let stdout = "",
          errors = "";
        child.stdout.on("data", (b) => (stdout += b));
        child.stderr.on("data", (b) => (errors += b));
        const code = await new Promise((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        await writeFile(join(dirname(files.output), "cli.stdout"), stdout);
        await writeFile(join(dirname(files.output), "cli.stderr"), errors);
        assert.equal(code, 0, errors || stdout);
        const result = toolContract(commandTool).outputSchema.parse(
          JSON.parse(stdout),
        ).normalized_result;
        assert.equal(result.completion_status, "complete");
        if (provider === "rizin")
          assert(
            (await readFile(files.output)).subarray(-tail.length).equals(tail),
          );
        else assert(!result.mi.includes("^error"));
      },
    );
  } catch (error) {
    results.push({
      name: provider + "-verifier",
      status: "failed",
      error: error.stack,
    });
  } finally {
    await recover();
    await client?.close();
    await writeFile(join(out, provider + ".stderr"), stderr);
    await save();
  }
}
const status =
  results.length && results.every((row) => row.status === "passed")
    ? "passed"
    : "failed";
await save(status);
console.log(
  JSON.stringify({
    out,
    status,
    passed: results.filter((row) => row.status === "passed").length,
    failed: results.filter((row) => row.status === "failed").length,
  }),
);
if (status !== "passed") process.exitCode = 1;
