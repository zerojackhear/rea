import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { providerEnvironment } from "./provider-environment.mjs";

const filename = "mcp-settings.json";
const defaults = () => ({ schemaVersion: 1, reviewAfterAnalysis: false });
let writes = Promise.resolve();
function parse(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    typeof value.reviewAfterAnalysis !== "boolean" ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "reviewAfterAnalysis"].includes(key),
    )
  )
    throw new Error("MCP 设置格式无效，原文件已保留。");
  return { schemaVersion: 1, reviewAfterAnalysis: value.reviewAfterAnalysis };
}
export async function loadMcpSettings(directory) {
  const path = join(directory, filename);
  let handle;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 4096)
      throw new Error("MCP 设置不是有效的小型常规文件，原文件已保留。");
    handle = await open(path, "r");
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error("MCP 设置超出大小限制。");
    return parse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return defaults();
    throw error;
  } finally {
    await handle?.close();
  }
}
export function saveMcpSettings(directory, reviewAfterAnalysis) {
  if (typeof reviewAfterAnalysis !== "boolean")
    return Promise.reject(new Error("MCP 交接开关必须是布尔值。"));
  const operation = writes.then(async () => {
    const previous = await loadMcpSettings(directory);
    if (previous.reviewAfterAnalysis === reviewAfterAnalysis) return previous;
    await mkdir(directory, { recursive: true });
    const path = join(directory, filename);
    const nonce = randomUUID();
    try {
      await copyFile(
        path,
        path + "." + nonce + ".bak",
        constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const staging = path + "." + nonce + ".tmp";
    const next = { schemaVersion: 1, reviewAfterAnalysis };
    let published = false;
    try {
      await writeFile(staging, JSON.stringify(next, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(staging, path);
      published = true;
    } finally {
      if (!published)
        await unlink(staging).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
    return next;
  });
  writes = operation.catch(() => {});
  return operation;
}

/** Explicit provider paths only; ambient environment and credentials are never exported. */
export async function desktopMcpConfiguration({
  directory,
  coreRoot,
  nodePath,
}) {
  if (!isAbsolute(coreRoot ?? "") || !isAbsolute(nodePath ?? ""))
    throw new Error("未找到有效的本地 REA 和 Node 运行时路径。");
  const settings = await loadMcpSettings(directory);
  const env = await providerEnvironment(directory, {});
  env.REA_MCP_REVIEW_AFTER_ANALYSIS = settings.reviewAfterAnalysis ? "1" : "0";
  return {
    mcpServers: {
      rea: {
        command: nodePath,
        args: [join(coreRoot, "scripts", "rea.mjs"), "mcp"],
        env,
      },
    },
  };
}
