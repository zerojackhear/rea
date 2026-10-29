import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  lstat,
  readdir,
  unlink,
  rmdir,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve, basename, dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { EngineBridge } from "../../desktop/bridge.mjs";
import {
  ACTIONS,
  MAX_FILE,
  MAX_REPLY,
  UUID,
  authorize,
  digest,
  exact,
  fault,
  jobInput,
  safeName,
} from "./protocol.mjs";

async function atomic(path, value) {
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? ""))
    throw fault(415, "需要 JSON 请求");
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > 8192) throw fault(413, "请求过大");
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw fault(400, "JSON 无效");
  }
}
function reply(res, status, data) {
  let text = JSON.stringify(data);
  if (Buffer.byteLength(text) > MAX_REPLY) {
    status = 413;
    text = JSON.stringify({
      error:
        "结果超过手机 16 MiB 接收上限；完整证据仍保存在电脑，请在电脑读取。",
    });
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(text),
    ...(status >= 400 ? { connection: "close" } : {}),
  });
  res.end(text);
}

/** A separate engine and upload directory per provisioned device. No raw MCP or caller paths. */
export async function createRemoteServer({
  config,
  root,
  tls,
  bridgeFactory = (opts) => new EngineBridge(opts),
}) {
  if (
    !Array.isArray(config.devices) ||
    config.devices.length > 4 ||
    config.devices.some((d) => !UUID.test(d.id))
  )
    throw new Error("设备配置无效");
  const sessions = new Map();
  let active = 0;
  let stopping = false;
  async function session(device) {
    if (sessions.has(device.id)) return sessions.get(device.id);
    const promise = (async () => {
      const dir = join(root, "devices", device.id);
      await mkdir(join(dir, "uploads"), { recursive: true, mode: 0o700 });
      const ledgerPath = join(dir, "requests.json");
      const ledger = await readJson(ledgerPath, {});
      const bridge = bridgeFactory({
        node: config.node,
        engine: resolve(import.meta.dirname, "../../desktop/engine.mjs"),
        coreRoot: config.coreRoot,
        dataDir: join(dir, "engine"),
      });
      let serial = Promise.resolve();
      return {
        dir,
        ledger,
        bridge,
        uploadBusy: false,
        serialize(fn) {
          const next = serial.then(fn);
          serial = next.catch(() => {});
          return next;
        },
        save: () => atomic(ledgerPath, ledger),
      };
    })();
    sessions.set(device.id, promise);
    try {
      return await promise;
    } catch (e) {
      sessions.delete(device.id);
      throw e;
    }
  }
  async function upload(req, s) {
    if (s.uploadBusy) throw fault(429, "另一文件正在上传");
    const length = Number(req.headers["content-length"]);
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FILE)
      throw fault(413, "文件必须介于 1 字节和 256 MiB");
    if (!/^[a-f0-9]{64}$/.test(req.headers["x-sha256"] ?? ""))
      throw fault(400, "缺少 SHA-256");
    let name;
    try {
      name = safeName(decodeURIComponent(req.headers["x-file-name"] ?? ""));
    } catch {
      throw fault(400, "文件名无效");
    }
    s.uploadBusy = true;
    const id = randomUUID(),
      dir = join(s.dir, "uploads", id),
      artifactDir = join(dir, "artifact"),
      file = join(artifactDir, name);
    let handle;
    let committed = false;
    try {
      const dirs = await readdir(join(s.dir, "uploads"), {
        withFileTypes: true,
      });
      if (dirs.length >= 100)
        throw fault(
          507,
          "电脑端已保存 100 份文件，请关闭服务后整理本设备 uploads 目录",
        );
      let used = 0;
      for (const entry of dirs) {
        if (!entry.isDirectory() || !UUID.test(entry.name))
          throw fault(500, "上传目录异常");
        for (const child of await readdir(join(s.dir, "uploads", entry.name), {
          withFileTypes: true,
        })) {
          const childPath = join(s.dir, "uploads", entry.name, child.name);
          if (child.isDirectory() && child.name === "artifact") {
            for (const artifact of await readdir(childPath, {
              withFileTypes: true,
            })) {
              if (!artifact.isFile()) throw fault(500, "上传文件结构异常");
              used += (await lstat(join(childPath, artifact.name))).size;
            }
          } else if (child.isFile() && child.name === "metadata.json")
            used += (await lstat(childPath)).size;
          else throw fault(500, "上传文件结构异常");
        }
      }
      if (used + length > 2 * 1024 ** 3)
        throw fault(507, "电脑端上传缓存达到 2 GiB，请先整理");
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
      handle = await open(file, "wx", 0o600);
      let received = 0;
      const hash = createHash("sha256");
      for await (const chunk of req) {
        received += chunk.length;
        if (received > length) throw fault(413, "上传长度不一致");
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      const sha256 = hash.digest("hex");
      if (received !== length || sha256 !== req.headers["x-sha256"])
        throw fault(422, "文件长度或 SHA-256 校验失败");
      const meta = {
        id,
        name,
        size: length,
        sha256,
        uploadedAt: new Date().toISOString(),
      };
      await atomic(join(dir, "metadata.json"), meta);
      committed = true;
      return meta;
    } finally {
      if (handle) await handle.close();
      if (!committed) {
        await unlink(file).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
        await rmdir(artifactDir).catch((e) => {
          if (e.code !== "ENOENT" && e.code !== "ENOTEMPTY") throw e;
        });
        await rmdir(dir).catch((e) => {
          if (e.code !== "ENOENT" && e.code !== "ENOTEMPTY") throw e;
        });
      }
      s.uploadBusy = false;
    }
  }
  async function route(req, res) {
    if (stopping) throw fault(503, "服务正在关闭");
    // A browser cannot use ambient credentials or cross-origin requests against this service.
    if (req.headers.origin !== undefined || req.headers.cookie !== undefined)
      throw fault(403, "仅允许已配置的原生客户端");
    const device = authorize(req.headers.authorization, config.devices);
    if (!device) throw fault(401, "设备密钥无效或已撤销");
    if (active >= 12) throw fault(429, "请求繁忙，请稍后重试");
    active++;
    try {
      const s = await session(device);
      const url = req.url;
      if (req.method === "GET" && url === "/v1/state")
        return reply(res, 200, {
          protocol: 1,
          engine: s.bridge.state(),
          actions: Object.entries(ACTIONS).map(([id, a]) => ({
            id,
            title: a.title,
            tool: a.tool,
          })),
          maxFileBytes: MAX_FILE,
        });
      if (req.method === "POST" && url === "/v1/files")
        return reply(res, 201, await upload(req, s));
      if (req.method === "GET" && url === "/v1/jobs")
        return reply(res, 200, await s.bridge.request("history"));
      if (req.method === "POST" && url === "/v1/jobs") {
        const input = jobInput(await body(req));
        const result = await s.serialize(async () => {
          const fingerprint = digest(
            JSON.stringify([input.action, input.fileId]),
          );
          const old = s.ledger[input.requestId];
          if (old) {
            if (old.fingerprint !== fingerprint)
              throw fault(409, "任务编号已用于其他输入");
            if (!old.job)
              throw fault(
                409,
                "此前提交的完成状态未知；请先刷新任务列表，不要重复提交",
              );
            return old.job;
          }
          if (Object.keys(s.ledger).length >= 500)
            throw fault(507, "设备任务记录已满，请在电脑归档并创建新设备连接");
          const metadata = await readJson(
            join(s.dir, "uploads", input.fileId, "metadata.json"),
            null,
          );
          if (!metadata || metadata.id !== input.fileId)
            throw fault(404, "上传文件不存在");
          const path = join(
            s.dir,
            "uploads",
            input.fileId,
            "artifact",
            safeName(metadata.name),
          );
          const info = await lstat(path);
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.size !== metadata.size
          )
            throw fault(409, "上传文件已改变");
          const hash = createHash("sha256");
          for await (const bytes of createReadStream(path)) hash.update(bytes);
          if (hash.digest("hex") !== metadata.sha256)
            throw fault(409, "上传文件 SHA-256 已改变，拒绝分析");
          const action = ACTIONS[input.action];
          let arguments_ = { ...action.defaults, [action.input]: path };
          if (
            input.action === "javascript" &&
            extname(path).toLowerCase() !== ".asar"
          ) {
            if (!/\.(?:[cm]?js|jsx|tsx?|html?|json)$/i.test(path))
              throw fault(
                400,
                "JavaScript 分析请选择脚本、HTML、JSON 或 ASAR 文件",
              );
            arguments_ = {
              input_path: dirname(path),
              format: "directory",
              source_paths: [basename(path)],
            };
          }
          const available = await s.bridge.request("tools");
          if (!available.some((t) => t.name === action.tool))
            throw fault(503, "当前电脑核心没有该分析工具");
          // Persist intent before dispatch. A crash here is explicitly unknown, never silently replayed.
          s.ledger[input.requestId] = {
            fingerprint,
            fileId: input.fileId,
            state: "dispatching",
          };
          await s.save();
          const job = await s.bridge.request("submit", {
            tool: action.tool,
            arguments: arguments_,
          });
          s.ledger[input.requestId] = {
            fingerprint,
            fileId: input.fileId,
            job,
          };
          await s.save();
          return job;
        });
        return reply(res, 202, result);
      }
      const match = /^\/v1\/jobs\/([a-f0-9-]+)\/(result|cancel)$/.exec(
        url ?? "",
      );
      if (match && UUID.test(match[1])) {
        const history = await s.bridge.request("history");
        if (!history.some((j) => j.id === match[1]))
          throw fault(404, "本设备没有此任务");
        if (match[2] === "result" && req.method === "GET")
          return reply(
            res,
            200,
            await s.bridge.request("result", { id: match[1] }),
          );
        if (match[2] === "cancel" && req.method === "POST") {
          exact(await body(req), []);
          return reply(
            res,
            200,
            await s.bridge.request("cancel", { id: match[1] }),
          );
        }
      }
      throw fault(404, "接口不存在");
    } finally {
      active--;
    }
  }
  const server = https.createServer(
    {
      ...tls,
      minVersion: "TLSv1.2",
      maxHeaderSize: 8192,
      requestTimeout: 300_000,
      headersTimeout: 15_000,
    },
    (req, res) => {
      void route(req, res).catch((e) => {
        if (!res.headersSent && !res.destroyed)
          reply(res, e.status ?? 500, {
            error: e.status
              ? e.message
              : "电脑分析服务未完成请求，请查看电脑状态或任务记录",
          });
      });
    },
  );
  server.maxConnections = 24;
  server.keepAliveTimeout = 5000;
  server.on("tlsClientError", () => {});
  return {
    server,
    async close() {
      stopping = true;
      const stopped = new Promise((yes, no) =>
        server.close((e) => (e ? no(e) : yes())),
      );
      server.closeIdleConnections();
      const receipts = await Promise.all(
        [...sessions.values()].map(async (p) => (await p).bridge.close()),
      );
      await stopped;
      return receipts;
    },
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const root = resolve(process.argv[2] ?? "");
  const config = JSON.parse(await readFile(join(root, "server.json"), "utf8"));
  const service = await createRemoteServer({
    config,
    root,
    tls: {
      pfx: await readFile(join(root, "server.p12")),
      passphrase: config.tlsPassword,
    },
  });
  service.server.listen(config.port, config.bind, () =>
    console.log(
      `REA Android 服务已启动：HTTPS ${config.bind}:${config.port}\n连接地址：${config.publicUrl}\n按 Ctrl+C 停止；不要分享连接配置或密钥。`,
    ),
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    const receipts = await service.close();
    console.log(JSON.stringify({ cleanup: receipts }));
    if (receipts.some((r) => !r.closed || r.cleanupUnknown))
      process.exitCode = 2;
  };
  process.on("SIGINT", () => {
    void close().catch((e) => {
      console.error(e.message);
      process.exitCode = 2;
    });
  });
  process.on("SIGTERM", () => {
    void close().catch((e) => {
      console.error(e.message);
      process.exitCode = 2;
    });
  });
}
