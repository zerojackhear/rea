import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fork } from "node:child_process";
import { dirname, basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  createDesktopEngine,
  OwnedStdioTransport,
  validateRequest,
  loadRecordingPolicy,
} from "./engine.mjs";

const beforeDirectoryCleanup = new WeakMap();
let requestId = 0;
const request = (method, payload = {}) => ({
  id: ++requestId,
  method,
  payload,
});
const sdkRoot =
  process.env.REA_DESKTOP_TEST_CORE_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const recordingPolicyRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(join(sdkRoot, "package.json"));
const sdk = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client")).href
);

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "rea-desktop-engine-"));
  beforeDirectoryCleanup.set(t, []);
  t.after(async () => {
    for (const close of beforeDirectoryCleanup.get(t).reverse()) await close();
    const target = resolve(path);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("rea-desktop-engine-"));
    await rm(target, { recursive: true, force: true });
  });
  return path;
}
async function fixture(t, call, options = {}) {
  const path = await directory(t);
  const coreRoot = join(path, "core");
  const dataDirectory = join(path, "data");
  await mkdir(coreRoot);
  await writeFile(
    join(coreRoot, "package.json"),
    JSON.stringify({ version: "test-core" }),
  );
  const events = [];
  const calls = [];
  const engine = createDesktopEngine({
    loadPolicy: () => loadRecordingPolicy(recordingPolicyRoot),
    coreRoot,
    dataDirectory,
    emit: (event) => events.push(event),
    connect: async (_root, onFault) => {
      options.connected?.(onFault);
      return {
        tools: options.tools ?? [
          { name: "inspect_go_binary", inputSchema: { type: "object" } },
        ],
        client: {
          callTool: async (input, options) => {
            calls.push({ input, options });
            return call(input, options);
          },
          close: async () => {},
        },
        transport: {
          diagnostics:
            options.diagnostics ??
            (() => ({
              stderr: { scope: "server-process", bytesObserved: 0, text: "" },
            })),
          closeGracefully:
            options.closeGracefully ??
            (async () => ({
              closed: true,
              cleanupUnknown: false,
            })),
        },
      };
    },
  });
  await engine.start();
  beforeDirectoryCleanup.get(t).push(() => engine.close());
  return { engine, path, dataDirectory, events, calls };
}
async function until(read, predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline)
      throw Error("Timed out waiting for the adapter boundary.");
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
}

test("IPC validation rejects unknown methods, fields, and result traversal", () => {
  for (const message of [
    { id: "x", method: "spawn", payload: {} },
    request("result", { id: "../other" }),
    request("submit", {
      tool: "inspect_go_binary",
      arguments: {},
      command: "cmd.exe",
    }),
    { id: null, method: "state" },
  ])
    assert.throws(() => validateRequest(message), /Invalid|Unexpected|UUID/);
  assert.deepEqual(validateRequest(request("state")).payload, {});
  for (const payload of [
    {},
    { acceptUnknownCleanup: false },
    { acceptUnknownCleanup: "true" },
    { acceptUnknownCleanup: true, force: true },
  ])
    assert.throws(
      () => validateRequest(request("acknowledge-close", payload)),
      /Explicit|Unexpected/,
    );
  assert.deepEqual(
    validateRequest(
      request("acknowledge-close", { acceptUnknownCleanup: true }),
    ).payload,
    { acceptUnknownCleanup: true },
  );
});

test("retains exact MCP content, structured Evidence, unknowns and selected inputs", async (t) => {
  const result = {
    content: [
      {
        type: "text",
        text: '{"normalized_result":{"metadata":null,"unknown":"missing"}}',
      },
    ],
    structuredContent: {
      normalized_result: { metadata: null, unknown: "missing" },
      evidence_id: "ev:selected",
    },
    _meta: { provenance: { untrusted: true } },
  };
  const { engine, dataDirectory, calls } = await fixture(t, async () => result);
  const input = JSON.parse(
    '{"path":"C:\\\\selected\\\\api_key.txt","__proto__":{"source":"kept"}}',
  );
  const submitted = await engine.dispatch(
    request("submit", { tool: "inspect_go_binary", arguments: input }),
  );
  await until(
    () => engine.dispatch(request("history")),
    (rows) => rows[0]?.state === "completed",
  );
  const document = await engine.dispatch(
    request("result", { id: submitted.id }),
  );
  assert.deepEqual(document.result, result);
  assert.deepEqual(document.task.arguments, input);
  assert.equal(calls[0].options.toolDefinition.name, "inspect_go_binary");
  assert.equal(calls[0].options.timeout, 600_000);
  const raw = JSON.parse(
    await readFile(
      join(dataDirectory, "results", submitted.id + ".json"),
      "utf8",
    ),
  );
  assert.deepEqual(raw.result, result);
  assert.deepEqual(raw.task.arguments, input);
  assert.equal(JSON.stringify(raw).includes("REA_DESKTOP_CORE_ROOT"), false);
  await assert.rejects(
    engine.dispatch(request("submit", { tool: "unknown_tool", arguments: {} })),
    /absent/,
  );
});

