import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  lstat,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const METHODS = new Set([
  "state",
  "tools",
  "submit",
  "cancel",
  "history",
  "result",
  "close",
]);
const ACTIVE = new Set(["queued", "running"]);
const TASK_STATES = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const failure = (code, message) => Object.assign(new Error(message), { code });
const describeError = (error) => ({
  code:
    typeof error?.code === "string" || typeof error?.code === "number"
      ? error.code
      : "desktop_engine_error",
  name: error instanceof Error ? error.name : "Error",
  message: error instanceof Error ? error.message : String(error),
});
const snapshot = (value) => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();

export function validateRequest(message) {
  if (
    !isRecord(message) ||
    !["string", "number"].includes(typeof message.id) ||
    (typeof message.id === "number" && !Number.isSafeInteger(message.id)) ||
    !METHODS.has(message.method) ||
    Object.keys(message).some(
      (key) => !["id", "method", "payload"].includes(key),
    )
  ) {
    throw failure("invalid_request", "Invalid desktop engine request.");
  }
  const payload = message.payload ?? {};
  if (!isRecord(payload))
    throw failure("invalid_request", "Request payload must be an object.");
  const keys =
    message.method === "submit"
      ? ["tool", "arguments"]
      : ["cancel", "result"].includes(message.method)
        ? ["id"]
        : [];
  if (Object.keys(payload).some((key) => !keys.includes(key))) {
    throw failure("invalid_request", "Unexpected request fields.");
  }
  if (
    message.method === "submit" &&
    (typeof payload.tool !== "string" ||
      !payload.tool ||
      !isRecord(payload.arguments))
  ) {
    throw failure(
      "invalid_request",
      "Submit requires a tool name and an arguments object.",
    );
  }
  if (
    ["cancel", "result"].includes(message.method) &&
    (typeof payload.id !== "string" || !UUID.test(payload.id))
  ) {
    throw failure("invalid_request", "Task ID must be a generated UUID.");
  }
  return { id: message.id, method: message.method, payload };
}

const FRIDA_AUTH_TOOLS = new Set([
  "list_frida_devices",
  "list_frida_processes",
  "start_frida_session",
]);
const CDP_ENDPOINT_TOOLS = new Set([
  "list_browser_targets",
  "inspect_web_page",
  "analyze_web_bundle",
  "observe_web_session",
  "discover_webmcp_tools",
  "capture_web_screenshot",
  "list_electron_targets",
  "inspect_electron_page",
  "observe_web_execution",
  "inspect_web_event_listeners",
]);
const INSPECTOR_ENDPOINT_TOOLS = new Set([
  "list_javascript_runtime_targets",
  "observe_javascript_runtime",
]);

