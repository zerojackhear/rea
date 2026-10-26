import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";

export const canAcknowledgeUnknownClose = (receipt) =>
  receipt?.closed === true &&
  receipt.cleanupUnknown === true &&
  (receipt.sidecar?.closeObserved === true ||
    (receipt.desktopOwner?.acknowledgementRequired === true &&
      receipt.desktopOwner.resourcesSettled === true));

/** Own exactly one sidecar until physical close; never terminate by PID. */
export class EngineBridge extends EventEmitter {
  #child;
  #pending = new Map();
  #expectedClose = false;
  #spawned = false;
  #spawnFailed = false;
  #sidecarClose;
  #lastReceipt;
  #closing;
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
    this.#child.once("spawn", () => {
      this.#spawned = true;
    });
    this.#child.once("close", (exitCode, signal) => {
      this.#sidecarClose = { closeObserved: true, exitCode, signal };
    });
    const diagnostics = { stdout: "", stderr: "" };
    for (const channel of ["stdout", "stderr"]) {
      this.#child[channel].on("data", (data) => {
        diagnostics[channel] = (diagnostics[channel] + data.toString()).slice(
          -16_384,
        );
      });
    }
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
    this.#child.on("error", (error) => {
      if (!this.#spawned) this.#spawnFailed = true;
      fail(error);
    });
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
    if (Buffer.byteLength(JSON.stringify(payload ?? null)) > 10 * 1024 * 1024) {
      throw new Error("请求超过本地传输的 10 MiB 限制");
    }
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

  #waitForSidecarClose(timeout = 5_000) {
    if (this.#sidecarClose) return Promise.resolve(this.#sidecarClose);
    return new Promise((resolve) => {
      const settled = (value) => {
        clearTimeout(timer);
        this.#child.off("close", observed);
        resolve(value);
      };
      const observed = () => settled(this.#sidecarClose);
      const timer = setTimeout(() => settled(undefined), timeout);
      this.#child.once("close", observed);
      if (this.#sidecarClose) settled(this.#sidecarClose);
    });
  }

  async close() {
    if (this.#closing) return this.#closing;
    this.#closing = this.#closeOwnedSidecar();
    try {
      return await this.#closing;
    } finally {
      this.#closing = undefined;
    }
  }

  async #closeOwnedSidecar() {
    if (!this.#child.connected) {
      const sidecar = await this.#waitForSidecarClose();
      if (this.#spawnFailed && !this.#spawned && sidecar) {
        return (this.#lastReceipt = {
          closed: true,
          cleanupUnknown: false,
          notStarted: true,
          sidecar,
        });
      }
      if (
        this.#lastReceipt?.cleanupUnknown === false &&
        sidecar?.exitCode === 0 &&
        sidecar.signal === null
      ) {
        return { ...this.#lastReceipt, sidecar };
      }
      return (this.#lastReceipt = {
        closed: sidecar?.closeObserved === true,
        cleanupUnknown: true,
        sidecar,
        message: "分析服务连接已断开；外部资源清理状态仍未知。",
      });
    }
    let receipt;
    try {
      receipt = await this.request("close");
    } catch (error) {
      if (!this.#child.connected) return this.#closeOwnedSidecar();
      throw error;
    }
    this.#lastReceipt = receipt;
    if (receipt.closed && !receipt.cleanupUnknown) {
      this.#expectedClose = true;
      // The sidecar closes its IPC channel after delivering the final receipt.
      // Observe that owner's close instead of racing it with a second disconnect.
      const sidecar = await this.#waitForSidecarClose();
      return (this.#lastReceipt = {
        ...receipt,
        sidecar,
        closed: sidecar?.closeObserved === true,
        cleanupUnknown:
          !sidecar || sidecar.exitCode !== 0 || sidecar.signal !== null,
        ...(!sidecar
          ? { message: "REA 已关闭，桌面服务退出尚未确认，请稍后重试。" }
          : {}),
      });
    }
    return {
      ...receipt,
      ...(this.#sidecarClose ? { sidecar: this.#sidecarClose } : {}),
    };
  }

  /** Only the main process may call this after an explicit user decision. */
  async acknowledgeUnknownClose() {
    const receipt = this.#lastReceipt;
    if (
      !canAcknowledgeUnknownClose({
        ...receipt,
        sidecar: this.#sidecarClose ?? receipt?.sidecar,
      })
    ) {
      throw new Error("仍有活动资源或未保存结果，不能放弃其所有权。");
    }
    this.#expectedClose = true;
    if (!this.#sidecarClose) {
      if (!this.#child.connected)
        throw new Error("桌面服务尚未确认退出，其所有权已保留。");
      const acknowledgement = await this.request("acknowledge-close", {
        acceptUnknownCleanup: true,
      });
      if (acknowledgement.accepted !== true)
        throw new Error(
          acknowledgement.message ?? "桌面服务仍持有资源或未保存结果。",
        );
    }
    // Only the sidecar may release its live IPC after rechecking its own resources.
    const sidecar = await this.#waitForSidecarClose();
    return {
      closed: sidecar?.closeObserved === true,
      cleanupUnknown: true,
      sidecar,
      userAcknowledged: true,
    };
  }
}