test("serial queue cancels waiting work without calling MCP, and preserves a running cancellation gap", async (t) => {
  let entered;
  const ready = new Promise((resolveReady) => {
    entered = resolveReady;
  });
  const { engine, calls } = await fixture(t, async (input, options) => {
    if (input.arguments.number === 1) {
      entered();
      return new Promise((_, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        ),
      );
    }
    return { content: [{ type: "text", text: "second completed" }] };
  });
  const first = await engine.dispatch(
    request("submit", { tool: "inspect_go_binary", arguments: { number: 1 } }),
  );
  await ready;
  const waiting = await engine.dispatch(
    request("submit", { tool: "inspect_go_binary", arguments: { number: 2 } }),
  );
  const last = await engine.dispatch(
    request("submit", { tool: "inspect_go_binary", arguments: { number: 3 } }),
  );
  await engine.dispatch(request("cancel", { id: waiting.id }));
  assert.equal(calls.length, 1);
  await engine.dispatch(request("cancel", { id: first.id }));
  await until(
    () => engine.dispatch(request("history")),
    (rows) =>
      rows.some((row) => row.id === last.id && row.state === "completed"),
  );
  assert.deepEqual(
    calls.map((call) => call.input.arguments.number),
    [1, 3],
  );
  const cancelled = await engine.dispatch(request("result", { id: first.id }));
  assert.equal(cancelled.task.state, "cancelled");
  assert.equal(cancelled.diagnostics.serverSettlement, "unconfirmed");
  assert.equal("result" in cancelled, false);
});

test("MCP isError remains a failed task with the original error content", async (t) => {
  const result = {
    isError: true,
    content: [
      {
        type: "text",
        text: '{"error":{"code":"provider_timeout","details":{"partial_observation":{"coverage":"partial"}}}}',
      },
    ],
  };
  const { engine } = await fixture(t, async () => result);
  const task = await engine.dispatch(
    request("submit", { tool: "inspect_go_binary", arguments: {} }),
  );
  await until(
    () => engine.dispatch(request("history")),
    (rows) => rows[0]?.state === "failed",
  );
  assert.deepEqual(
    (await engine.dispatch(request("result", { id: task.id }))).result,
    result,
  );
});

test("history recovery marks unsettled tasks interrupted without fabricating results", async (t) => {
  const path = await directory(t);
  const coreRoot = join(path, "core");
  const dataDirectory = join(path, "data");
  await mkdir(coreRoot);
  await mkdir(dataDirectory);
  await writeFile(join(coreRoot, "package.json"), '{"version":"recovery"}');
  const id = "11111111-2222-4333-8444-555555555555";
  await writeFile(
    join(dataDirectory, "history.json"),
    JSON.stringify({
      schemaVersion: 1,
      tasks: [
        {
          id,
          tool: "inspect_go_binary",
          arguments: { path: "selected" },
          state: "running",
          createdAt: "2026-10-26T00:00:00.000Z",
        },
      ],
    }),
  );
  const engine = createDesktopEngine({
    loadPolicy: () => loadRecordingPolicy(recordingPolicyRoot),
    coreRoot,
    dataDirectory,
    connect: async () => ({
      tools: [],
      client: { close: async () => {} },
      transport: { closeGracefully: async () => ({ closed: true }) },
    }),
  });
  await engine.start();
  beforeDirectoryCleanup.get(t).push(() => engine.close());
  const rows = await engine.dispatch(request("history"));
  assert.equal(rows[0].state, "interrupted");
  const document = await engine.dispatch(request("result", { id }));
  assert.equal(document.diagnostics.resultAvailable, false);
  assert.equal("result" in document, false);
});

test("corrupt history is preserved and the core is not launched", async (t) => {
  const path = await directory(t);
  const coreRoot = join(path, "core");
  const dataDirectory = join(path, "data");
  await mkdir(coreRoot);
  await mkdir(dataDirectory);
  await writeFile(join(coreRoot, "package.json"), '{"version":"recovery"}');
  const original = '{"schemaVersion":1,"tasks":[{"id":"../outside"}]}';
  await writeFile(join(dataDirectory, "history.json"), original);
  let connections = 0;
  const engine = createDesktopEngine({
    loadPolicy: () => loadRecordingPolicy(recordingPolicyRoot),
    coreRoot,
    dataDirectory,
    connect: async () => {
      connections++;
    },
  });
  await engine.start();
  assert.equal((await engine.dispatch(request("state"))).connection, "error");
  assert.equal(connections, 0);
  await engine.close();
  assert.equal(
    await readFile(join(dataDirectory, "history.json"), "utf8"),
    original,
  );
});

test("storage failure retains the full result in memory and prevents a lossy shutdown", async (t) => {
  const result = {
    content: [{ type: "text", text: "unmodified result" }],
    structuredContent: { unknown: null },
  };
  let release;
  const { engine, dataDirectory } = await fixture(
    t,
    () =>
      new Promise((resolveCall) => {
        release = () => resolveCall(result);
      }),
  );
  const task = await engine.dispatch(
    request("submit", { tool: "inspect_go_binary", arguments: {} }),
  );
  await until(
    () => Promise.resolve(release),
    (value) => typeof value === "function",
  );
  const destination = join(dataDirectory, "results");
  const retained = join(dataDirectory, "preserved-empty-results");
  await rename(destination, retained);
  await writeFile(destination, "owned obstruction");
  release();
  await until(
    () => engine.dispatch(request("history")),
    (rows) => rows[0]?.state === "failed",
  );
  const memory = await engine.dispatch(request("result", { id: task.id }));
  assert.deepEqual(memory.result, result);
  assert.ok(memory.diagnostics.persistenceFailure);
  assert.equal((await engine.close()).closed, false);
  await unlink(destination);
  await rename(retained, destination);
  assert.equal((await engine.close()).closed, true);
  assert.deepEqual(
    JSON.parse(await readFile(join(destination, task.id + ".json"), "utf8"))
      .result,
    result,
  );
});