/** Reuse the core's credential/explicit-declaration owners; ordinary names are never secret guesses. */
export async function loadRecordingPolicy(coreRoot) {
  const load = (file) =>
    import(pathToFileURL(join(coreRoot, "dist", "domain", file)).href);
  const [browser, transportUrl, capture, explicit] = await Promise.all([
    load("browserObservation.js"),
    load("recordedTransportUrl.js"),
    load("webNetworkCapture.js"),
    load("explicitSensitiveValues.js"),
  ]);
  return {
    project(tool, input) {
      const original = snapshot(input),
        literals = new Set(),
        omittedFields = [];
      const add = (value) => {
        if (typeof value === "string" && value !== "") literals.add(value);
      };
      const decoded = (value) => {
        add(value);
        try {
          add(decodeURIComponent(value));
        } catch {}
      };
      const walkStrings = (value, visit) => {
        if (typeof value === "string") visit(value);
        else if (Array.isArray(value))
          value.forEach((item) => walkStrings(item, visit));
        else if (isRecord(value))
          for (const [key, item] of Object.entries(value)) {
            visit(key);
            walkStrings(item, visit);
          }
      };
      walkStrings(original, (value) => {
        const parsed = transportUrl.parseRecordedTransportUrl(value);
        if (parsed.credentials === null) return;
        if (parsed.credentials !== "ambiguous")
          add(
            value.slice(parsed.credentials.start, parsed.credentials.end - 1),
          );
        else add(value);
        const url = URL.parse(value) ?? URL.parse(value, "https://rea.invalid");
        if (url) {
          decoded(url.username);
          decoded(url.password);
        }
      });
      const value = snapshot(original);
      if (FRIDA_AUTH_TOOLS.has(tool) && isRecord(value.remote)) {
        for (const key of ["token", "certificate"])
          if (Object.hasOwn(value.remote, key)) {
            walkStrings(value.remote[key], add);
            delete value.remote[key];
            omittedFields.push("remote." + key);
          }
      }
      const endpoints = [];
      if (CDP_ENDPOINT_TOOLS.has(tool))
        endpoints.push([value, "cdp_endpoint", "cdp_endpoint"]);
      if (INSPECTOR_ENDPOINT_TOOLS.has(tool))
        endpoints.push([value, "inspector_endpoint", "inspector_endpoint"]);
      if (tool === "capture_browser_scenario" && isRecord(value.browser)) {
        endpoints.push([value.browser, "cdp_endpoint", "browser.cdp_endpoint"]);
      }
      for (const [holder, key, path] of endpoints) {
        if (typeof holder[key] !== "string") continue;
        const raw = holder[key],
          parsed = browser.browserObservationEndpointSchema.safeParse(raw);
        if (parsed.success && parsed.data.transport === "browser_websocket") {
          const url = URL.parse(raw);
          add(raw);
          decoded(url.pathname.slice("/devtools/browser/".length));
          holder[key] = parsed.data.recorded;
          omittedFields.push(path);
        } else {
          const url = URL.parse(raw);
          if (
            url?.protocol === "ws:" &&
            url.pathname.startsWith("/devtools/browser/")
          ) {
            add(raw);
            decoded(url.pathname.slice("/devtools/browser/".length));
            holder[key] = "[REDACTED:INVALID_CDP_ENDPOINT]";
            omittedFields.push(path);
          }
        }
      }
      if (
        tool === "inspect_web_network_capture" &&
        Object.hasOwn(value, "sensitive_values")
      ) {
        const parsed =
          capture.inspectWebNetworkCaptureInputSchema.shape.sensitive_values.safeParse(
            original.sensitive_values,
          );
        if (!parsed.success)
          throw failure(
            "invalid_request",
            "The explicit sensitive-value declaration is invalid.",
          );
        for (const literal of capture.captureSensitiveValues(original))
          add(literal);
        delete value.sensitive_values;
        omittedFields.push("sensitive_values");
      }
      if (tool === "capture_process_scenario" && Array.isArray(value.events)) {
        value.events.forEach((event, index) => {
          if (
            isRecord(event) &&
            event.type === "input" &&
            event.sensitive === true &&
            Object.hasOwn(event, "data")
          ) {
            walkStrings(event.data, add);
            delete event.data;
            omittedFields.push("events[" + index + "].data");
          }
        });
      }
      const redactText = (text) =>
        explicit.redactExplicitText(text, [...literals]);
      const redactJson = (item) => {
        if (typeof item === "string") return redactText(item);
        if (Array.isArray(item)) return item.map(redactJson);
        if (isRecord(item))
          return Object.fromEntries(
            Object.entries(item)
              .filter(([key]) => redactText(key) === key)
              .map(([key, child]) => [key, redactJson(child)]),
          );
        return item;
      };
      const recordInput = (item) => {
        if (typeof item === "string") {
          const coordinates = transportUrl.parseRecordedTransportUrl(item);
          const credentialFree =
            coordinates.credentials === "ambiguous"
              ? "[REDACTED:AMBIGUOUS_TRANSPORT_URL]"
              : coordinates.credentials === null
                ? item
                : item.slice(0, coordinates.credentials.start) +
                  item.slice(coordinates.credentials.end);
          return redactText(credentialFree);
        }
        if (Array.isArray(item)) return item.map(recordInput);
        if (isRecord(item))
          return Object.fromEntries(
            Object.entries(item)
              .filter(([key]) => redactText(key) === key)
              .map(([key, child]) => [key, recordInput(child)]),
          );
        return item;
      };
      const arguments_ = recordInput(value);
      const projected = JSON.stringify(arguments_) !== JSON.stringify(original);
      return {
        arguments: arguments_,
        redactText,
        redactJson,
        metadata: projected
          ? {
              kind: "desktop-recording-projection",
              omittedFields,
              requiresSensitiveInput: true,
              replayable: false,
            }
          : undefined,
        diagnostics(raw) {
          const recorded = redactJson(raw);
          if (isRecord(raw?.stderr)) {
            const text =
              typeof raw.stderr.text === "string"
                ? redactText(raw.stderr.text)
                : "";
            const bytes =
              typeof raw.stderr.base64 === "string"
                ? Buffer.from(raw.stderr.base64, "base64")
                : Buffer.from(raw.stderr.text ?? "", "utf8");
            const decoded = bytes.toString("utf8"),
              safeText = redactText(decoded);
            const safeBytes =
              safeText === decoded ? bytes : Buffer.from(safeText, "utf8");
            const changed =
              text !== raw.stderr.text || !safeBytes.equals(bytes);
            recorded.stderr = {
              ...recorded.stderr,
              text,
              base64: safeBytes.toString("base64"),
              bytesRetained: safeBytes.length,
              ...(changed
                ? {
                    sourceBytesRetained: bytes.length,
                    desktopProjection:
                      "desktop-redacted; original authentication text not retained",
                  }
                : {}),
            };
          }
          return recorded;
        },
      };
    },
  };
}

