import { modules, icons, classifyTool, moduleForPath } from "./modules.mjs";
import {
  schemaFields,
  fieldType,
  defaultFieldValue,
  readFormArguments,
  formArgumentsToJson,
  readJsonArguments,
} from "./schema.mjs";

const api = window.rea;
const content = document.querySelector("#content");
const state = {
  view: "home",
  moduleId: "javascript",
  tools: [],
  history: [],
  engine: { connection: "connecting" },
  query: "",
  toolFilter: "",
  filter: "all",
  selectedTool: null,
  selectedPath: "",
  panelTab: "parameters",
  formMode: "fields",
  drafts: new Map(),
  rawDrafts: new Map(),
  errors: [],
  formError: "",
  activeTaskId: null,
  records: new Map(),
  progress: new Map(),
  resultMode: "tree",
  loadingResult: false,
  loadingTools: false,
  connectError: "",
  searchLimit: 60,
};
const finalStates = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const stateNames = {
  queued: "等待中",
  running: "分析中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
const labels = {
  path: "目标路径",
  target_path: "目标路径",
  file_path: "文件路径",
  binary_path: "二进制文件",
  artifact_path: "制品路径",
  application_path: "应用路径",
  application_root: "应用目录",
  database_path: "数据库路径",
  input_path: "输入文件",
  directory: "目标目录",
  query: "搜索内容",
  pattern: "匹配模式",
  limit: "返回数量",
  offset: "起始位置",
  session_id: "会话 ID",
  evidence_id: "证据 ID",
  provider: "分析引擎",
  address: "地址",
  function_address: "函数地址",
  function_name: "函数名称",
  include: "包含内容",
  format: "输入格式",
  timeout_ms: "超时时间（毫秒）",
  target: "分析目标",
  command: "操作命令",
  pid: "目标进程 ID",
  url: "页面地址",
};
const preferred = {
  javascript: [
    "analyze_javascript_application",
    "inspect_javascript_application",
  ],
  electron: ["analyze_javascript_application", "inspect_electron_application"],
  native: ["analyze", "analyze_binary", "inspect_binary"],
  mobile: [
    "inspect_flutter_binary",
    "inspect_flutter_aot",
    "inspect_android_package",
    "inspect_apk",
  ],
  dotnet: [
    "inspect_managed_assembly",
    "inspect_dotnet_assembly",
    "analyze_managed_assembly",
  ],
  "go-rust": ["inspect_go_binary", "inspect_rust_binary"],
  sqlite: ["inspect_sqlite_database"],
  "wasm-evm": ["inspect_wasm_artifact", "inspect_evm_bytecode"],
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function append(node, ...children) {
  for (const child of children)
    if (child !== undefined && child !== null)
      node.append(
        typeof child === "string" ? document.createTextNode(child) : child,
      );
  return node;
}
function icon(name, extraClass = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon " + extraClass);
  for (const value of icons[name] ?? icons.file) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", value);
    svg.append(path);
  }
  return svg;
}
function button(text, className, action, iconName) {
  const node = el("button", className);
  node.type = "button";
  if (iconName) node.append(icon(iconName));
  if (text) node.append(document.createTextNode(text));
  node.addEventListener("click", (event) => {
    const result = action?.(event);
    if (result && typeof result.catch === "function") result.catch(showError);
  });
  return node;
}
function message(error) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object")
    return error.message ?? JSON.stringify(error);
  return String(error ?? "发生未知错误");
}
function toast(text, error = false) {
  const node = el("div", "toast" + (error ? " error" : ""), text);
  document.querySelector("#toast-region").append(node);
  setTimeout(() => node.remove(), error ? 7000 : 3800);
}
function showError(error) {
  toast(message(error), true);
}
function moduleById(id) {
  return modules.find((item) => item.id === id) ?? modules[0];
}
function getTask(id) {
  return state.history.find((item) => item.id === id);
}
function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function formatDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value < 1000
    ? Math.round(value) + " ms"
    : (value / 1000).toFixed(value < 10000 ? 1 : 0) + " s";
}
function badge(status) {
  return append(
    el("span", "badge " + status),
    el("span", "tiny-dot"),
    stateNames[status] ?? status,
  );
}
function sortedHistory() {
  return [...state.history].sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  );
}
function updateTask(task) {
  if (!task || typeof task.id !== "string") return;
  const index = state.history.findIndex((item) => item.id === task.id);
  if (index < 0) state.history.unshift(task);
  else state.history[index] = { ...state.history[index], ...task };
}
function navigate(view, moduleId, toolName) {
  state.view = view;
  state.query = "";
  document.querySelector("#global-search").value = "";
  state.formError = "";
  state.errors = [];
  if (moduleId) state.moduleId = moduleId;
  if (view === "module") {
    state.toolFilter = "";
    const tools = toolsForModule(state.moduleId);
    state.selectedTool = toolName
      ? state.tools.find((tool) => tool.name === toolName)
      : choosePreferred(tools, state.moduleId);
    state.panelTab = "parameters";
    state.formMode = "fields";
    if (state.selectedTool) ensureDraft(state.selectedTool);
  }
  render();
  content.scrollTop = 0;
}
function toolsForModule(id) {
  return state.tools.filter((tool) => classifyTool(tool) === id);
}
function choosePreferred(tools, id) {
  for (const name of preferred[id] ?? []) {
    const tool = tools.find((item) => item.name === name);
    if (tool) return tool;
  }
  return (
    tools.find((tool) => /^(inspect|analyze)_/.test(tool.name)) ??
    tools[0] ??
    null
  );
}
function ensureDraft(tool) {
  if (!state.drafts.has(tool.name)) {
    const entries = schemaFields(tool.inputSchema).map((field) => [
      field.key,
      defaultFieldValue(field.schema),
    ]);
    const draft = Object.fromEntries(entries);
    if (state.selectedPath) {
      const fields = schemaFields(tool.inputSchema);
      const pathField = fields.find(
        (field) =>
          /^(path|target_path|file_path|binary_path|artifact_path|application_path|application_root|database_path|input_path|root|directory)$/.test(
            field.key,
          ) && fieldType(field.schema) === "string",
      );
      if (pathField) draft[pathField.key] = state.selectedPath;
    }
    state.drafts.set(tool.name, draft);
  }
  if (!state.rawDrafts.has(tool.name)) {
    const parsed = readFormArguments(
      schemaFields(tool.inputSchema),
      state.drafts.get(tool.name),
    );
    state.rawDrafts.set(tool.name, JSON.stringify(parsed.arguments, null, 2));
  }
}
function renderSidebar() {
  const primary = document.querySelector("#primary-nav");
  primary.replaceChildren();
  for (const item of [
    { id: "home", title: "分析工作台", icon: "home" },
    { id: "history", title: "任务记录", icon: "clock" },
  ]) {
    const node = button(
      item.title,
      "nav-button" + (state.view === item.id && !state.query ? " active" : ""),
      () => navigate(item.id),
      item.icon,
    );
    if (item.id === "history" && state.history.length)
      node.append(el("span", "nav-count", state.history.length));
    primary.append(node);
  }
  const nav = document.querySelector("#module-nav");
  nav.replaceChildren();
  for (const item of modules) {
    const node = button(
      item.short,
      "nav-button" +
        (state.view === "module" && state.moduleId === item.id && !state.query
          ? " active"
          : ""),
      () => navigate("module", item.id),
      item.icon,
    );
    const count = toolsForModule(item.id).length;
    if (count) node.append(el("span", "nav-count", count));
    node.title = item.description;
    nav.append(node);
  }
}
function updateChrome() {
  renderSidebar();
  const connection = state.engine.connection;
  const error = connection === "error" || !api;
  document.querySelector("#sidebar-dot").className =
    "connection-dot " +
    (error ? "error" : connection === "ready" ? "ready" : "");
  document.querySelector("#statusbar-dot").className =
    "tiny-dot " + (error ? "error" : connection === "ready" ? "ready" : "");
  document.querySelector("#sidebar-status").textContent = error
    ? "分析引擎未连接"
    : connection === "ready"
      ? "本地引擎已就绪"
      : "正在连接分析引擎";
  document.querySelector("#sidebar-version").textContent = state.engine
    .coreVersion
    ? "REA " + state.engine.coreVersion + " · 本机运行"
    : "所有分析在本机进行";
  document.querySelector("#statusbar-text").textContent = error
    ? "连接需要检查"
    : connection === "ready"
      ? "已连接 · " + state.tools.length + " 个工具入口"
      : "正在连接本地引擎";
  const active = state.history.filter(
    (task) => task.state === "running" || task.state === "queued",
  ).length;
  document.querySelector("#statusbar-tasks").textContent = active
    ? active + " 项任务进行中"
    : state.history.length
      ? state.history.length + " 项本机任务记录"
      : "等待开始第一项分析";
  document.querySelector("#breadcrumb-current").textContent = state.query
    ? "工具搜索"
    : state.view === "home"
      ? "分析工作台"
      : state.view === "history"
        ? "任务记录"
        : state.view === "environment"
          ? "环境检测"
          : moduleById(state.moduleId).title;
}
function render() {
  updateChrome();
  content.replaceChildren();
  const container = el("div", "content-width");
  content.append(container);
  if (state.query) renderSearch(container);
  else if (state.view === "module") renderModule(container);
  else if (state.view === "history") renderHistory(container);
  else if (state.view === "environment") renderEnvironment(container);
  else renderHome(container);
}
function heading(title, subtitle, eyebrow) {
  const node = el("div");
  if (eyebrow) node.append(el("p", "eyebrow", eyebrow));
  node.append(
    el("h1", "page-heading", title),
    el("p", "page-subtitle", subtitle),
  );
  return node;
}
function connectionErrorBanner() {
  if (!state.connectError && state.engine.connection !== "error") return null;
  return append(
    el("div", "compact-error"),
    el(
      "span",
      "",
      "本地引擎尚未连接：" +
        (state.connectError || message(state.engine.error)),
    ),
    button("重新连接", "btn btn-small btn-ghost", refreshConnection, "refresh"),
  );
}
async function pickTarget(kind) {
  if (!api) throw new Error("请在 REA Desktop 应用中使用文件选择。");
  const path = await api.pickPath({
    kind,
    title: kind === "directory" ? "选择要分析的应用目录" : "选择要分析的文件",
  });
  if (!path) return;
  state.selectedPath = path;
  const moduleId = kind === "directory" ? "javascript" : moduleForPath(path);
  navigate("module", moduleId);
  if (state.selectedTool) {
    state.drafts.delete(state.selectedTool.name);
    state.rawDrafts.delete(state.selectedTool.name);
    ensureDraft(state.selectedTool);
    render();
  }
}
async function analyzeExample() {
  const example = await api.getExample();
  const tool = state.tools.find((item) => item.name === example.tool);
  if (!tool) throw new Error("示例分析工具尚未就绪，请先等待本地引擎连接。");
  state.selectedPath = example.path;
  navigate("module", classifyTool(tool), tool.name);
  state.rawDrafts.set(tool.name, JSON.stringify(example.arguments, null, 2));
  state.formMode = "json";
  await submitTool();
}
function renderHome(container) {
  const top = el("div", "heading-row");
  top.append(
    heading(
      "让复杂的软件，变得清晰。",
      "从一个文件、一段代码或一次观察开始，把线索变成有来源的证据。",
      "LOCAL RESEARCH WORKSPACE",
    ),
  );
  top.append(
    append(el("span", "pill"), icon("shield"), "本地运行 · 证据可追溯"),
  );
  container.append(top);
  const error = connectionErrorBanner();
  if (error) container.append(error);
  const grid = el("div", "home-grid");
  const target = el("section", "target-card");
  target.append(
    append(
      el("div", "card-kicker"),
      "开始一项新的分析",
      el("span", "", "NEW INVESTIGATION"),
    ),
  );
  const drop = el("div", "drop-zone");
  drop.append(
    append(el("div", "upload-symbol"), icon("upload")),
    el("h2", "", "从一个分析目标开始"),
    el("p", "", "选择本机文件或应用目录，找到适合它的分析工具。"),
  );
  const buttons = el("div", "button-row");
  buttons.append(
    button("选择文件", "btn btn-primary", () => pickTarget("file"), "file"),
    button("选择文件夹", "btn", () => pickTarget("directory"), "folder"),
  );
  if (api?.getExample) {
    const example = button("分析示例", "btn btn-ghost", analyzeExample, "play");
    example.disabled = state.engine.connection !== "ready";
    buttons.append(example);
  }
  drop.append(buttons);
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("dragging");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", async (event) => {
    event.preventDefault();
    drop.classList.remove("dragging");
    try {
      const file = event.dataTransfer?.files?.[0];
      const path =
        file && api?.getDroppedPath ? await api.getDroppedPath(file) : null;
      if (!path) {
        toast("请选择本机文件或文件夹，以保留完整路径。");
        return;
      }
      state.selectedPath = path;
      navigate(
        "module",
        file.name.includes(".") ? moduleForPath(path) : "javascript",
      );
      if (state.selectedTool) {
        state.drafts.delete(state.selectedTool.name);
        state.rawDrafts.delete(state.selectedTool.name);
        ensureDraft(state.selectedTool);
        render();
      }
    } catch (error) {
      showError(error);
    }
  });
  target.append(drop);
  const types = el("div", "target-types");
  ["EXE / ELF", "JS / ASAR", "APK / DART", "DLL", "SQLITE", "WASM"].forEach(
    (type, index) => {
      if (index) types.append(el("i"));
      types.append(el("span", "", type));
    },
  );
  target.append(types);
  if (state.selectedPath) {
    const selected = append(
      el("div", "target-selected"),
      icon("file"),
      el("code", "", state.selectedPath),
    );
    selected.append(
      button(
        "继续分析",
        "text-button",
        () => navigate("module", moduleForPath(state.selectedPath)),
        "arrow",
      ),
    );
    target.append(selected);
  }
  const local = el("section", "local-card");
  const diagram = el("div", "local-illustration");
  diagram.append(
    append(el("span", "illustration-node"), icon("file")),
    el("span", "illustration-line"),
    append(el("span", "illustration-node main"), icon("layers")),
    el("span", "illustration-line"),
    append(el("span", "illustration-node"), icon("shield")),
  );
  local.append(
    diagram,
    el("h2", "", "分析留在本机，结论带着证据。"),
    el(
      "p",
      "",
      "统一访问 REA 的分析能力。保留原始结果、来源和未知项，让每一步调查都能被复核。",
    ),
  );
  const bottom = append(
    el("div", "local-card-bottom"),
    el("span", "", "YOUR MACHINE. YOUR EVIDENCE."),
  );
  bottom.append(
    button(
      "检查运行环境",
      "btn btn-small",
      () => navigate("environment"),
      "arrow",
    ),
  );
  local.append(bottom);
  grid.append(target, local);
  container.append(grid);
  const section = append(
    el("div", "section-title"),
    el("h2", "", "选择你的分析方向"),
  );
  section.append(
    button(
      "浏览全部工具",
      "text-button",
      () => {
        state.query = " ";
        document.querySelector("#global-search").value = "";
        render();
      },
      "arrow",
    ),
  );
  container.append(section);
  const cards = el("div", "quick-grid");
  for (const id of ["javascript", "native", "dotnet", "mobile"]) {
    const item = moduleById(id);
    const card = button("", "quick-card", () => navigate("module", id));
    card.append(
      append(
        el("div", "quick-card-top"),
        append(el("span", "quick-icon"), icon(item.icon)),
        icon("arrow"),
      ),
      el("h3", "", item.title),
      el("p", "", item.description),
    );
    const tags = el("div", "tag-row");
    for (const tag of item.tags) tags.append(el("span", "tag", tag));
    card.append(tags);
    cards.append(card);
  }
  container.append(cards);
  const recentHeader = append(
    el("div", "section-title"),
    el("h2", "", "最近的分析"),
  );
  recentHeader.append(
    button("查看全部任务", "text-button", () => navigate("history"), "arrow"),
  );
  container.append(recentHeader);
  const recent = el("div", "recent-card");
  const history = sortedHistory().slice(0, 4);
  if (!history.length)
    recent.append(
      append(
        el("div", "empty-recent"),
        icon("clock"),
        append(
          el("div"),
          el("strong", "", "你的第一项分析会出现在这里"),
          el("p", "", "完成任务后，可以随时返回查看参数、证据和完整结果。"),
        ),
      ),
    );
  else recent.append(taskTable(history));
  container.append(recent);
}
function taskTable(tasks) {
  const table = el("table", "table");
  const tr = el("tr");
  for (const text of ["分析工具", "状态", "开始时间", "耗时"])
    tr.append(el("th", "", text));
  table.append(append(el("thead"), tr));
  const body = el("tbody");
  for (const task of tasks) {
    const row = el("tr");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", "查看任务 " + task.tool);
    const open = () => openTask(task.id);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    row.append(
      el("td", "", task.tool),
      append(el("td"), badge(task.state)),
      el("td", "", formatDate(task.createdAt)),
      el("td", "", formatDuration(task.durationMs)),
    );
    body.append(row);
  }
  table.append(body);
  return table;
}
function renderModule(container) {
  const item = moduleById(state.moduleId);
  const head = el("div", "module-heading");
  head.append(
    append(el("div", "heading-mark"), icon(item.icon)),
    append(el("div"), el("h1", "", item.title), el("p", "", item.description)),
    el("span", "pill", item.kind),
  );
  container.append(head);
  const error = connectionErrorBanner();
  if (error) container.append(error);
  const layout = el("div", "module-layout");
  const toolPanel = el("section", "tool-panel");
  const tools = toolsForModule(state.moduleId);
  toolPanel.append(
    append(
      el("div", "tool-panel-heading"),
      "选择分析工具",
      el("small", "", tools.length + " 个工具"),
    ),
  );
  const filterWrap = el("div", "tool-filter-wrap");
  const filter = el("input", "tool-filter");
  filter.type = "search";
  filter.placeholder = "在此模块中查找…";
  filter.setAttribute("aria-label", "搜索当前模块工具");
  filter.value = state.toolFilter;
  filter.addEventListener("input", () => {
    state.toolFilter = filter.value;
    renderToolList(list, tools);
  });
  filterWrap.append(filter);
  const list = el("div", "tool-list");
  toolPanel.append(filterWrap, list);
  renderToolList(list, tools);
  const work = el("section", "work-panel");
  work.id = "work-panel";
  layout.append(toolPanel, work);
  container.append(layout);
  renderWorkPanel(work);
}
function renderToolList(list, tools) {
  list.replaceChildren();
  const query = state.toolFilter.trim().toLowerCase();
  const filtered = tools.filter(
    (tool) =>
      !query ||
      (tool.name + " " + (tool.description ?? ""))
        .toLowerCase()
        .includes(query),
  );
  if (state.loadingTools) {
    list.append(
      append(
        el("div", "loading-inline"),
        el("span", "spinner"),
        "正在读取工具…",
      ),
    );
    return;
  }
  if (!filtered.length) {
    list.append(
      emptyPanel(
        query ? "没有匹配的工具" : "暂未读取到工具",
        query
          ? "换一个关键词试试。"
          : "分析引擎就绪后，会显示这个模块的真实工具。",
        "search",
        true,
      ),
    );
    return;
  }
  for (const tool of filtered) {
    const node = button(
      "",
      "tool-item" + (state.selectedTool?.name === tool.name ? " selected" : ""),
      () => {
        state.selectedTool = tool;
        state.panelTab = "parameters";
        state.formError = "";
        state.errors = [];
        state.formMode = "fields";
        ensureDraft(tool);
        renderToolList(list, tools);
        renderWorkPanel(document.querySelector("#work-panel"));
      },
    );
    node.append(
      el("strong", "", tool.name),
      el("small", "", tool.description ?? "查看工具参数与说明"),
    );
    list.append(node);
  }
}
function emptyPanel(title, description, iconName = "file", compact = false) {
  return append(
    el("div", "empty-panel" + (compact ? " compact" : "")),
    icon(iconName),
    el(compact ? "h3" : "h2", "", title),
    el("p", "", description),
  );
}
function renderWorkPanel(panel) {
  if (!panel) return;
  panel.replaceChildren();
  const tabs = el("div", "panel-tabs");
  const parameters = button(
    "参数配置",
    "panel-tab" + (state.panelTab === "parameters" ? " active" : ""),
    () => {
      state.panelTab = "parameters";
      renderWorkPanel(panel);
    },
  );
  const result = button(
    "分析结果",
    "panel-tab" + (state.panelTab === "result" ? " active" : ""),
    () => {
      state.panelTab = "result";
      renderWorkPanel(panel);
    },
  );
  tabs.append(parameters, result);
  panel.append(tabs);
  if (state.panelTab === "result") {
    renderResult(panel);
    return;
  }
  if (!state.selectedTool) {
    panel.append(
      emptyPanel(
        "选择一个工具，开始调查",
        "左侧的工具来自本机 REA。每项工具都提供对应的参数与说明。",
        "layers",
      ),
    );
    return;
  }
  const tool = state.selectedTool;
  ensureDraft(tool);
  panel.append(
    append(
      el("div", "tool-description"),
      el("h2", "", tool.name),
      el("p", "", tool.description ?? "请填写此工具所需的参数。"),
    ),
  );
  if (
    moduleById(state.moduleId).active ||
    /^(launch|attach|execute|write|set|inject|resume|terminate|kill|install|setup)_/.test(
      tool.name,
    )
  ) {
    panel.append(
      append(
        el("div", "tool-contract-notice"),
        icon("crosshair"),
        el(
          "span",
          "",
          "这项操作可能影响所选目标。请先核对工具说明、目标路径与授权参数，再主动运行。",
        ),
      ),
    );
  }
  const toolbar = append(
    el("div", "form-toolbar"),
    el("strong", "", "分析参数"),
  );
  const segmented = el("div", "segmented");
  segmented.append(
    button("表单", state.formMode === "fields" ? "active" : "", () =>
      switchFormMode("fields"),
    ),
    button("JSON", state.formMode === "json" ? "active" : "", () =>
      switchFormMode("json"),
    ),
  );
  toolbar.append(segmented);
  panel.append(toolbar);
  const form = el("form", "tool-form");
  form.noValidate = true;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitTool().catch(showError);
  });
  const fields = schemaFields(tool.inputSchema);
  if (state.formMode === "json" || !fields.length) {
    form.append(
      el(
        "p",
        "input-caption",
        "使用完整 JSON 对象填写参数。省略的字段保持省略，null、空字符串和数组会按原样传递。",
      ),
    );
    const editor = el("textarea", "json-editor");
    editor.spellcheck = false;
    editor.setAttribute("aria-label", "工具参数 JSON");
    editor.value = state.rawDrafts.get(tool.name) ?? "{}";
    editor.addEventListener("input", () =>
      state.rawDrafts.set(tool.name, editor.value),
    );
    editor.addEventListener("keydown", insertTab);
    form.append(editor);
  } else {
    const values = state.drafts.get(tool.name);
    for (const field of fields) form.append(renderField(field, values));
  }
  panel.append(form);
  if (state.formError) panel.append(el("div", "error-banner", state.formError));
  const footer = el("div", "form-footer");
  footer.append(
    append(el("span"), icon("shield"), "分析在本机进行，完整结果可导出"),
  );
  const run = button("运行分析", "btn btn-primary", submitTool, "play");
  run.id = "run-analysis";
  run.disabled = !api || state.engine.connection !== "ready";
  footer.append(run);
  panel.append(footer);
}
function switchFormMode(mode) {
  if (!state.selectedTool || mode === state.formMode) return;
  const tool = state.selectedTool;
  if (mode === "json") {
    const result = formArgumentsToJson(
      schemaFields(tool.inputSchema),
      state.drafts.get(tool.name),
    );
    if (!result.ok) {
      state.errors = result.errors;
      state.formError =
        "部分参数格式需要检查，暂未切换到 JSON。原有输入已完整保留。";
      renderWorkPanel(document.querySelector("#work-panel"));
      return;
    }
    state.rawDrafts.set(tool.name, result.value);
  } else {
    try {
      const values = readJsonArguments(state.rawDrafts.get(tool.name) ?? "{}");
      const fields = schemaFields(tool.inputSchema);
      const known = new Set(fields.map((field) => field.key));
      const extras = Object.keys(values).filter((key) => !known.has(key));
      if (extras.length) {
        toast(
          "JSON 中含表单未定义的字段，请保留 JSON 模式，避免丢失参数。",
          true,
        );
        return;
      }
      const draft = Object.fromEntries(
        fields.map((field) => [
          field.key,
          Object.hasOwn(values, field.key)
            ? fieldType(field.schema) === "json"
              ? JSON.stringify(values[field.key], null, 2)
              : String(values[field.key])
            : "",
        ]),
      );
      if (
        Object.values(values).some((value) => value === null || value === "")
      ) {
        toast("包含 null 或空字符串时，请保留 JSON 模式，以保留精确参数。");
        return;
      }
      state.drafts.set(tool.name, draft);
    } catch (error) {
      showError(error);
      return;
    }
  }
  state.formMode = mode;
  state.formError = "";
  state.errors = [];
  renderWorkPanel(document.querySelector("#work-panel"));
}
function renderField(field, values) {
  const wrapper = el("div", "field");
  const label = el(
    "label",
    "field-label",
    labels[field.key] ?? field.schema.title ?? field.key.replaceAll("_", " "),
  );
  const inputId = "field-" + field.key;
  label.htmlFor = inputId;
  if (field.required) label.append(el("span", "required", "*"));
  if (labels[field.key] || field.schema.title)
    label.append(el("span", "field-key", field.key));
  wrapper.append(label);
  const type = fieldType(field.schema);
  let input;
  if (type === "enum" || type === "boolean") {
    input = el("select");
    input.append(
      el(
        "option",
        "",
        field.required ? "请选择…" : "未指定（使用工具默认行为）",
      ),
    );
    input.firstChild.value = "";
    const options =
      type === "boolean"
        ? [
            ["true", "是"],
            ["false", "否"],
          ]
        : field.schema.enum.map((value) => [value, value]);
    for (const [value, text] of options) {
      const option = el("option", "", text);
      option.value = value;
      input.append(option);
    }
  } else if (type === "json") {
    input = el("textarea");
    input.spellcheck = false;
    input.placeholder =
      field.schema.type === "array" ? "[\n  ...\n]" : "{\n  ...\n}";
    input.addEventListener("keydown", insertTab);
  } else {
    input = el("input", "field-input");
    input.type =
      type === "number" || type === "integer"
        ? "number"
        : field.schema.writeOnly || field.schema.format === "password"
          ? "password"
          : "text";
    if (type === "integer") input.step = "1";
    if (type === "number") input.step = "any";
    if (typeof field.schema.minimum === "number")
      input.min = String(field.schema.minimum);
    if (typeof field.schema.maximum === "number")
      input.max = String(field.schema.maximum);
    input.placeholder =
      typeof field.schema.default === "string"
        ? field.schema.default
        : /path|root|directory/.test(field.key)
          ? "选择或输入完整路径"
          : "填写 " + (labels[field.key] ?? field.key);
  }
  input.id = inputId;
  input.name = field.key;
  input.value = values[field.key] ?? "";
  input.autocomplete = "off";
  input.addEventListener("input", () => {
    values[field.key] = input.value;
  });
  const error = state.errors.find((item) => item.key === field.key);
  if (error) {
    input.classList.add("invalid");
    input.setAttribute("aria-invalid", "true");
  }
  if (
    type === "string" &&
    /(^path$|_path$|^root$|_root$|directory|folder)/.test(field.key)
  ) {
    const row = el("div", "field-input-row");
    row.append(input);
    const browse = button(
      "",
      "btn",
      async () => {
        const kind = /root|directory|folder/.test(field.key)
          ? "directory"
          : "file";
        const path = await api.pickPath({ kind, title: label.textContent });
        if (path) {
          values[field.key] = path;
          input.value = path;
        }
      },
      "folder",
    );
    browse.setAttribute("aria-label", "选择 " + field.key);
    browse.title = "浏览本机路径";
    browse.disabled = !api;
    row.append(browse);
    wrapper.append(row);
  } else wrapper.append(input);
  if (field.schema.description)
    wrapper.append(el("div", "field-help", field.schema.description));
  if (error) wrapper.append(el("div", "field-error", error.message));
  return wrapper;
}
function insertTab(event) {
  if (event.key !== "Tab" || event.shiftKey) return;
  event.preventDefault();
  const target = event.target;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  target.setRangeText("  ", start, end, "end");
  target.dispatchEvent(new Event("input"));
}
async function submitTool() {
  if (!api || !state.selectedTool || state.engine.connection !== "ready")
    return;
  const tool = state.selectedTool;
  let args;
  state.formError = "";
  state.errors = [];
  try {
    if (state.formMode === "json" || !schemaFields(tool.inputSchema).length)
      args = readJsonArguments(state.rawDrafts.get(tool.name) ?? "{}");
    else {
      const parsed = readFormArguments(
        schemaFields(tool.inputSchema),
        state.drafts.get(tool.name),
      );
      if (parsed.errors.length) {
        state.errors = parsed.errors;
        state.formError = "还有必填参数或格式需要检查。";
        renderWorkPanel(document.querySelector("#work-panel"));
        return;
      }
      args = parsed.arguments;
    }
    const task = await api.submit({ tool: tool.name, arguments: args });
    updateTask(task);
    state.activeTaskId = task.id;
    state.panelTab = "result";
    state.resultMode = "tree";
    updateChrome();
    renderWorkPanel(document.querySelector("#work-panel"));
    if (finalStates.has(task.state)) await loadResult(task.id);
  } catch (error) {
    state.formError = message(error);
    renderWorkPanel(document.querySelector("#work-panel"));
  }
}
function logicalResult(result) {
  if (!result) return null;
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (
    Array.isArray(result.content) &&
    result.content.length === 1 &&
    result.content[0]?.type === "text"
  ) {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result.content[0].text;
    }
  }
  return result;
}
function renderResult(panel) {
  const task = getTask(state.activeTaskId);
  if (!task) {
    panel.append(
      emptyPanel(
        "结果会出现在这里",
        "填写参数并运行分析后，在这里查看结构化结果、完整原文和来源信息。",
        "file",
      ),
    );
    return;
  }
  const head = el("div", "result-header");
  const title = el("div", "result-title");
  title.append(
    icon(
      finalStates.has(task.state)
        ? task.state === "completed"
          ? "check"
          : "file"
        : "activity",
    ),
  );
  title.append(
    append(
      el("div"),
      el("strong", "", stateNames[task.state] ?? task.state),
      el("small", "", task.tool),
    ),
  );
  const actions = el("div", "result-actions");
  const record = state.records.get(task.id);
  const copy = button(
    "复制",
    "btn btn-small",
    async () => {
      await api.copyText(JSON.stringify(record, null, 2));
      toast("已复制完整任务结果。");
    },
    "copy",
  );
  const save = button(
    "导出",
    "btn btn-small",
    async () => {
      const result = await api.exportResult(task.id);
      if (result?.saved)
        toast("结果已导出" + (result.path ? "：" + result.path : "。"));
    },
    "download",
  );
  copy.disabled = !record;
  save.disabled = !record;
  actions.append(copy, save);
  head.append(title, actions);
  panel.append(head);
  const meta = el("div", "result-meta");
  meta.append(
    el("span", "", formatDate(task.createdAt)),
    el("span", "", "耗时 " + formatDuration(task.durationMs)),
    el("code", "", task.id),
  );
  panel.append(meta);
  if (
    task.engineSessionId &&
    state.engine.sessionId &&
    task.engineSessionId !== state.engine.sessionId
  ) {
    panel.append(
      append(
        el("div", "tool-contract-notice"),
        icon("clock"),
        el(
          "span",
          "",
          "这是之前分析会话的记录。原始结果可查看；其中的会话或证据引用可能需要重新分析后才能继续调用。",
        ),
      ),
    );
  }
  if (!finalStates.has(task.state)) {
    const progress = state.progress.get(task.id);
    const box = el("div", "progress-card");
    box.id = "task-progress";
    const titleText =
      task.state === "queued" ? "任务已进入队列" : "正在分析，请稍候";
    box.append(
      append(el("strong"), el("span", "pulse"), titleText),
      el(
        "p",
        "",
        progress?.message ??
          (task.state === "queued"
            ? "前面的任务完成后会自动开始。"
            : "本机分析引擎正在处理当前请求，完成后会保留完整结果。"),
      ),
    );
    const bar = el("progress");
    if (
      typeof progress?.total === "number" &&
      progress.total > 0 &&
      typeof progress.progress === "number"
    ) {
      bar.max = progress.total;
      bar.value = progress.progress;
    }
    bar.setAttribute("aria-label", "分析进度");
    box.append(
      bar,
      append(
        el("div", "button-row"),
        button("取消任务", "btn btn-small", () => cancelTask(task.id), "close"),
      ),
    );
    panel.append(box);
    return;
  }
  if (state.loadingResult && !record) {
    panel.append(
      append(
        el("div", "loading-inline"),
        el("span", "spinner"),
        "正在读取已保存的结果…",
      ),
    );
    return;
  }
  if (!record) {
    const empty = emptyPanel(
      task.state === "cancelled" ? "任务已取消" : "结果暂时不可用",
      task.error ? message(task.error) : "可以重新读取保留在本机的任务记录。",
      "file",
    );
    empty.append(
      append(
        el("div", "button-row"),
        button(
          "重新读取",
          "btn btn-small",
          () => loadResult(task.id),
          "refresh",
        ),
      ),
    );
    panel.append(empty);
    return;
  }
  if (task.inputProjection?.replayable === false)
    panel.append(
      el(
        "div",
        "tool-contract-notice",
        "认证信息未保存，再次运行需要重新输入。",
      ),
    );
  if (
    record.diagnostics?.desktopProjection?.canonicalMcpResultAvailable === false
  )
    panel.append(
      el("div", "error-banner", "仅保存了标记的脱敏预览，不是完整原始证据。"),
    );
  if (task.error) panel.append(el("div", "error-banner", message(task.error)));
  if (record.result?.isError && !task.error)
    panel.append(
      el(
        "div",
        "error-banner",
        "工具返回了错误结果。下方保留了完整错误信息和已有证据。",
      ),
    );
  if (record.diagnostics?.serverSettlement === "unconfirmed")
    panel.append(
      append(
        el("div", "tool-contract-notice"),
        icon("activity"),
        el(
          "span",
          "",
          "客户端已停止等待。服务端操作是否结束、资源是否清理，仍未确认；请查看完整记录中的诊断信息。",
        ),
      ),
    );
  const toolbar = el("div", "result-view-toolbar");
  const segmented = el("div", "segmented");
  segmented.append(
    button("结构化结果", state.resultMode === "tree" ? "active" : "", () => {
      state.resultMode = "tree";
      renderWorkPanel(panel);
    }),
    button("完整原文", state.resultMode === "raw" ? "active" : "", () => {
      state.resultMode = "raw";
      renderWorkPanel(panel);
    }),
  );
  toolbar.append(segmented, el("small", "", "unknown / partial 按原结果保留"));
  panel.append(toolbar);
  if (state.resultMode === "raw")
    panel.append(el("pre", "raw-output", JSON.stringify(record, null, 2)));
  else {
    const tree = el("div", "result-tree");
    const value = logicalResult(record.result);
    if (value === null && record.result === undefined)
      tree.append(renderTree("任务记录", record, 0));
    else tree.append(renderTree("result", value, 0));
    panel.append(tree);
  }
}
function renderTree(key, value, depth) {
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    const detail = el("details", "tree-node");
    const summary = el("summary");
    summary.append(
      el("span", "", key),
      el(
        "span",
        "tree-count",
        Array.isArray(value)
          ? "[ " + entries.length + " 项 ]"
          : "{ " + entries.length + " 项 }",
      ),
    );
    detail.append(summary);
    let built = false;
    function build() {
      if (built || !detail.open) return;
      built = true;
      let offset = 0;
      const children = el("div");
      const more = button("", "text-button", showPage);
      function showPage() {
        const page = entries.slice(offset, offset + 100);
        for (const [childKey, childValue] of page)
          children.append(renderTree(childKey, childValue, depth + 1));
        offset += page.length;
        more.textContent =
          "继续展开 · 已显示 " + offset + " / " + entries.length + " 项";
        more.hidden = offset >= entries.length;
      }
      showPage();
      detail.append(children, more);
    }
    detail.addEventListener("toggle", build);
    if (depth < 1) {
      detail.open = true;
      build();
    }
    return detail;
  }
  const row = el("div", "tree-primitive");
  row.append(el("span", "tree-key", key + ":"));
  if (value === null) row.append(el("span", "tree-null", "null"));
  else if (typeof value === "boolean")
    row.append(el("span", "tree-boolean", String(value)));
  else if (typeof value === "number")
    row.append(el("span", "tree-number", String(value)));
  else if (value === "unknown" || value === "partial")
    row.append(el("span", "tree-semantic " + value, value));
  else {
    const text = typeof value === "string" ? value : String(value);
    const span = el(
      "span",
      "tree-string",
      text.length > 1800 ? text.slice(0, 1800) + "…" : text,
    );
    row.append(span);
    if (text.length > 1800) {
      const more = button(
        "展开全文（" + text.length + " 字符）",
        "text-button",
        () => {
          span.textContent = text;
          more.remove();
        },
      );
      row.append(more);
    }
  }
  return row;
}
async function loadResult(id) {
  state.loadingResult = true;
  try {
    const record = await api.getResult(id);
    state.records.set(id, record);
    if (record?.task) updateTask(record.task);
  } catch (error) {
    showError(error);
  } finally {
    state.loadingResult = false;
    if (
      state.activeTaskId === id &&
      state.view === "module" &&
      state.panelTab === "result"
    )
      renderWorkPanel(document.querySelector("#work-panel"));
  }
}
async function cancelTask(id) {
  await api.cancelTask(id);
  toast("已发送取消请求；最终状态以分析引擎返回为准。");
}
function openTask(id) {
  const task = getTask(id);
  if (!task) return;
  const tool = state.tools.find((item) => item.name === task.tool);
  state.activeTaskId = id;
  state.selectedTool = tool ?? null;
  state.moduleId = tool ? classifyTool(tool) : "evidence";
  state.view = "module";
  state.panelTab = "result";
  state.query = "";
  document.querySelector("#global-search").value = "";
  state.resultMode = "tree";
  render();
  if (finalStates.has(task.state) && !state.records.has(id)) loadResult(id);
}
function renderHistory(container) {
  container.append(
    append(
      el("div", "heading-row"),
      heading(
        "每一步调查，都有迹可循。",
        "任务记录与完整结果保存在本机。重新打开任意任务，查看当时的参数和证据。",
        "INVESTIGATION HISTORY",
      ),
      button(
        "刷新记录",
        "btn",
        async () => {
          state.history = await api.listHistory();
          render();
        },
        "refresh",
      ),
    ),
  );
  const controls = el("div", "history-controls");
  const filters = el("div", "history-filter");
  for (const [id, text] of [
    ["all", "全部任务"],
    ["active", "进行中"],
    ["completed", "已完成"],
    ["failed", "失败 / 中断"],
  ])
    filters.append(
      button(text, state.filter === id ? "active" : "", () => {
        state.filter = id;
        render();
      }),
    );
  controls.append(
    filters,
    el("span", "history-count", state.history.length + " 项任务"),
  );
  container.append(controls);
  const tasks = sortedHistory().filter(
    (task) =>
      state.filter === "all" ||
      (state.filter === "active" &&
        ["running", "queued"].includes(task.state)) ||
      (state.filter === "completed" && task.state === "completed") ||
      (state.filter === "failed" &&
        ["failed", "cancelled", "interrupted"].includes(task.state)),
  );
  if (!tasks.length) {
    const empty = emptyPanel(
      state.history.length ? "此分类暂无任务" : "还没有分析记录",
      state.history.length
        ? "选择其他分类，或发起一项新的分析。"
        : "从工作台选择文件或分析模块，开始你的第一项调查。",
      "clock",
    );
    empty.append(
      append(
        el("div", "button-row"),
        button(
          "返回工作台",
          "btn btn-primary",
          () => navigate("home"),
          "arrow",
        ),
      ),
    );
    container.append(append(el("div", "recent-card"), empty));
    return;
  }
  const list = el("div", "history-list");
  for (const task of tasks) {
    const tool = state.tools.find((item) => item.name === task.tool);
    const item = button("", "history-item", () => openTask(task.id));
    item.append(
      append(
        el("span", "history-icon"),
        icon(tool ? moduleById(classifyTool(tool)).icon : "file"),
      ),
    );
    const args = task.arguments ?? {};
    const path = Object.entries(args).find(
      ([key, value]) =>
        /path|root|directory/.test(key) && typeof value === "string",
    )?.[1];
    item.append(
      append(
        el("div", "history-item-main"),
        el("strong", "", task.tool),
        el("small", "", path ?? task.id),
      ),
    );
    item.append(
      append(
        el("div", "history-item-meta"),
        badge(task.state),
        el("span", "", formatDate(task.createdAt)),
        el("span", "", formatDuration(task.durationMs)),
        icon("chevron"),
      ),
    );
    list.append(item);
  }
  container.append(list);
}
function renderEnvironment(container) {
  container.append(
    append(
      el("div", "heading-row"),
      heading(
        "环境就绪，调查才能顺畅。",
        "查看桌面应用与本地引擎的连接状态。外部分析工具按任务需要使用本机安装。",
        "LOCAL ENVIRONMENT",
      ),
      button("刷新检测", "btn", refreshConnection, "refresh"),
    ),
  );
  const ready = state.engine.connection === "ready";
  const connection = el(
    "div",
    "connection-panel" + (state.engine.connection === "error" ? " error" : ""),
  );
  connection.append(
    icon(ready ? "shield" : "activity"),
    append(
      el("div"),
      el(
        "h2",
        "",
        ready
          ? "已连接到本地 REA 引擎"
          : state.engine.connection === "error"
            ? "本地分析引擎需要检查"
            : "正在连接本地分析引擎",
      ),
      el(
        "p",
        "",
        ready
          ? "分析工具已从运行中的引擎读取。任务与结果均保留在本机。"
          : state.connectError ||
              message(state.engine.error ?? "等待引擎启动，请稍候。"),
      ),
    ),
  );
  container.append(connection);
  const grid = el("div", "environment-grid");
  for (const [title, value, note, iconName] of [
    [
      "REA 核心",
      state.engine.coreVersion ? "v" + state.engine.coreVersion : "等待连接",
      "当前运行中的核心版本",
      "layers",
    ],
    [
      "Node.js 运行时",
      state.engine.nodeVersion
        ? "v" + String(state.engine.nodeVersion).replace(/^v/, "")
        : "等待连接",
      "独立的本机分析运行时",
      "terminal",
    ],
    [
      "已加载工具入口",
      state.tools.length ? String(state.tools.length) : "—",
      "由本机引擎实时提供",
      "settings",
    ],
  ]) {
    const card = el("div", "environment-stat");
    card.append(
      append(el("span"), icon(iconName), title),
      el("strong", "", value),
      el("small", "", note),
    );
    grid.append(card);
  }
  container.append(grid);
  const providers = append(
    el("section", "info-card"),
    el("h2", "", "按需配置你的分析工具"),
    el(
      "p",
      "",
      "JavaScript、Go、Rust 等能力可进行本地静态检查。原生深度分析、Android 或固件任务可能需要已安装的 Ghidra、IDA、JADX 或其他工具。工具是否适用于当前目标，以相应诊断和分析结果为准。",
    ),
  );
  providers.append(
    append(
      el("div", "button-row"),
      button(
        "查看环境与会话工具",
        "btn",
        () => navigate("module", "system"),
        "settings",
      ),
      button(
        "浏览原生分析",
        "btn btn-ghost",
        () => navigate("module", "native"),
        "arrow",
      ),
    ),
  );
  container.append(providers);
  const evidence = append(
    el("section", "info-card"),
    el("h2", "", "保留来源，也保留不确定性"),
    el(
      "p",
      "",
      "桌面应用展示工具返回的结构化结果与完整原文。unknown、partial、错误和清理限制会保留在结果中；关闭窗口或取消任务，不等于目标进程状态已经确定。",
    ),
  );
  container.append(evidence);
}
function renderSearch(container) {
  const query = state.query.trim().toLowerCase();
  const tools = state.tools.filter(
    (tool) =>
      !query ||
      (
        tool.name +
        " " +
        (tool.description ?? "") +
        " " +
        moduleById(classifyTool(tool)).title
      )
        .toLowerCase()
        .includes(query),
  );
  container.append(
    heading(
      query ? "找到与“" + state.query.trim() + "”相关的工具" : "全部分析工具",
      tools.length + " 个工具 · 直接查看参数与工具说明",
      "TOOL EXPLORER",
    ),
  );
  const controls = append(
    el("div", "section-title"),
    el("p", "", "工具来自本地引擎，选择工具后再运行。"),
  );
  controls.append(
    button("返回工作台", "text-button", () => navigate("home"), "arrow"),
  );
  container.append(controls);
  if (!tools.length) {
    container.append(
      emptyPanel(
        "没有找到匹配的工具",
        state.tools.length
          ? "试试英文工具名、中文模块名，或换一个更短的关键词。"
          : "本地引擎连接完成后，工具会出现在这里。",
        "search",
      ),
    );
    return;
  }
  const list = el("div", "search-results");
  for (const tool of tools.slice(0, state.searchLimit)) {
    const module = moduleById(classifyTool(tool));
    const card = button("", "search-result", () =>
      navigate("module", module.id, tool.name),
    );
    card.append(
      icon(module.icon),
      append(
        el("div"),
        el("strong", "", tool.name),
        el("p", "", tool.description ?? "查看此工具的参数与说明。"),
        el("small", "", module.title),
      ),
    );
    list.append(card);
  }
  container.append(list);
  if (tools.length > state.searchLimit)
    container.append(
      append(
        el("div", "show-more-row"),
        button(
          "继续显示 · 已显示 " + state.searchLimit + " / " + tools.length,
          "btn",
          () => {
            state.searchLimit += 60;
            render();
          },
        ),
      ),
    );
}
let refreshInFlight = false;
let refreshQueued = false;
async function refreshConnection() {
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }
  if (!api) {
    state.engine = {
      connection: "error",
      error: "桌面连接不可用。请使用 REA Desktop 程序打开界面。",
    };
    state.connectError = state.engine.error;
    render();
    return;
  }
  refreshInFlight = true;
  state.loadingTools = true;
  try {
    const results = await Promise.allSettled([
      api.getState(),
      api.listTools(),
      api.listHistory(),
    ]);
    if (results[0].status === "fulfilled") state.engine = results[0].value;
    if (results[1].status === "fulfilled") {
      state.tools = Array.isArray(results[1].value)
        ? results[1].value
        : (results[1].value?.tools ?? []);
      state.connectError = "";
    } else state.connectError = message(results[1].reason);
    if (results[2].status === "fulfilled") state.history = results[2].value;
    if (results[0].status === "rejected" && results[1].status === "rejected")
      state.engine = { connection: "error", error: state.connectError };
    if (state.view === "module" && !state.selectedTool) {
      state.selectedTool = choosePreferred(
        toolsForModule(state.moduleId),
        state.moduleId,
      );
      if (state.selectedTool) ensureDraft(state.selectedTool);
    }
  } catch (error) {
    state.connectError = message(error);
    state.engine = { connection: "error", error: state.connectError };
  } finally {
    state.loadingTools = false;
    refreshInFlight = false;
    render();
    if (refreshQueued) {
      refreshQueued = false;
      queueMicrotask(refreshConnection);
    }
  }
}
function onBackendEvent(event) {
  if (!event || typeof event !== "object") return;
  const value = event.value;
  if (event.event === "state") {
    state.engine = value;
    if (value.connection === "ready") {
      state.connectError = "";
      if (!state.tools.length) refreshConnection();
    }
    updateChrome();
    if (state.view === "environment") render();
  } else if (event.event === "task") {
    updateTask(value);
    updateChrome();
    if (
      state.activeTaskId === value?.id &&
      state.view === "module" &&
      state.panelTab === "result"
    ) {
      renderWorkPanel(document.querySelector("#work-panel"));
      if (finalStates.has(value.state)) loadResult(value.id);
    } else if (state.view === "home" || state.view === "history") render();
  } else if (event.event === "progress") {
    const id = value?.id ?? value?.taskId;
    if (!id) return;
    state.progress.set(id, value);
    if (
      state.activeTaskId === id &&
      state.view === "module" &&
      state.panelTab === "result"
    ) {
      const box = document.querySelector("#task-progress");
      if (box) {
        if (value.message) box.querySelector("p").textContent = value.message;
        const bar = box.querySelector("progress");
        if (
          typeof value.total === "number" &&
          value.total > 0 &&
          typeof value.progress === "number"
        ) {
          bar.max = value.total;
          bar.value = value.progress;
        }
      }
    }
  }
}
document
  .querySelector("#environment-link")
  .addEventListener("click", () => navigate("environment"));
for (const action of ["minimize", "maximize", "close"])
  document.querySelector("#window-" + action).addEventListener("click", () => {
    if (api) Promise.resolve(api.windowControl(action)).catch(showError);
  });
let searchTimer;
document.querySelector("#global-search").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value;
  searchTimer = setTimeout(() => {
    state.query = value;
    state.searchLimit = 60;
    render();
  }, 120);
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.querySelector("#global-search").focus();
  }
  if (event.key === "Escape" && state.query) {
    state.query = "";
    document.querySelector("#global-search").value = "";
    render();
  }
});
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());
if (api?.onEvent) api.onEvent(onBackendEvent);
render();
refreshConnection();