test("real owned child receives EOF, drains final JSON/stderr, and is observed closed", async () => {
  const messages = [];
  const transport = new OwnedStdioTransport({
    command: process.execPath,
    args: [
      "-e",
      "process.stdin.resume();process.stdin.once('end',()=>{process.stderr.write('final cleanup');process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/test',params:{closed:true}})+'\\n');});",
    ],
    env: { ...process.env },
    ReadBuffer: sdk.ReadBuffer,
    serializeMessage: sdk.serializeMessage,
  });
  transport.onmessage = (message) => messages.push(message);
  await transport.start();
  const receipt = await transport.closeGracefully(3000);
  assert.equal(receipt.closed, true);
  assert.equal(receipt.cleanupUnknown, false);
  assert.equal(receipt.process.closeObserved, true);
  assert.equal(messages[0].params.closed, true);
  assert.equal(transport.diagnostics().stderr.text, "final cleanup");
});

test("real delayed child is retained after close deadline; retry never sends a kill signal", async () => {
  const transport = new OwnedStdioTransport({
    command: process.execPath,
    args: [
      "-e",
      "process.stdin.resume();process.stdin.once('end',()=>{setTimeout(()=>process.stderr.write('finished'),220);});",
    ],
    env: { ...process.env },
    ReadBuffer: sdk.ReadBuffer,
    serializeMessage: sdk.serializeMessage,
  });
  await transport.start();
  transport.child.kill = () => {
    throw Error("No kill is allowed in this test.");
  };
  const first = await transport.closeGracefully(10);
  assert.equal(first.closed, false);
  assert.equal(first.cleanupUnknown, true);
  assert.equal(transport.closeObservation, undefined);
  const second = await transport.closeGracefully(3000);
  assert.equal(second.closed, true);
  assert.equal(second.cleanupUnknown, false);
});

test("real stderr retention is bounded while its observed byte count stays exact", async () => {
  const transport = new OwnedStdioTransport({
    command: process.execPath,
    args: [
      "-e",
      "process.stdin.resume();process.stdin.once('end',()=>process.stderr.write(Buffer.alloc(70000,120)));",
    ],
    env: { ...process.env },
    ReadBuffer: sdk.ReadBuffer,
    serializeMessage: sdk.serializeMessage,
  });
  await transport.start();
  assert.equal((await transport.closeGracefully(3000)).closed, true);
  const stderr = transport.diagnostics().stderr;
  assert.equal(stderr.bytesObserved, 70000);
  assert.equal(stderr.bytesRetained, 65536);
  assert.equal(stderr.truncated, true);
  assert.equal(Buffer.from(stderr.base64, "base64").length, 65536);
});

test("restart preserves old task session IDs and gives new tasks a fresh session ID", async (t) => {
  const path = await directory(t);
  const coreRoot = join(path, "core"),
    dataDirectory = join(path, "data");
  await mkdir(coreRoot);
  await writeFile(
    join(coreRoot, "package.json"),
    '{"version":"session-recovery"}',
  );
  const response = {
    content: [{ type: "text", text: '{"evidence_id":"session-local"}' }],
    structuredContent: { evidence_id: "session-local", unknown: null },
  };
  const makeEngine = () =>
    createDesktopEngine({
      loadPolicy: () => loadRecordingPolicy(recordingPolicyRoot),
      coreRoot,
      dataDirectory,
      connect: async () => ({
        tools: [{ name: "inspect_go_binary", inputSchema: { type: "object" } }],
        client: { callTool: async () => response, close: async () => {} },
        transport: {
          diagnostics: () => ({}),
          closeGracefully: async () => ({
            closed: true,
            cleanupUnknown: false,
          }),
        },
      }),
    });
  const first = makeEngine();
  await first.start();
  const oldSession = (await first.dispatch(request("state"))).sessionId;
  assert.match(oldSession, /^[a-f0-9-]{36}$/);
  const oldTask = await first.dispatch(
    request("submit", {
      tool: "inspect_go_binary",
      arguments: { path: "old" },
    }),
  );
  await until(
    () => first.dispatch(request("history")),
    (rows) => rows[0]?.state === "completed",
  );
  assert.equal(oldTask.engineSessionId, oldSession);
  const oldPath = join(dataDirectory, "results", oldTask.id + ".json");
  const originalBytes = await readFile(oldPath);
  assert.equal((await first.close()).closed, true);

  const second = makeEngine();
  await second.start();
  beforeDirectoryCleanup.get(t).push(() => second.close());
  const newSession = (await second.dispatch(request("state"))).sessionId;
  assert.notEqual(newSession, oldSession);
  const restored = (await second.dispatch(request("history"))).find(
    (task) => task.id === oldTask.id,
  );
  assert.equal(restored.engineSessionId, oldSession);
  const oldDocument = await second.dispatch(
    request("result", { id: oldTask.id }),
  );
  assert.equal(oldDocument.task.engineSessionId, oldSession);
  assert.deepEqual(oldDocument.result, response);
  assert.deepEqual(await readFile(oldPath), originalBytes);

  const newTask = await second.dispatch(
    request("submit", {
      tool: "inspect_go_binary",
      arguments: { path: "new" },
    }),
  );
  await until(
    () => second.dispatch(request("history")),
    (rows) =>
      rows.some((task) => task.id === newTask.id && task.state === "completed"),
  );
  assert.equal(newTask.engineSessionId, newSession);
  assert.equal(
    (await second.dispatch(request("result", { id: newTask.id }))).task
      .engineSessionId,
    newSession,
  );
  const index = JSON.parse(
    await readFile(join(dataDirectory, "history.json"), "utf8"),
  );
  assert.equal(
    index.tasks.find((task) => task.id === oldTask.id).engineSessionId,
    oldSession,
  );
  assert.equal(
    index.tasks.find((task) => task.id === newTask.id).engineSessionId,
    newSession,
  );
});

