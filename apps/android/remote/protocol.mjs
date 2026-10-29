import { createHash, timingSafeEqual } from "node:crypto";

export const MAX_FILE = 256 * 1024 * 1024;
export const MAX_REPLY = 16 * 1024 * 1024;
export const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const ACTIONS = Object.freeze({
  javascript: {
    title: "JavaScript 静态分析",
    tool: "analyze_javascript_application",
    input: "input_path",
  },
  android: {
    title: "APK 深度分析 · 需配置 JADX",
    tool: "inspect_android_package",
    input: "path",
  },
  flutter: {
    title: "Flutter 构建识别",
    tool: "identify_flutter_build",
    input: "path",
  },
  dart: { title: "Dart AOT 快照分析", tool: "inspect_dart_aot", input: "path" },
  go: { title: "Go 编译信息", tool: "inspect_go_binary", input: "path" },
  rust: { title: "Rust 编译信息", tool: "inspect_rust_binary", input: "path" },
  sqlite: {
    title: "SQLite 结构检查",
    tool: "inspect_sqlite_database",
    input: "path",
  },
  wasm: {
    title: "WASM 静态分析 · 需配置 WABT",
    tool: "inspect_wasm_artifact",
    input: "path",
    defaults: { glue_paths: [], candidate_paths: [] },
  },
});
export function fault(status, message) {
  return Object.assign(new Error(message), { status });
}
export function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw fault(400, "请求字段不符合协议");
  return value;
}
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export function authorize(header, devices) {
  if (typeof header !== "string" || !/^Bearer [a-f0-9]{64}$/.test(header))
    return undefined;
  const hash = Buffer.from(digest(header.slice(7)), "hex");
  return devices.find(
    (d) =>
      /^[a-f0-9]{64}$/.test(d.tokenHash) &&
      timingSafeEqual(hash, Buffer.from(d.tokenHash, "hex")),
  );
}
export function safeName(value) {
  // A supplied name is display metadata, never a path. Preserve an ordinary suffix for parsers.
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 200 ||
    /[\x00-\x1f<>:"/\\|?*]/u.test(value) ||
    /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  )
    throw fault(400, "文件名不适合本机存储，请先重命名");
  return value;
}
export function jobInput(value) {
  exact(value, ["action", "fileId", "requestId"]);
  if (
    typeof value.action !== "string" ||
    typeof value.fileId !== "string" ||
    typeof value.requestId !== "string" ||
    !Object.hasOwn(ACTIONS, value.action) ||
    !UUID.test(value.fileId) ||
    !UUID.test(value.requestId)
  )
    throw fault(400, "无效的分析任务");
  return value;
}
