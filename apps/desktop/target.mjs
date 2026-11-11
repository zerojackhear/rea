import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export async function describeTarget(path, readStat = stat) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    throw new Error("请选择有效的本机绝对路径。");
  const info = await readStat(path);
  if (info.isDirectory()) return { path, kind: "directory" };
  if (info.isFile()) return { path, kind: "file" };
  throw new Error("请选择普通文件或目录。");
}