/** Own the spawned process object until close is observed. Never kill by PID. */
export class OwnedStdioTransport {
  constructor({
    command,
    args,
    cwd,
    env,
    ReadBuffer,
    serializeMessage,
    onFault = () => {},
    maxBufferSize = 10 * 1024 * 1024,
    closeTimeoutMs = 30_000,
  }) {
    this.parameters = { command, args, cwd, env };
    this.buffer = new ReadBuffer({ maxBufferSize });
    this.serializeMessage = serializeMessage;
    this.onFault = onFault;
    this.closeTimeoutMs = closeTimeoutMs;
    this.child = undefined;
    this.started = false;
    this.eofRequested = false;
    this.closeObservation = undefined;
    this.stderrParts = [];
    this.stderrBytes = 0;
    this.retainedStderrBytes = 0;
    this.sourceRetainedStderrBytes = 0;
    this.closed = new Promise((resolveClosed) => {
      this.resolveClosed = resolveClosed;
    });
  }

  async start() {
    if (this.started)
      throw failure(
        "already_started",
        "The owned transport has already started.",
      );
    this.started = true;
    const child = spawn(this.parameters.command, this.parameters.args, {
      cwd: this.parameters.cwd,
      env: this.parameters.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.on("close", (exitCode, signal) => {
      this.closeObservation = { closeObserved: true, exitCode, signal };
      this.buffer.clear();
      this.resolveClosed(this.closeObservation);
      this.onclose?.();
    });
    child.on("error", (error) => {
      this.onFault(error);
      this.onerror?.(error);
    });
    child.stdin.on("error", (error) => {
      if (!this.eofRequested) {
        this.onFault(error);
        this.onerror?.(error);
      }
    });
    child.stdout.on("error", (error) => {
      this.onFault(error);
      this.onerror?.(error);
    });
    child.stderr.on("error", (error) => {
      this.onFault(error);
      this.onerror?.(error);
    });
    child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
      const retained = chunk.subarray(
        0,
        Math.max(0, 65_536 - this.sourceRetainedStderrBytes),
      );
      if (retained.length) {
        this.stderrParts.push(Buffer.from(retained));
        this.retainedStderrBytes += retained.length;
        this.sourceRetainedStderrBytes += retained.length;
      }
    });
    child.stdout.on("data", (chunk) => {
      try {
        this.buffer.append(chunk);
        for (;;) {
          const message = this.buffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        }
      } catch (error) {
        this.onFault(error);
        this.onerror?.(error);
        void this.closeGracefully().catch((closeError) =>
          this.onFault(closeError),
        );
      }
    });
    await new Promise((resolveStarted, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolveStarted();
      };
      const onError = (error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  async send(message) {
    if (!this.child || this.eofRequested || this.closeObservation) {
      throw failure("not_connected", "REA's input stream is not available.");
    }
    const bytes = this.serializeMessage(message);
    await new Promise((resolveWritten, reject) => {
      this.child.stdin.write(bytes, (error) =>
        error ? reject(error) : resolveWritten(),
      );
    });
  }

  redactDiagnostics(redactText) {
    const before = Buffer.concat(this.stderrParts);
    const decoded = before.toString("utf8");
    const projected = redactText(decoded);
    if (projected !== decoded) {
      const after = Buffer.from(projected, "utf8");
      this.sourceStderrBytesRetained ??= before.length;
      this.stderrDesktopRedacted = true;
      this.stderrParts = [after];
      this.retainedStderrBytes = after.length;
    }
  }

  diagnostics() {
    const retained = Buffer.concat(this.stderrParts);
    return {
      stderr: {
        scope: "server-process",
        bytesObserved: this.stderrBytes,
        bytesRetained: retained.length,
        truncated: this.stderrBytes > this.sourceRetainedStderrBytes,
        text: retained.toString("utf8"),
        base64: retained.toString("base64"),
        ...(this.stderrDesktopRedacted
          ? {
              sourceBytesRetained: this.sourceRetainedStderrBytes,
              desktopProjection:
                "desktop-redacted; original authentication text not retained",
            }
          : {}),
      },
      ...(this.closeObservation
        ? { process: { ...this.closeObservation } }
        : {}),
    };
  }

  async closeGracefully(timeoutMs = this.closeTimeoutMs) {
    if (!this.started)
      return { closed: true, cleanupUnknown: false, notStarted: true };
    if (!this.closeObservation && !this.eofRequested) {
      this.eofRequested = true;
      this.child.stdin.end();
    }
    let timer;
    const observation =
      this.closeObservation ??
      (await Promise.race([
        this.closed,
        new Promise((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(undefined), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer)));
    if (!observation)
      return {
        closed: false,
        cleanupUnknown: true,
        message:
          "REA has received EOF but process close is not yet observed. Its owner is retained; retry close.",
      };
    const cleanupUnknown =
      observation.exitCode !== 0 || observation.signal !== null;
    return {
      closed: true,
      cleanupUnknown,
      process: { ...observation },
      ...(cleanupUnknown
        ? {
            message:
              "REA exited without a clean shutdown receipt; resource cleanup remains unconfirmed.",
          }
        : {}),
    };
  }

  async close() {
    const receipt = await this.closeGracefully();
    if (!receipt.closed) throw failure("cleanup_unknown", receipt.message);
  }
}

async function atomicJson(path, value) {
  const staging = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(staging, JSON.stringify(value), {
      flag: "wx",
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(staging, path);
  } catch (error) {
    try {
      await unlink(staging);
    } catch (cleanup) {
      if (cleanup.code !== "ENOENT")
        error.cleanupError = describeError(cleanup);
    }
    throw error;
  }
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
  if (
    !(await lstat(path)).isDirectory() ||
    (await lstat(path)).isSymbolicLink()
  ) {
    throw failure(
      "invalid_data_directory",
      "The desktop data directory must be a real directory.",
    );
  }
  return realpath(path);
}

async function connectProduction(coreRoot, onFault) {
  const require = createRequire(join(coreRoot, "package.json"));
  const sdk = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/client")).href
  );
  const transport = new OwnedStdioTransport({
    command: process.execPath,
    args: [join(coreRoot, "scripts", "rea.mjs"), "mcp"],
    cwd: coreRoot,
    env: { ...process.env, REA_LOG_LEVEL: "warn" },
    ReadBuffer: sdk.ReadBuffer,
    serializeMessage: sdk.serializeMessage,
    onFault,
  });
  const client = new sdk.Client({ name: "rea-desktop", version: "0.1.0" });
  client.onclose = () =>
    onFault(failure("connection_closed", "REA's MCP connection closed."));
  client.onerror = onFault;
  try {
    await client.connect(transport, { timeout: 60_000 });
    const tools = (await client.listTools(undefined, { timeout: 60_000 }))
      .tools;
    return { client, transport, tools };
  } catch (error) {
    error.ownedConnection = { client, transport };
    throw error;
  }
}

/** The desktop adapter owns tasks and local persistence; REA owns tool truth. */
export function createDesktopEngine({
  coreRoot,
  dataDirectory,
  emit = () => {},
  connect = connectProduction,
  loadPolicy = loadRecordingPolicy,
  taskTimeoutMs = 600_000,
  closeTimeoutMs = 30_000,
}) {
  const sessionId = randomUUID();
  const tasks = new Map();
  const unsavedResults = new Map();
  const ephemeralArguments = new Map();
  let recordingPolicy;
  const pending = [];
  let state = {
    sessionId,
    connection: "connecting",
    coreVersion: "",
    nodeVersion: process.versions.node,
    toolsCount: 0,
  };
  let directory,
    resultsDirectory,
    connection,
    definitions = new Map();
  let initialization,
    persistence = Promise.resolve(),
    pumping,
    current,
    closing = false,
    stopping;
  const event = (name, value) => {
    try {
      emit({ event: name, value: snapshot(value) });
    } catch {
      /* UI delivery cannot change evidence. */
    }
  };
  const setState = (change) => {
    state = { ...state, ...change };
    event("state", state);
  };
  const summary = (task) => snapshot(task);
  const saveIndex = () => {
    persistence = persistence
      .catch(() => {})
      .then(() =>
        atomicJson(join(directory, "history.json"), {
          schemaVersion: 1,
          tasks: [...tasks.values()],
        }),
      );
    return persistence;
  };
  const taskEvent = (task) => event("task", summary(task));
  const finish = async (task, taskState, error) => {
    ephemeralArguments.delete(task.id);
    task.state = taskState;
    task.endedAt = now();
    task.durationMs = task.startedAt
      ? Math.max(0, Date.parse(task.endedAt) - Date.parse(task.startedAt))
      : 0;
    if (error !== undefined) task.error = error;
    await saveIndex();
    taskEvent(task);
  };
  const fault = (error) => {
    if (closing) return;
    setState({
      connection: "error",
      error:
        current?.recording.redactText(describeError(error).message) ??
        describeError(error).message,
    });
    if (current) current.controller.abort(error);
  };

  const engine = {
    start() {
      initialization ??= (async () => {
        try {
          directory = await ensureDirectory(resolve(dataDirectory));
          resultsDirectory = await ensureDirectory(join(directory, "results"));
          const packageJson = JSON.parse(
            await readFile(join(coreRoot, "package.json"), "utf8"),
          );
          setState({ coreVersion: packageJson.version });
          recordingPolicy = await loadPolicy(resolve(coreRoot));
          let saved;
          try {
            const indexPath = join(directory, "history.json");
            if ((await lstat(indexPath)).isSymbolicLink())
              throw failure(
                "invalid_history",
                "History must not be a symbolic link.",
              );
            saved = JSON.parse(await readFile(indexPath, "utf8"));
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          if (saved !== undefined) {
            if (
              !isRecord(saved) ||
              saved.schemaVersion !== 1 ||
              !Array.isArray(saved.tasks)
            ) {
              throw failure(
                "invalid_history",
                "Desktop history is invalid; existing files were preserved.",
              );
            }
            const restoredTasks = [];
            for (const task of saved.tasks) {
              if (
                !isRecord(task) ||
                !UUID.test(task.id) ||
                typeof task.tool !== "string" ||
                !isRecord(task.arguments) ||
                !TASK_STATES.has(task.state) ||
                restoredTasks.some((item) => item.id === task.id)
              ) {
                throw failure(
                  "invalid_history",
                  "A saved task is invalid; existing files were preserved.",
                );
              }
              const restored = snapshot(task);
              const recorded =
                restored.inputProjection?.kind ===
                "desktop-recording-projection"
                  ? {
                      arguments: restored.arguments,
                      metadata: restored.inputProjection,
                      redactText: (text) => text,
                    }
                  : recordingPolicy.project(restored.tool, restored.arguments);
              restored.arguments = recorded.arguments;
              if (typeof restored.error === "string")
                restored.error = recorded.redactText(restored.error);
              if (recorded.metadata)
                restored.inputProjection = recorded.metadata;
              if (ACTIVE.has(restored.state)) {
                restored.state = "interrupted";
                restored.endedAt = now();
                restored.error =
                  "The previous desktop process ended before a final result was recorded; server completion is unknown.";
              }
              restoredTasks.push(restored);
            }
            for (const restored of restoredTasks)
              tasks.set(restored.id, restored);
            await saveIndex();
          }
          connection = await connect(resolve(coreRoot), fault);
          definitions = new Map(
            connection.tools.map((tool) => [tool.name, tool]),
          );
          if (closing) return;
          setState({
            connection: "ready",
            toolsCount: definitions.size,
            error: undefined,
          });
        } catch (error) {
          if (error.ownedConnection) connection = error.ownedConnection;
          setState({
            connection: "error",
            error: describeError(error).message,
          });
        }
      })();
      return initialization;
    },

    async dispatch(message) {
      const request = validateRequest(message);
      if (request.method === "state") return snapshot(state);
      if (request.method === "history") {
        await initialization;
        return [...tasks.values()].map(summary).reverse();
      }
      if (request.method === "close") return engine.close();
      await initialization;
      if (request.method === "tools") {
        if (state.connection !== "ready")
          throw failure("not_ready", state.error ?? "REA is still connecting.");
        return snapshot([...definitions.values()]);
      }
      if (request.method === "submit") {
        if (closing || state.connection !== "ready")
          throw failure(
            "not_ready",
            state.error ?? "REA is not accepting tasks.",
          );
        if (!definitions.has(request.payload.tool))
          throw failure(
            "unknown_tool",
            "The tool is absent from the connected REA catalog.",
          );
        if (
          [...tasks.values()].filter((task) => ACTIVE.has(task.state)).length >=
          50
        ) {
          throw failure(
            "queue_full",
            "At most 50 desktop tasks can be queued or running.",
          );
        }
        const original = snapshot(request.payload.arguments);
        const recorded = recordingPolicy.project(
          request.payload.tool,
          original,
        );
        const task = {
          id: randomUUID(),
          engineSessionId: sessionId,
          tool: request.payload.tool,
          arguments: recorded.arguments,
          state: "queued",
          createdAt: now(),
          ...(recorded.metadata ? { inputProjection: recorded.metadata } : {}),
        };
        ephemeralArguments.set(task.id, {
          arguments: original,
          recording: recorded,
        });
        tasks.set(task.id, task);
        pending.push(task.id);
        try {
          await saveIndex();
        } catch (error) {
          tasks.delete(task.id);
          ephemeralArguments.delete(task.id);
          pending.splice(pending.indexOf(task.id), 1);
          throw error;
        }
        taskEvent(task);
        void pump();
        return summary(task);
      }
      const task = tasks.get(request.payload.id);
      if (!task)
        throw failure(
          "unknown_task",
          "The requested desktop task was not found.",
        );
      if (request.method === "cancel") {
        if (task.state === "queued") {
          await finish(task, "cancelled");
        } else if (task.state === "running" && current?.task.id === task.id) {
          current.cancelRequested = true;
          current.controller.abort(
            failure("cancelled", "Cancellation requested by the desktop user."),
          );
        }
        return summary(task);
      }
      if (unsavedResults.has(task.id))
        return snapshot(unsavedResults.get(task.id));
      try {
        const path = join(resultsDirectory, task.id + ".json");
        if ((await lstat(path)).isSymbolicLink())
          throw failure(
            "invalid_result",
            "Result files must not be symbolic links.",
          );
        const result = JSON.parse(await readFile(path, "utf8"));
        if (!isRecord(result) || result.task?.id !== task.id)
          throw failure(
            "invalid_result",
            "Saved result identity does not match the task.",
          );
        // A receipt already sealed by this recording owner is not a fresh credential input.
        if (
          result.task.inputProjection?.kind === "desktop-recording-projection"
        )
          return result;
        // Older desktop receipts may predate the recording projection. Repair only
        // this task's metadata/known credentials; unchanged MCP Evidence stays exact.
        const recorded = recordingPolicy.project(
          task.tool,
          result.task.arguments ?? task.arguments,
        );
        const safe = {
          ...result,
          task: {
            ...result.task,
            arguments: recorded.arguments,
            ...(typeof result.task.error === "string"
              ? { error: recorded.redactText(result.task.error) }
              : {}),
            ...(recorded.metadata
              ? { inputProjection: recorded.metadata }
              : {}),
          },
          diagnostics: recorded.diagnostics(result.diagnostics ?? {}),
        };
        if (result.result !== undefined) {
          const projected = recorded.redactJson(result.result);
          if (JSON.stringify(projected) !== JSON.stringify(result.result)) {
            delete safe.result;
            safe.redactedPreview = projected;
            safe.task.state = "failed";
            safe.task.error =
              "Only a desktop-redacted preview is available; canonical MCP Evidence was not retained.";
            safe.diagnostics.desktopProjection = {
              kind: "desktop-redacted",
              canonicalMcpResultAvailable: false,
              originalNotPersisted: true,
              reason: "known-authentication-or-explicit-sensitive-values",
            };
          }
        }
        if (JSON.stringify(safe) !== JSON.stringify(result)) {
          try {
            await atomicJson(path, safe);
          } catch (error) {
            safe.diagnostics.persistenceFailure = recorded.redactJson(
              describeError(error),
            );
            unsavedResults.set(task.id, safe);
            setState({
              connection: "error",
              error:
                "A safe receipt repair could not be saved; retry shutdown after restoring storage.",
            });
          }
        }
        return safe;
      } catch (error) {
        if (error.code === "ENOENT")
          return {
            task: summary(task),
            diagnostics: {
              resultAvailable: false,
              message: "No final result has been saved for this task.",
            },
          };
        throw error;
      }
    },

    async close() {
      if (stopping) return stopping;
      closing = true;
      stopping = (async () => {
        await initialization;
        for (const task of tasks.values())
          if (task.state === "queued") await finish(task, "cancelled");
        if (current) {
          current.cancelRequested = true;
          current.controller.abort(
            failure("cancelled", "Desktop shutdown requested."),
          );
        }
        const receipt = connection
          ? await connection.transport.closeGracefully(closeTimeoutMs)
          : { closed: true, cleanupUnknown: false, notStarted: true };
        if (receipt.closed) {
          await connection?.client.close();
          await pumping;
          for (const [id, document] of unsavedResults) {
            try {
              document.task = summary(tasks.get(id));
              await atomicJson(join(resultsDirectory, id + ".json"), document);
              unsavedResults.delete(id);
            } catch (error) {
              return {
                closed: false,
                cleanupUnknown: true,
                message:
                  "A complete result remains in memory because storage failed: " +
                  describeError(error).message,
              };
            }
          }
          if (directory && tasks.size) await saveIndex();
          await persistence;
        } else setState({ connection: "error", error: receipt.message });
        return receipt;
      })();
      try {
        return await stopping;
      } finally {
        stopping = undefined;
      }
    },
  };

  async function pump() {
    if (pumping) return pumping;
    pumping = (async () => {
      while (pending.length && !closing) {
        const task = tasks.get(pending.shift());
        if (task.state !== "queued") continue;
        if (state.connection !== "ready") {
          await finish(task, "failed", state.error ?? "REA disconnected.");
          continue;
        }
        const privateInput = ephemeralArguments.get(task.id);
        if (!privateInput) {
          await finish(
            task,
            "failed",
            "The original call input is no longer available; provide fresh sensitive values.",
          );
          continue;
        }
        const active = {
          task,
          controller: new AbortController(),
          cancelRequested: false,
          recording: privateInput.recording,
        };
        current = active;
        task.state = "running";
        task.startedAt = now();
        await saveIndex();
        taskEvent(task);
        let result, caught;
        try {
          result = await connection.client.callTool(
            { name: task.tool, arguments: privateInput.arguments },
            {
              toolDefinition: definitions.get(task.tool),
              signal: active.controller.signal,
              timeout: taskTimeoutMs,
              maxTotalTimeout: taskTimeoutMs,
              onprogress: (progress) =>
                event("progress", {
                  taskId: task.id,
                  ...active.recording.redactJson(progress),
                }),
            },
          );
        } catch (error) {
          caught = active.recording.redactJson(describeError(error));
        }
        let redactedPreview;
        if (result !== undefined) {
          const projected = active.recording.redactJson(result);
          if (JSON.stringify(projected) !== JSON.stringify(result)) {
            redactedPreview = projected;
            result = undefined;
            caught = {
              code: "credential_projection",
              name: "DesktopRecordingError",
              message:
                "REA returned known authentication or explicitly sensitive text; only a marked redacted preview is available, not canonical Evidence.",
            };
          }
        }
        connection.transport.redactDiagnostics?.(active.recording.redactText);
        const taskState =
          active.cancelRequested && caught
            ? "cancelled"
            : caught || result?.isError === true
              ? "failed"
              : "completed";
        const finalTask = { ...task, state: taskState, endedAt: now() };
        finalTask.durationMs = Math.max(
          0,
          Date.parse(finalTask.endedAt) - Date.parse(finalTask.startedAt),
        );
        if (caught) finalTask.error = caught.message;
        else if (result?.isError === true)
          finalTask.error =
            "REA returned a tool failure; consult the preserved MCP diagnostic.";
        const diagnostic = {
          ...active.recording.diagnostics(connection.transport.diagnostics()),
          ...(caught ? { requestError: caught } : {}),
          ...(redactedPreview
            ? {
                desktopProjection: {
                  kind: "desktop-redacted",
                  canonicalMcpResultAvailable: false,
                  originalNotPersisted: true,
                  reason: "known-authentication-or-explicit-sensitive-values",
                },
              }
            : {}),
          ...(active.cancelRequested && caught
            ? {
                cancellation: "requested",
                serverSettlement: "unconfirmed",
                message:
                  "The client stopped waiting. This does not prove that REA completed cancellation or resource cleanup.",
              }
            : {}),
        };
        const document = {
          schemaVersion: 1,
          task: summary(finalTask),
          ...(result === undefined ? {} : { result }),
          ...(redactedPreview ? { redactedPreview } : {}),
          diagnostics: diagnostic,
        };
        ephemeralArguments.delete(task.id);
        try {
          await atomicJson(join(resultsDirectory, task.id + ".json"), document);
          tasks.set(task.id, finalTask);
          await saveIndex();
          taskEvent(finalTask);
        } catch (error) {
          finalTask.state = "failed";
          finalTask.error =
            "Could not save the complete result: " +
            describeError(error).message;
          tasks.set(task.id, finalTask);
          document.task = summary(finalTask);
          document.diagnostics.persistenceFailure = describeError(error);
          unsavedResults.set(task.id, document);
          setState({ connection: "error", error: finalTask.error });
          taskEvent(finalTask);
        }
        current = undefined;
      }
    })()
      .catch((error) => {
        current = undefined;
        setState({ connection: "error", error: describeError(error).message });
      })
      .finally(() => {
        pumping = undefined;
      });
    return pumping;
  }
  return engine;
}

async function startIpcEngine() {
  const coreRoot = process.env.REA_DESKTOP_CORE_ROOT;
  const dataDirectory = process.env.REA_DESKTOP_DATA_DIR;
  if (!coreRoot || !dataDirectory)
    throw failure(
      "invalid_configuration",
      "Desktop core and data directories are required.",
    );
  const send = (message) => {
    if (process.connected) process.send(message, () => {});
  };
  const engine = createDesktopEngine({ coreRoot, dataDirectory, emit: send });
  process.on("message", (message) => {
    void (async () => {
      let request;
      try {
        request = validateRequest(message);
        const value = await engine.dispatch(request);
        await new Promise((resolveSent, reject) => {
          if (!process.connected) return resolveSent();
          process.send({ id: request.id, ok: true, value }, (error) =>
            error ? reject(error) : resolveSent(),
          );
        });
        if (
          request.method === "close" &&
          value.closed &&
          !value.cleanupUnknown &&
          process.connected
        )
          process.disconnect();
      } catch (error) {
        send({
          id: request?.id ?? (isRecord(message) ? message.id : null),
          ok: false,
          error: describeError(error),
        });
      }
    })();
  });
  process.once("disconnect", () => {
    void engine.close().catch(() => {});
  });
  void engine.start();
}

if (
  process.send &&
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  void startIpcEngine().catch((error) => {
    if (process.connected)
      process.send({
        event: "state",
        value: {
          connection: "error",
          coreVersion: "",
          nodeVersion: process.versions.node,
          toolsCount: 0,
          error: describeError(error).message,
        },
      });
  });
}
