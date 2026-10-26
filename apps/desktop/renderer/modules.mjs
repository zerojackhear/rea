export const modules = [
  {
    id: "native",
    title: "原生二进制",
    short: "原生分析",
    icon: "binary",
    description: "探索函数、类型、指令与调用关系，定位软件的核心逻辑。",
    tags: ["EXE", "ELF", "Mach-O"],
    kind: "本地引擎",
  },
  {
    id: "javascript",
    title: "JavaScript 分析",
    short: "JavaScript",
    icon: "code",
    description: "读取模块、导入、路由和源码映射，梳理应用结构。",
    tags: ["JS", "TS", "Source Map"],
    kind: "静态与运行观察",
  },
  {
    id: "electron",
    title: "Electron 应用",
    short: "Electron",
    icon: "layers",
    description: "关联主进程、渲染进程、ASAR 内容与 IPC 边界。",
    tags: ["ASAR", "IPC", "Desktop"],
    kind: "静态与运行观察",
  },
  {
    id: "dotnet",
    title: ".NET 与托管代码",
    short: ".NET / 托管代码",
    icon: "braces",
    description: "检查程序集、类型和成员，比较托管代码与原生关联。",
    tags: ["DLL", "IL", "NativeAOT"],
    kind: "本地分析",
  },
  {
    id: "mobile",
    title: "Android 与 Flutter",
    short: "Android / Flutter",
    icon: "phone",
    description: "检查 APK、资源、Manifest 和 Dart AOT 快照。",
    tags: ["APK", "DEX", "Dart AOT"],
    kind: "移动应用分析",
  },
  {
    id: "browser",
    title: "浏览器与 Web",
    short: "浏览器 / Web",
    icon: "globe",
    description: "观察页面、脚本、模块与网络活动，保留来源上下文。",
    tags: ["DOM", "CDP", "Network"],
    kind: "浏览器观察",
  },
  {
    id: "firmware",
    title: "固件与制品",
    short: "固件 / 制品",
    icon: "box",
    description: "识别归档、资源和嵌入内容，查看文件结构与格式事实。",
    tags: ["Archive", "Firmware", "Resources"],
    kind: "文件与格式检查",
  },
  {
    id: "go-rust",
    title: "Go 与 Rust",
    short: "Go / Rust",
    icon: "terminal",
    description: "提取编译器、模块、依赖与构建信息，不需要执行目标。",
    tags: ["Build Info", "Crates", "Modules"],
    kind: "内置静态分析",
  },
  {
    id: "wasm-evm",
    title: "WASM 与 EVM",
    short: "WASM / EVM",
    icon: "hexagon",
    description: "查看字节码、导入导出、选择器和推导出的接口。",
    tags: ["WASM", "WAT", "Bytecode"],
    kind: "离线分析",
  },
  {
    id: "sqlite",
    title: "SQLite 数据库",
    short: "SQLite 数据库",
    icon: "database",
    description: "检查数据库结构、索引与选定数据，保留快照来源。",
    tags: ["Schema", "Tables", "WAL"],
    kind: "本地数据检查",
  },
  {
    id: "network",
    title: "网络记录与信号",
    short: "网络 / 逻辑信号",
    icon: "activity",
    description: "解析已捕获的网络记录与逻辑信号，保留未知和不完整信息。",
    tags: ["PCAP", "qlog", "Signals"],
    kind: "记录与协议分析",
  },
  {
    id: "runtime",
    title: "运行时与调试",
    short: "运行时 / 调试",
    icon: "crosshair",
    description: "按明确选择的目标开展进程、调试器与运行时调查。",
    tags: ["Process", "Debugger", "Trace"],
    kind: "需要明确目标",
    active: true,
  },
  {
    id: "evidence",
    title: "证据与调查",
    short: "证据 / 调查",
    icon: "file",
    description: "浏览证据、来源、调查记录和重建结论，保留覆盖限制。",
    tags: ["Evidence", "Provenance", "Snapshots"],
    kind: "证据工作流",
  },
  {
    id: "system",
    title: "环境与会话",
    short: "环境 / 会话",
    icon: "settings",
    description: "检查本机能力、分析提供方与会话状态。",
    tags: ["Providers", "Sessions", "Diagnostics"],
    kind: "本机诊断",
  },
];
export const icons = {
  home: ["M3 10 12 3l9 7", "M5 9v12h5v-7h4v7h5V9"],
  clock: ["M12 8v5l3 2", "M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9Z"],
  binary: [
    "M5 3h5v7H5z",
    "M14 14h5v7h-5z",
    "M16 3v7",
    "M5 14h5M7.5 14v7M5 21h5",
    "M14 3h4",
  ],
  code: ["m8 7-5 5 5 5", "m16 7 5 5-5 5", "m14 4-4 16"],
  layers: ["m12 3 10 5-10 5L2 8Z", "m2 12 10 5 10-5", "m2 16 10 5 10-5"],
  braces: [
    "M8 3H6a2 2 0 0 0-2 2v4a3 3 0 0 1-2 3 3 3 0 0 1 2 3v4a2 2 0 0 0 2 2h2",
    "M16 3h2a2 2 0 0 1 2 2v4a3 3 0 0 0 2 3 3 3 0 0 0-2 3v4a2 2 0 0 1-2 2h-2",
  ],
  phone: [
    "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z",
    "M10 18h4",
    "M9 5h6",
  ],
  globe: [
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    "M3 12h18",
    "M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z",
  ],
  box: ["m12 3 9 5v8l-9 5-9-5V8Z", "m3 8 9 5 9-5", "M12 13v8", "m7.5 5.5 9 5"],
  terminal: ["M3 4h18v16H3z", "m7 9 3 3-3 3", "M13 15h4"],
  hexagon: ["m12 2 9 5v10l-9 5-9-5V7Z", "m8 9 4 3 4-3", "M12 12v5"],
  database: [
    "M21 5c0 1.66-4 3-9 3S3 6.66 3 5s4-3 9-3 9 1.34 9 3Z",
    "M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5",
    "M3 12c0 1.66 4 3 9 3s9-1.34 9-3",
  ],
  activity: ["M2 12h4l3-8 6 16 3-8h4"],
  crosshair: [
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    "M12 1v5M12 18v5M1 12h5M18 12h5",
    "M12 10v4M10 12h4",
  ],
  file: ["M14 2H5v20h14V7Z", "M14 2v5h5", "M8 12h8M8 16h6"],
  settings: [
    "m9 3-.5 3-2 .9-2.5-1-2 3.4L4 11v2l-2 1.7 2 3.4 2.5-1 2 .9L9 21h6l.5-3 2-.9 2.5 1 2-3.4-2-1.7v-2l2-1.7-2-3.4-2.5 1-2-.9L15 3Z",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  ],
  arrow: ["M4 12h16", "m14 6 6 6-6 6"],
  upload: ["M12 16V3", "m7 8 5-5 5 5", "M4 16v5h16v-5"],
  folder: ["M3 5h7l2 3h9v12H3Z"],
  search: ["M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z", "m15 15 6 6"],
  play: ["m8 4 12 8-12 8Z"],
  check: ["m5 12 4 4L19 6"],
  close: ["m6 6 12 12M6 18 18 6"],
  copy: ["M8 8h13v13H8z", "M16 8V3H3v13h5"],
  download: ["M12 3v13", "m7 11 5 5 5-5", "M4 17v4h16v-4"],
  refresh: [
    "M20 7v5h-5",
    "M4 17v-5h5",
    "M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2",
  ],
  shield: ["m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z", "m8 12 3 3 5-6"],
  chevron: ["m9 5 7 7-7 7"],
};
export function classifyTool(tool) {
  const n = tool.name.toLowerCase();
  if (/electron/.test(n)) return "electron";
  if (/flutter|dart|android|apk|jadx|jeb|adb|dex|harmony|hap_/.test(n))
    return "mobile";
  if (/dotnet|managed|assembly|nativeaot|il2cpp|csharp/.test(n))
    return "dotnet";
  if (/(^|_)go(_|$)|rust|crate|cargo/.test(n)) return "go-rust";
  if (/wasm|evm|bytecode|wat_/.test(n)) return "wasm-evm";
  if (/sqlite|database/.test(n)) return "sqlite";
  if (/pcap|qlog|signal|logic_|capture_file|network_record|har_/.test(n))
    return "network";
  if (/browser|web_|page_|dom_|css_|cdp|website/.test(n)) return "browser";
  if (
    /javascript|source_map|sourcemap|js_|npm|bundle|webpack|application_graph|application_module/.test(
      n,
    )
  )
    return "javascript";
  if (/firmware|artifact|archive|extract|plist|resource|asset_catalog/.test(n))
    return "firmware";
  if (
    /evidence|reconstruct|investigation|analysis_view|snapshot|obligation/.test(
      n,
    )
  )
    return "evidence";
  if (
    /process|debug|breakpoint|register|frida|rizin|gdb|trace|thread|memory|instrument|inspector|runtime|attach|resume|step_/.test(
      n,
    )
  )
    return "runtime";
  if (
    /doctor|setup|capabilit|provider|session|cache|config|health|tool|environment|route|status/.test(
      n,
    )
  )
    return "system";
  return "native";
}
export function moduleForPath(path) {
  if (/\.(?:apk|aab|dex|hap)$/i.test(path)) return "mobile";
  if (/\.asar$/i.test(path)) return "electron";
  if (/\.(?:js|cjs|mjs|ts|tsx|jsx|map)$/i.test(path)) return "javascript";
  if (/\.(?:sqlite|sqlite3|db)$/i.test(path)) return "sqlite";
  if (/\.(?:wasm|wat)$/i.test(path)) return "wasm-evm";
  if (/\.(?:pcap|pcapng|qlog|har|vcd|sr)$/i.test(path)) return "network";
  if (/\.(?:zip|tar|gz|xz|img|bin|plist)$/i.test(path)) return "firmware";
  return "native";
}