test("Frida credentials are ephemeral across execution, progress, queued cancellation, errors and all persisted surfaces", async (t) => {
  const token = "REA_AUTH_TOKEN_CANARY_9cfa",
    certificate = "REA_CERT_CANARY_9cfa";
  let release, emitFault;
  const rawLog = "transport said " + token + " and " + certificate;
  const { engine, calls, events, dataDirectory } = await fixture(
    t,
    async (_input, options) => {
      options.onprogress({ progress: 1, message: rawLog });
      return new Promise((_, reject) => {
        release = () => reject(new Error(rawLog));
      });
    },
    {
      tools: [{ name: "list_frida_devices", inputSchema: { type: "object" } }],
      connected: (fault) => {
        emitFault = fault;
      },
      diagnostics: () => ({
        stderr: {
          scope: "server-process",
          text: rawLog,
          base64: Buffer.from(rawLog).toString("base64"),
          bytesObserved: Buffer.byteLength(rawLog),
        },
      }),
    },
  );
  const arguments_ = {
    remote: {
      address: "127.0.0.1:27042",
      token,
      certificate,
      origin: "https://public.example",
    },
  };
  const running = await engine.dispatch(
    request("submit", { tool: "list_frida_devices", arguments: arguments_ }),
  );
  await until(
    () => Promise.resolve(release),
    (value) => typeof value === "function",
  );
  const waiting = await engine.dispatch(
    request("submit", { tool: "list_frida_devices", arguments: arguments_ }),
  );
  await engine.dispatch(request("cancel", { id: waiting.id }));
  emitFault(new Error(rawLog));
  release();
  await until(
    () => engine.dispatch(request("history")),
    (rows) =>
      rows.some((row) => row.id === running.id && row.state === "failed"),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.arguments.remote.token, token);
  assert.equal(calls[0].input.arguments.remote.certificate, certificate);
  const document = await engine.dispatch(request("result", { id: running.id }));
  assert.equal(document.task.arguments.remote.origin, "https://public.example");
  assert.equal("token" in document.task.arguments.remote, false);
  assert.equal("certificate" in document.task.arguments.remote, false);
  assert.equal(document.task.inputProjection.replayable, false);
  const surfaces = [
    events,
    await engine.dispatch(request("history")),
    await engine.dispatch(request("state")),
    document,
    await engine.dispatch(request("result", { id: waiting.id })),
  ];
  for (const surface of surfaces) {
    assert.equal(JSON.stringify(surface).includes(token), false);
    assert.equal(JSON.stringify(surface).includes(certificate), false);
  }
  assert.equal(
    Buffer.from(document.diagnostics.stderr.base64, "base64")
      .toString()
      .includes(token),
    false,
  );
  assert.ok(document.diagnostics.stderr.desktopProjection);
  for (const file of [
    join(dataDirectory, "history.json"),
    join(dataDirectory, "results", running.id + ".json"),
  ]) {
    const text = await readFile(file, "utf8");
    assert.equal(text.includes(token), false);
    assert.equal(text.includes(certificate), false);
  }
});

test("CDP browser IDs and URL userinfo are excluded while query, fragment, ordinary names and selected paths remain", async (t) => {
  const browserId = "REA_BROWSER_SOCKET_CANARY_c40c",
    user = "REA_USER_CANARY_c40c",
    password = "REA_PASSWORD_CANARY_c40c";
  const response = {
    content: [{ type: "text", text: "preserved" }],
    structuredContent: {
      path: "C:\\selected\\api_key.txt",
      url: "https://example.test/path?token=public#kept",
    },
  };
  const { engine, calls, events } = await fixture(t, async () => response, {
    tools: [{ name: "inspect_web_page", inputSchema: { type: "object" } }],
  });
  const arguments_ = {
    cdp_endpoint: "ws://127.0.0.1:9222/devtools/browser/" + browserId,
    url:
      "https://" +
      user +
      ":" +
      password +
      "@example.test/a/../b?token=public#kept",
    token: "ordinary-public-value",
    source_path: "C:\\selected\\api_key.txt",
    target_id: "ordinary-target-id",
  };
  const task = await engine.dispatch(
    request("submit", { tool: "inspect_web_page", arguments: arguments_ }),
  );
  await until(
    () => engine.dispatch(request("history")),
    (rows) => rows[0]?.state === "completed",
  );
  const document = await engine.dispatch(request("result", { id: task.id }));
  assert.deepEqual(calls[0].input.arguments, arguments_);
  assert.equal(
    document.task.arguments.cdp_endpoint,
    "ws://127.0.0.1:9222/devtools/browser/[REDACTED]",
  );
  assert.equal(
    document.task.arguments.url,
    "https://example.test/a/../b?token=public#kept",
  );
  assert.equal(document.task.arguments.token, "ordinary-public-value");
  assert.equal(document.task.arguments.source_path, arguments_.source_path);
  assert.equal(document.task.arguments.target_id, "ordinary-target-id");
  assert.deepEqual(document.result, response);
  for (const secret of [browserId, user, password])
    assert.equal(JSON.stringify([document, events]).includes(secret), false);
});

