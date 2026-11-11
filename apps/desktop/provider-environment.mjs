import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const providerPaths = new Set([
  "GHIDRA_INSTALL_DIR",
  "JAVA_HOME",
  "REA_JADX_MCP_JAR",
  "REA_WABT_BIN_DIRECTORY",
  "REA_TSHARK_COMMAND",
  "REA_CAPINFOS_COMMAND",
  "REA_SIGROK_COMMAND",
  "REA_WAKARU_COMMAND",
  "REA_MITMDUMP_COMMAND",
  "REA_BINWALK_COMMAND",
  "REA_UNBLOB_COMMAND",
  "REA_GDB_COMMAND",
  "REA_RIZIN_COMMAND",
  "REA_OBJDUMP_COMMAND",
  "REA_KUNA_COMMAND",
  "REA_KUNA_CACHE_DIR",
  "REA_PWNTOOLS_PYTHON",
]);

/** Only explicitly configured provider paths cross this boundary. Never save the ambient environment. */
export async function providerEnvironment(
  dataDirectory,
  environment = process.env,
) {
  let values;
  const path = join(dataDirectory, "providers.json");
  try {
    values = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { ...environment };
    throw new Error("无法读取分析引擎配置 " + path + ": " + error.message);
  }
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("分析引擎配置必须是 JSON 对象：" + path);
  for (const [key, value] of Object.entries(values)) {
    if (
      !providerPaths.has(key) ||
      typeof value !== "string" ||
      !isAbsolute(value) ||
      value.includes("\0")
    )
      throw new Error("无效的分析引擎路径配置：" + key + "，文件：" + path);
  }
  return { ...environment, ...values };
}
