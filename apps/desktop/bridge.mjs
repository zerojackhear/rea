import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Owns exactly one Node sidecar; never accepts shell commands or PIDs. */
export class EngineBridge extends EventEmitter {
  #child;
  #pending = new Map();
  #expectedClose = false;
  #state = { connection: "connecting", toolsCount: 0 };
  constructor({ node, engine, coreRoot, dataDir }) {
    super();
    this.#child = fork(engine, [], {
      execPath: node,
      execArgv: [],
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        REA_DESKTOP_CORE_ROOT: coreRoot,
        REA_DESKTOP_DATA_DIR: dataDir,
      },
    });
    const diagnostics = { stdout: "", stderr: "" };
    for (const channel of ["stdout", "stderr"])
      this.#child[channel].on("data", (data) => {
        diagnostics[channel] = (diagnostics[channel] + data.toString()).slice(
          -16_384,
        );
      });
    this.#child.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (typeof message.event === "string") {
        if (message.event === "state") this.#state = message.value;
        this.emit("event", message);
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.value);
      else
        pending.reject(
          new Error(
            typeof message.error === "string"
              ? message.error
              : (message.error?.message ?? "分析引擎请求失败"),
          ),
        );
    });
    const fail = (error) => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      this.#state = {
        ...this.#state,
        connection: "error",
        error: error.message,
      };
      this.emit("event", { event: "state", value: this.#state });
    };
    this.#child.on("error", fail);
    this.#child.on("exit", (code, signal) => {
      if (this.#expectedClose && code === 0) return;
      fail(
        new Error(
          "分析引擎已退出 (" +
            (code ?? signal ?? "unknown") +
            ")" +
            (diagnostics.stderr ? "\n" + diagnostics.stderr : ""),
        ),
      );
    });
  }
  state() {
    return this.#state;
  }
  async request(method, payload) {
    if (!this.#child.connected) throw new Error("分析引擎未连接");
    if (Buffer.byteLength(JSON.stringify(payload ?? null)) > 10 * 1024 * 1024)
      throw new Error("请求超过本地传输的 10 MiB 限制");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(id);
          reject(new Error("分析引擎没有及时响应，请查看任务状态后重试"));
        },
        method === "close" ? 45_000 : 60_000,
      );
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.send({ id, method, payload }, (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        reject(error);
      });
    });
  }
  async close() {
    if (!this.#child.connected)
      return {
        closed: this.#child.exitCode !== null,
        cleanupUnknown: true,
        message: "引擎连接已断开；无法确认其资源清理状态。",
      };
    const result = await this.request("close");
    if (result.closed && !result.cleanupUnknown) {
      this.#expectedClose = true;
      if (this.#child.connected) this.#child.disconnect();
    }
    return result;
  }
}