test("explicit sensitive capture declarations are not recorded and a core echo becomes an identified noncanonical preview", async (t) => {
  const secret = "REA_EXPLICIT_CANARY_31da";
  const response = {
    content: [{ type: "text", text: "producer mistakenly echoed " + secret }],
    structuredContent: {
      evidence_id: "ev:do-not-reuse-after-projection",
      normalized_result: { selected: secret },
    },
  };
  const { engine, calls, dataDirectory } = await fixture(
    t,
    async () => response,
    {
      tools: [
        {
          name: "inspect_web_network_capture",
          inputSchema: { type: "object" },
        },
      ],
    },
  );
  const arguments_ = {
    capture_path: "C:\\selected\\" + secret + ".har",
    format: "har",
    sensitive_values: [secret],
  };
  const task = await engine.dispatch(
    request("submit", {
      tool: "inspect_web_network_capture",
      arguments: arguments_,
    }),
  );
  await until(
    () => engine.dispatch(request("history")),
    (rows) => rows[0]?.state === "failed",
  );
  assert.deepEqual(calls[0].input.arguments, arguments_);
  const document = await engine.dispatch(request("result", { id: task.id }));
  assert.equal("result" in document, false);
  assert.ok(document.redactedPreview);
  assert.equal(
    document.diagnostics.desktopProjection.canonicalMcpResultAvailable,
    false,
  );
  assert.equal(
    document.diagnostics.desktopProjection.originalNotPersisted,
    true,
  );
  assert.equal("sensitive_values" in document.task.arguments, false);
  assert.equal(JSON.stringify(document).includes(secret), false);
  assert.equal(
    (
      await readFile(join(dataDirectory, "results", task.id + ".json"), "utf8")
    ).includes(secret),
    false,
  );
  assert.equal((await engine.close()).closed, true);
});

test("only the process contract's explicit sensitive input is omitted; scenario environment references remain references", async (t) => {
  const secret = "REA_INPUT_CANARY_f8ab";
  const { engine, calls } = await fixture(
    t,
    async () => ({ content: [{ type: "text", text: "completed" }] }),
    {
      tools: [
        { name: "capture_process_scenario", inputSchema: { type: "object" } },
      ],
    },
  );
  const arguments_ = {
    executable: "self-owned",
    events: [
      { type: "input", sensitive: true, data: secret },
      { type: "input", sensitive: false, data: "public input" },
    ],
    env: { API_KEY: "selected-public-value" },
  };
  const task = await engine.dispatch(
    request("submit", {
      tool: "capture_process_scenario",
      arguments: arguments_,
    }),
  );
  await until(
    () => engine.dispatch(request("history")),
    (rows) => rows[0]?.state === "completed",
  );
  const document = await engine.dispatch(request("result", { id: task.id }));
  assert.equal(calls[0].input.arguments.events[0].data, secret);
  assert.equal("data" in document.task.arguments.events[0], false);
  assert.equal(document.task.arguments.events[1].data, "public input");
  assert.equal(document.task.arguments.env.API_KEY, "selected-public-value");
  assert.equal(JSON.stringify(document).includes(secret), false);
  const policy = await loadRecordingPolicy(recordingPolicyRoot);
  const references = {
    secrets: [{ secret_id: "login", environment_variable: "PASSWORD" }],
    ordinary: { sensitive: true, data: "public carrier" },
  };
  assert.deepEqual(
    policy.project("capture_browser_scenario", references).arguments,
    references,
  );
});

test("legacy history and receipt inputs are repaired without changing a credential-free MCP result", async (t) => {
  const path = await directory(t),
    coreRoot = join(path, "core"),
    dataDirectory = join(path, "data");
  await mkdir(coreRoot);
  await mkdir(join(dataDirectory, "results"), { recursive: true });
  await writeFile(join(coreRoot, "package.json"), '{"version":"legacy"}');
  const secret = "REA_LEGACY_CANARY_a707",
    id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const task = {
    id,
    tool: "list_frida_devices",
    arguments: {
      remote: {
        address: "127.0.0.1:27042",
        token: secret,
        origin: "https://public.example",
      },
    },
    state: "failed",
    error: "old SDK error " + secret,
    createdAt: "2026-10-26T00:00:00.000Z",
  };
  const result = {
    content: [{ type: "text", text: "original public result" }],
    structuredContent: { devices: [] },
  };
  await writeFile(
    join(dataDirectory, "history.json"),
    JSON.stringify({ schemaVersion: 1, tasks: [task] }),
  );
  const resultPath = join(dataDirectory, "results", id + ".json");
  await writeFile(
    resultPath,
    JSON.stringify({
      schemaVersion: 1,
      task,
      result,
      diagnostics: {
        requestError: { message: "old request " + secret },
        stderr: {
          text: secret,
          base64: Buffer.from(secret).toString("base64"),
          bytesObserved: Buffer.byteLength(secret),
        },
      },
    }),
  );
  const engine = createDesktopEngine({
    coreRoot,
    dataDirectory,
    loadPolicy: () => loadRecordingPolicy(recordingPolicyRoot),
    connect: async () => ({
      tools: [],
      client: { close: async () => {} },
      transport: { closeGracefully: async () => ({ closed: true }) },
    }),
  });
  await engine.start();
  beforeDirectoryCleanup.get(t).push(() => engine.close());
  assert.equal(
    JSON.stringify(await engine.dispatch(request("history"))).includes(secret),
    false,
  );
  const document = await engine.dispatch(request("result", { id }));
  assert.deepEqual(document.result, result);
  assert.equal(JSON.stringify(document).includes(secret), false);
  assert.equal(
    Buffer.from(document.diagnostics.stderr.base64, "base64")
      .toString()
      .includes(secret),
    false,
  );
  assert.equal((await readFile(resultPath, "utf8")).includes(secret), false);
  assert.equal(
    (await readFile(join(dataDirectory, "history.json"), "utf8")).includes(
      secret,
    ),
    false,
  );
});

