import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const R = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "win32")
  throw new Error("Requires a real Windows host");
const [fixtureArgument, ...selected] = process.argv.slice(2);
if (!fixtureArgument)
  throw new Error("Pass the self-owned ConPTY probe.exe fixture");
const fixture = resolve(fixtureArgument);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(
  sha(await readFile(fixture)),
  "a231d78525c4bae6ad302d9503f04f8a252714323ac105e7ff91ee94890c999a",
);
const out = join(
  R,
  ".cache/windows-process-verification",
  "native-capture-" + randomUUID().slice(0, 8),
);
await mkdir(out, { recursive: true });
await writeFile(
  join(out, "verifier.mjs"),
  await readFile(fileURLToPath(import.meta.url)),
);
await writeFile(
  join(out, "admission.json"),
  JSON.stringify(
    {
      fixture,
      fixture_sha256: sha(await readFile(fixture)),
      native_manifest: JSON.parse(
        await readFile(join(R, "native/windows/build/manifest.json"), "utf8"),
      ),
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    null,
    2,
  ),
);
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
const results = [];
const base = {
  executable: fixture,
  working_directory: dirname(fixture),
  timeout_ms: 5000,
  idle_timeout_ms: 5000,
  settle_ms: 200,
  normalization: { pids: false },
};
const specifications = [
  {
    name: "interactive",
    scenario: {
      ...base,
      arguments: ["--io"],
      events: [
        { type: "input", at_ms: 250, data: "ping\r" },
        { type: "resize", at_ms: 400, columns: 100, rows: 30 },
        { type: "input", at_ms: 550, data: "size\r" },
        { type: "input", at_ms: 800, data: "quit\r" },
      ],
    },
    check(capture) {
      const text = capture.frames.map((frame) => frame.data).join("");
      for (const expected of ["READY tty=1", "PONG中", "SIZE 100 30"])
        assert(text.includes(expected), expected);
      assert.equal(capture.exit.reason, "exited");
      assert.equal(capture.exit.code, 0);
      assert.equal(capture.interaction_events.length, 4);
      assert(
        capture.interaction_events.every(
          (event) => event.outcome === "dispatched",
        ),
      );
      assert(
        capture.process_samples.some(
          (sample) => sample.command.toLowerCase() === fixture.toLowerCase(),
        ),
      );
    },
  },
  {
    name: "leader-exit-descendant",
    scenario: { ...base, arguments: ["--tree-exit"] },
    check(capture) {
      assert.equal(capture.settlement.state, "alive_at_deadline");
      const text = capture.frames.map((frame) => frame.data).join("");
      const leaf = /LEAF (\d+)/u.exec(text);
      assert(leaf, text);
      assert(
        capture.process_samples.some(
          (sample) => sample.pid === Number(leaf[1]),
        ),
      );
      assert.throws(() => process.kill(Number(leaf[1]), 0), /ESRCH/u);
    },
  },
  {
    name: "timeout",
    scenario: { ...base, arguments: ["--leaf"], timeout_ms: 300 },
    check(capture) {
      assert.equal(capture.exit.reason, "timeout");
    },
  },
  {
    name: "finalization",
    scenario: {
      ...base,
      arguments: ["--leaf"],
      timeout_ms: 300,
      finalization_ms: 150,
    },
    check(capture) {
      assert.equal(capture.exit.reason, "timeout");
      assert.equal(capture.exit.finalization.signals[0].signal, "SIGTERM");
      assert.equal(capture.exit.finalization.signals[0].delivery, "unverified");
      assert.equal(capture.exit.finalization.signals[1].signal, "SIGKILL");
      assert.equal(capture.exit.finalization.signals[1].delivery, "signaled");
    },
  },
  {
    name: "unsupported-signal",
    scenario: {
      ...base,
      arguments: ["--leaf"],
      events: [{ type: "signal", at_ms: 10, signal: "SIGTERM" }],
    },
    error: "POSIX",
  },
  {
    name: "failed-start",
    scenario: { ...base, executable: fixture + ".missing", arguments: [] },
    error: "missing",
  },
  {
    name: "recovery-argv",
    scenario: {
      ...base,
      executable: process.execPath,
      arguments: [
        "-e",
        "process.stdout.write(JSON.stringify(process.argv.slice(1))); setTimeout(()=>process.exit(0),100)",
        "中 space",
        'quote"slash\\',
      ],
    },
    check(capture) {
      const text = capture.frames.map((frame) => frame.data).join("");
      assert(
        text.includes(JSON.stringify(["中 space", 'quote"slash\\'])),
        text,
      );
    },
  },
];
const specs = selected.length
  ? specifications.filter((spec) => selected.includes(spec.name))
  : specifications;
assert.equal(
  specs.length,
  selected.length
    ? selected.filter((name) => name !== "cancel").length
    : specifications.length,
);
async function save() {
  await writeFile(
    join(out, "receipt.json"),
    JSON.stringify({ status: "running", results }, null, 2),
  );
}
async function verify(spec, adapter, client) {
  const name = `${spec.name}-${adapter}`,
    started = performance.now();
  try {
    let response, failed;
    if (adapter === "cli") {
      const scenario = join(out, name + ".scenario.json");
      await writeFile(scenario, JSON.stringify(spec.scenario));
      const child = spawn(
        process.execPath,
        [
          join(R, "scripts/rea.mjs"),
          "capture-process",
          scenario,
          "--format",
          "json",
        ],
        {
          cwd: R,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          signal: AbortSignal.timeout(20000),
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
        assert(Buffer.byteLength(stdout) < 16 * 1024 * 1024);
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const code = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      await writeFile(join(out, name + ".stdout"), stdout);
      await writeFile(join(out, name + ".stderr"), stderr);
      failed = code !== 0;
      response = JSON.parse(stdout || stderr);
    } else {
      const result = await client.callTool(
        { name: "capture_process_scenario", arguments: spec.scenario },
        { timeout: 20000 },
      );
      await writeFile(
        join(out, name + ".response.json"),
        JSON.stringify(result, null, 2),
      );
      failed = result.isError === true;
      response = result.structuredContent ?? result;
    }
    await writeFile(
      join(out, name + ".evidence.json"),
      JSON.stringify(response, null, 2),
    );
    if (spec.error) {
      assert(failed);
      assert(
        JSON.stringify(response).includes(spec.error),
        JSON.stringify(response).slice(0, 500),
      );
    } else {
      assert(!failed, JSON.stringify(response).slice(0, 800));
      const evidence = toolContract(
        "capture_process_scenario",
      ).outputSchema.parse(response);
      const capture = evidence.normalized_result;
      assert.equal(capture.manifest.pty_backend, "windows-conpty");
      assert.equal(capture.cleanup.owned_process_group, "verified");
      assert.equal(capture.cleanup.temporary_root, "removed");
      assert(
        capture.process_samples.every(
          (sample) =>
            sample.process_group_id === null && sample.session_id === null,
        ),
      );
      spec.check(capture);
    }
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
for (const spec of specs) await verify(spec, "cli");
let client, transport;
try {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(R, "scripts/rea.mjs"), "mcp"],
    cwd: R,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (bytes) => {
    stderr += bytes;
  });
  client = new Client({ name: "rea-windows-capture-verifier", version: "1" });
  await client.connect(transport, { timeout: 30000 });
  const catalog = await client.listTools();
  const advertised = catalog.tools.find(
    (tool) => tool.name === "capture_process_scenario",
  );
  assert(advertised);
  assert(JSON.stringify(advertised.outputSchema).includes("windows-conpty"));
  for (const spec of specs) await verify(spec, "mcp", client);
  // Cancellation uses the public MCP protocol; the service must remain usable.
  if (!selected.length || selected.includes("cancel")) {
    const name = "cancel-mcp",
      controller = new AbortController();
    try {
      const markerPath = join(out, "cancel-marker.json"),
        latePath = join(out, "cancel-late-write");
      const script = join(out, "cancel-fixture.mjs");
      await writeFile(
        script,
        `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
if(process.argv[2]==='leaf'){setTimeout(()=>writeFileSync(process.argv[4],'unexpected'),10000);setInterval(()=>{},1000);}
else {const child=spawn(process.execPath,[process.argv[1],'leaf',process.argv[3],process.argv[4]],{stdio:'ignore',detached:true,windowsHide:true});child.on('spawn',()=>{writeFileSync(process.argv[3],JSON.stringify({root:process.pid,leaf:child.pid}));process.exit(0);});}`,
      );
      const request = client.callTool(
        {
          name: "capture_process_scenario",
          arguments: {
            ...base,
            executable: process.execPath,
            arguments: [script, "parent", markerPath, latePath],
            timeout_ms: 15000,
            idle_timeout_ms: 15000,
            settle_ms: 10000,
          },
        },
        { signal: controller.signal, timeout: 20000 },
      );
      const observedRequest = request
        .then(
          (value) => ({ status: "fulfilled", value }),
          (error) => ({ status: "rejected", error: String(error) }),
        )
        .then(async (outcome) => {
          await writeFile(
            join(out, "cancel-response.json"),
            JSON.stringify(outcome, null, 2),
          );
          return outcome;
        });
      let marker;
      for (let index = 0; index < 100; index++) {
        try {
          marker = JSON.parse(await readFile(markerPath, "utf8"));
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await delay(25);
        }
      }
      assert(marker, "cancellation fixture did not start");
      await delay(100);
      assert.throws(() => process.kill(marker.root, 0), /ESRCH/u);
      process.kill(marker.leaf, 0);
      controller.abort(new Error("self-owned capture cancellation"));
      const cancelled = await observedRequest;
      await writeFile(
        join(out, "cancel-response.json"),
        JSON.stringify(cancelled, null, 2),
      );
      assert.equal(
        cancelled.status,
        "rejected",
        JSON.stringify(cancelled).slice(0, 1500),
      );
      let gone = false;
      for (let index = 0; index < 200; index++) {
        try {
          process.kill(marker.leaf, 0);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
          gone = true;
          break;
        }
        await delay(25);
      }
      assert(gone, "cancelled capture left its descendant alive");
      await assert.rejects(access(latePath), { code: "ENOENT" });
      await client.ping();
      results.push({
        name,
        status: "passed",
        scope:
          "public MCP cancellation during post-exit settlement, observed descendant exit, absent late mutation and service recovery",
        marker,
      });
    } catch (error) {
      controller.abort(error);
      results.push({ name, status: "failed", error: error.stack });
    }
    await save();
  }
  await writeFile(join(out, "mcp.stderr"), stderr);
} finally {
  await client?.close();
  await transport?.close();
}
const status = results.every((result) => result.status === "passed")
  ? "passed"
  : "failed";
await writeFile(
  join(out, "receipt.json"),
  JSON.stringify({ status, results }, null, 2),
);
console.log(JSON.stringify({ status, directory: out }));
if (status !== "passed") process.exitCode = 1;