test("a settled cancellation keeps one connection's credential policy for late split stderr and SDK faults", async (t) => {
  const path = await directory(t);
  const coreRoot = join(path, "core"),
    dataDirectory = join(path, "data");
  await mkdir(coreRoot);
  await writeFile(join(coreRoot, "package.json"), '{"version":"late-stream"}');
  const childPath = join(path, "late-stream.mjs");
  await writeFile(
    childPath,
    [
      "import {createInterface} from 'node:readline';",
      "for await (const line of createInterface({input:process.stdin})) {",
      "  const message = JSON.parse(line);",
      "  if(message.method === 'fixture.stderr') process.stderr.write(Buffer.from(message.params.base64, 'base64'));",
      "  else if(message.method === 'fixture.fault') process.stdout.write(JSON.stringify({[message.params.key]:true})+'\\n');",
      "}",
    ].join("\n"),
  );
  const token = "REA_LATE_AUTH_74c9";
  const certificate = "密钥_REA_CERT_12";
  const response = {
    content: [{ type: "text", text: '{"status":"idle","unknown":null}' }],
    structuredContent: { status: "idle", unknown: null },
  };
  const events = [],
    calls = [];
  let transport, lateProgress;
  const engine = createDesktopEngine({
    coreRoot,
    dataDirectory,
    loadPolicy: () => loadRecordingPolicy(recordingPolicyRoot),
    emit: (event) => events.push(event),
    connect: async (_root, onFault) => {
      transport = new OwnedStdioTransport({
        command: process.execPath,
        args: [childPath],
        cwd: path,
        env: process.env,
        ReadBuffer: sdk.ReadBuffer,
        serializeMessage: sdk.serializeMessage,
        onFault,
      });
      await transport.start();
      return {
        transport,
        tools: ["list_frida_devices", "binary_session"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
        client: {
          close: async () => {},
          callTool: async (input, options) => {
            calls.push(input);
            if (input.name !== "list_frida_devices") return response;
            lateProgress = options.onprogress;
            return new Promise((_, reject) =>
              options.signal.addEventListener(
                "abort",
                () => reject(options.signal.reason),
                { once: true },
              ),
            );
          },
        },
      };
    },
  });
  await engine.start();
  beforeDirectoryCleanup.get(t).push(async () => {
    const receipt = await engine.close();
    assert.equal(receipt.closed, true);
    assert.equal(receipt.cleanupUnknown, false);
  });
  const authentication = {
    remote: {
      address: "127.0.0.1:27042",
      token,
      certificate,
      origin: "https://public.example",
    },
  };
  const first = await engine.dispatch(
    request("submit", {
      tool: "list_frida_devices",
      arguments: authentication,
    }),
  );
  await until(
    () => Promise.resolve(calls.length),
    (count) => count === 1,
  );
  assert.deepEqual(calls[0].arguments, authentication);
  await engine.dispatch(request("cancel", { id: first.id }));
  await until(
    () => engine.dispatch(request("history")),
    (rows) =>
      rows.some((row) => row.id === first.id && row.state === "cancelled"),
  );
  assert.equal(
    JSON.stringify(
      await engine.dispatch(request("result", { id: first.id })),
    ).includes(token),
    false,
  );

  let observed = 0;
  async function appendStderr(bytes) {
    observed += bytes.length;
    await transport.send({
      jsonrpc: "2.0",
      method: "fixture.stderr",
      params: { base64: bytes.toString("base64") },
    });
    await until(
      () => Promise.resolve(transport.diagnostics().stderr.bytesObserved),
      (count) => count === observed,
    );
  }
  async function inspectAfterLateBytes() {
    const task = await engine.dispatch(
      request("submit", {
        tool: "binary_session",
        arguments: {
          token: "ordinary-public-value",
          source_path: "C:\\selected\\api_key.txt",
        },
      }),
    );
    await until(
      () => engine.dispatch(request("history")),
      (rows) =>
        rows.some((row) => row.id === task.id && row.state === "completed"),
    );
    const document = await engine.dispatch(request("result", { id: task.id }));
    assert.deepEqual(
      document.result,
      response,
      "a credential-free MCP result stays canonical",
    );
    assert.equal(document.task.arguments.token, "ordinary-public-value");
    assert.equal(
      document.task.arguments.source_path,
      "C:\\selected\\api_key.txt",
    );
    assert.equal(document.diagnostics.stderr.bytesObserved, observed);
    assert.equal(
      document.diagnostics.stderr.bytesRetained,
      Buffer.from(document.diagnostics.stderr.base64, "base64").length,
    );
    assert.equal(document.diagnostics.stderr.truncated, false);
    const disk = await readFile(
      join(dataDirectory, "results", task.id + ".json"),
      "utf8",
    );
    for (const value of [token, certificate]) {
      assert.equal(JSON.stringify(document).includes(value), false);
      assert.equal(disk.includes(value), false);
      assert.equal(
        Buffer.from(document.diagnostics.stderr.base64, "base64")
          .toString("utf8")
          .includes(value),
        false,
      );
    }
    return document;
  }

  // The first request has settled; future bytes still belong to its connection.
  const tokenPrefix = token.slice(0, 9);
  await appendStderr(Buffer.from(tokenPrefix));
  const partial = await inspectAfterLateBytes();
  assert.equal(partial.diagnostics.stderr.text, "");
  assert.equal(
    partial.diagnostics.stderr.pendingCredentialPrefixBytes,
    Buffer.byteLength(tokenPrefix),
  );
  assert.equal(partial.diagnostics.stderr.sourceBytesRetained, observed);
  assert.equal(JSON.stringify(partial).includes(tokenPrefix), false);

  await appendStderr(Buffer.from(token.slice(tokenPrefix.length)));
  const complete = await inspectAfterLateBytes();
  assert.equal(
    complete.diagnostics.stderr.pendingCredentialPrefixBytes,
    undefined,
  );
  assert.equal(complete.diagnostics.stderr.sourceBytesRetained, observed);

  // Also split inside one UTF-8 code point; its raw prefix must not enter base64.
  const encodedCertificate = Buffer.from(certificate, "utf8");
  await appendStderr(encodedCertificate.subarray(0, 1));
  const utf8Prefix = await inspectAfterLateBytes();
  assert.equal(utf8Prefix.diagnostics.stderr.pendingCredentialPrefixBytes, 1);
  assert.notEqual(
    Buffer.from(utf8Prefix.diagnostics.stderr.base64, "base64").at(-1),
    encodedCertificate[0],
  );
  await appendStderr(encodedCertificate.subarray(1));
  await inspectAfterLateBytes();

  lateProgress({ progress: 1, message: token + " " + certificate });
  assert.equal(JSON.stringify(events).includes(token), false);
  assert.equal(JSON.stringify(events).includes(certificate), false);

  // Legal JSON with an invalid RPC shape produces a real SDK ZodError containing
  // its key. SyntaxError is deliberately ignored by the pinned SDK's ReadBuffer.
  await transport.send({
    jsonrpc: "2.0",
    method: "fixture.fault",
    params: { key: token },
  });
  const state = await until(
    () => engine.dispatch(request("state")),
    (value) => value.connection === "error",
  );
  assert.match(state.error, /unrecognized_keys/);
  assert.equal(state.error.includes(token), false);
  assert.equal(JSON.stringify(events).includes(token), false);
  const receipt = await engine.close();
  assert.deepEqual(receipt.process, {
    closeObserved: true,
    exitCode: 0,
    signal: null,
  });
  assert.equal(receipt.cleanupUnknown, false);
});

test("an unfinished diagnostic never cuts a complete self-overlapping credential into a visible prefix", async () => {
  const policy = await loadRecordingPolicy(recordingPolicyRoot);
  policy.project("list_frida_devices", {
    remote: { address: "127.0.0.1:27042", token: "ababa" },
  });
  const diagnostic = policy.diagnostics({
    stderr: {
      text: "ababa",
      base64: Buffer.from("ababa").toString("base64"),
      bytesObserved: 5,
    },
  });
  assert.equal(diagnostic.stderr.text.includes("ab"), false);
  assert.equal(
    Buffer.from(diagnostic.stderr.base64, "base64").toString().includes("ab"),
    false,
  );
  assert.equal(diagnostic.stderr.sourceBytesRetained, 5);
});

test("only the settled desktop owner grants unknown-cleanup acknowledgement and rechecks each acceptance", async (t) => {
  let lowerClosed = true,
    closeCalls = 0;
  const response = { content: [{ type: "text", text: "preserved original" }] };
  const { engine, dataDirectory } = await fixture(t, async () => response, {
    closeGracefully: async () => {
      closeCalls++;
      return {
        closed: lowerClosed,
        cleanupUnknown: true,
        process: { closeObserved: lowerClosed, exitCode: 1, signal: null },
      };
    },
  });
  const task = await engine.dispatch(
    request("submit", {
      tool: "inspect_go_binary",
      arguments: { path: "self-owned" },
    }),
  );
  await until(
    () => engine.dispatch(request("history")),
    (rows) => rows[0]?.state === "completed",
  );
  const receipt = await engine.close();
  assert.equal(receipt.cleanupUnknown, true);
  assert.deepEqual(receipt.desktopOwner, {
    acknowledgementRequired: true,
    resourcesSettled: true,
  });
  assert.deepEqual(
    JSON.parse(
      await readFile(join(dataDirectory, "results", task.id + ".json"), "utf8"),
    ).result,
    response,
  );

  lowerClosed = false;
  await assert.rejects(
    engine.dispatch(
      request("acknowledge-close", {
        acceptUnknownCleanup: true,
      }),
    ),
    (error) => error.code === "desktop_owner_not_settled",
  );
  lowerClosed = true;
  assert.deepEqual(
    await engine.dispatch(
      request("acknowledge-close", {
        acceptUnknownCleanup: true,
      }),
    ),
    { accepted: true, cleanupUnknown: true },
  );
  assert.ok(
    closeCalls >= 3,
    "acceptance must recheck the owning close workflow",
  );
});

test("a raw MCP close does not release the desktop owner while a complete result cannot be persisted", async (t) => {
  let release,
    rawCloseCalls = 0;
  const response = {
    content: [{ type: "text", text: "complete evidence still in memory" }],
  };
  const { engine, dataDirectory } = await fixture(
    t,
    async () =>
      new Promise((resolveResult) => {
        release = () => resolveResult(response);
      }),
    {
      closeGracefully: async () => {
        rawCloseCalls++;
        return {
          closed: true,
          cleanupUnknown: true,
          process: { closeObserved: true, exitCode: 1, signal: null },
        };
      },
    },
  );
  const task = await engine.dispatch(
    request("submit", {
      tool: "inspect_go_binary",
      arguments: { path: "self-owned" },
    }),
  );
  await until(
    () => Promise.resolve(release),
    (value) => typeof value === "function",
  );
  const resultsDirectory = join(dataDirectory, "results");
  const held = join(dataDirectory, "results-held");
  await rename(resultsDirectory, held);
  await writeFile(resultsDirectory, "test-owned blocked storage path");
  release();
  await until(
    () => engine.dispatch(request("history")),
    (rows) => rows[0]?.state === "failed",
  );
  const blocked = await engine.close();
  assert.equal(rawCloseCalls > 0, true);
  assert.equal(blocked.closed, false);
  assert.equal(blocked.desktopOwner, undefined);
  await assert.rejects(
    engine.dispatch(
      request("acknowledge-close", {
        acceptUnknownCleanup: true,
      }),
    ),
    (error) => error.code === "desktop_owner_not_settled",
  );
  assert.deepEqual(
    (await engine.dispatch(request("result", { id: task.id }))).result,
    response,
  );
  await unlink(resultsDirectory);
  await rename(held, resultsDirectory);
  const settled = await engine.close();
  assert.equal(settled.closed, true);
  assert.equal(settled.cleanupUnknown, true);
  assert.equal(settled.desktopOwner.resourcesSettled, true);
  assert.deepEqual(
    await engine.dispatch(
      request("acknowledge-close", {
        acceptUnknownCleanup: true,
      }),
    ),
    { accepted: true, cleanupUnknown: true },
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(resultsDirectory, task.id + ".json"), "utf8"),
    ).result,
    response,
  );
});

test("the real sidecar keeps its IPC owner after an unclean MCP EOF until explicit settled acknowledgement", async (t) => {
  const path = await directory(t),
    coreRoot = join(path, "core"),
    dataDirectory = join(path, "data");
  await mkdir(join(coreRoot, "scripts"), { recursive: true });
  await writeFile(
    join(coreRoot, "package.json"),
    '{"version":"owned-unclean-eof"}',
  );
  // Both junctions point only to the existing runtime dependencies. Removing the
  // guarded test directory removes the links; it does not traverse their target.
  await symlink(
    join(recordingPolicyRoot, "dist"),
    join(coreRoot, "dist"),
    "junction",
  );
  await symlink(
    join(sdkRoot, "node_modules"),
    join(coreRoot, "node_modules"),
    "junction",
  );
  await writeFile(
    join(coreRoot, "scripts", "rea.mjs"),
    [
      "import {createInterface} from 'node:readline';",
      "for await (const line of createInterface({input:process.stdin})) {",
      " const message = JSON.parse(line); if(message.id===undefined)continue;",
      " let result;",
      " if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'owned-unclean-eof',version:'1'}};",
      " else if(message.method==='tools/list')result={tools:[]};",
      " else result={};",
      " process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');",
      "}",
      "process.exitCode=7;",
    ].join("\n"),
  );
  const child = fork(
    fileURLToPath(new URL("./engine.mjs", import.meta.url)),
    [],
    {
      execPath: process.execPath,
      execArgv: [],
      windowsHide: true,
      env: {
        ...process.env,
        REA_DESKTOP_CORE_ROOT: coreRoot,
        REA_DESKTOP_DATA_DIR: dataDirectory,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let childStderr = "";
  child.stdout.resume();
  child.stderr.on("data", (bytes) => {
    childStderr = (childStderr + bytes.toString()).slice(-8192);
  });
  const pending = new Map();
  const observedClose = new Promise((resolveClose) =>
    child.once("close", (exitCode, signal) =>
      resolveClose({ exitCode, signal }),
    ),
  );
  child.on("message", (message) => {
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.value);
    else
      entry.reject(
        Object.assign(
          new Error(message.error?.message ?? "sidecar request failed"),
          { code: message.error?.code },
        ),
      );
  });
  const rpc = (method, payload = {}) =>
    new Promise((resolveReply, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("IPC deadline: " + method + " " + childStderr));
      }, 10_000);
      pending.set(id, { resolve: resolveReply, reject, timer });
      child.send({ id, method, payload }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  beforeDirectoryCleanup.get(t).push(async () => {
    if (child.connected) {
      const receipt = await rpc("close");
      if (receipt.desktopOwner?.resourcesSettled)
        await rpc("acknowledge-close", { acceptUnknownCleanup: true });
    }
    await observedClose;
  });
  await until(
    () => rpc("state"),
    (value) => value.connection === "ready",
    10_000,
  );
  const receipt = await rpc("close");
  assert.equal(receipt.closed, true);
  assert.equal(receipt.cleanupUnknown, true);
  assert.deepEqual(receipt.process, {
    closeObserved: true,
    exitCode: 7,
    signal: null,
  });
  assert.deepEqual(receipt.desktopOwner, {
    acknowledgementRequired: true,
    resourcesSettled: true,
  });
  assert.equal(child.connected, true, "MCP exit is not a sidecar exit receipt");
  assert.equal(child.exitCode, null);
  await assert.rejects(
    rpc("acknowledge-close", { acceptUnknownCleanup: false }),
    (error) => error.code === "invalid_request",
  );
  assert.equal(
    child.connected,
    true,
    "a rejected acknowledgement retains its IPC owner",
  );
  assert.deepEqual(
    await rpc("acknowledge-close", { acceptUnknownCleanup: true }),
    { accepted: true, cleanupUnknown: true },
  );
  assert.deepEqual(await observedClose, { exitCode: 0, signal: null });
});
