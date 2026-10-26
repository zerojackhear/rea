import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
} from "electron";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EngineBridge } from "./bridge.mjs";

const appRoot = dirname(fileURLToPath(import.meta.url));
const rendererRoot = join(appRoot, "renderer");
const coreRoot = app.isPackaged
  ? join(process.resourcesPath, "core")
  : resolve(appRoot, "../..");
const nodePath = app.isPackaged
  ? join(process.resourcesPath, "runtime", "node.exe")
  : process.env.REA_DESKTOP_NODE_EXECUTABLE;
const startUrl = "rea://app/index.html";
const allowedMethods = new Set([
  "state",
  "tools",
  "submit",
  "cancel",
  "history",
  "result",
]);
let mainWindow;
let engine;
let startupState = { connection: "connecting", toolsCount: 0 };
let canQuit = false;
let closing = false;
protocol.registerSchemesAsPrivileged([
  {
    scheme: "rea",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
app.setName("REA Desktop");
app.setAppUserModelId("tools.rea.desktop");
if (process.env.REA_DESKTOP_USER_DATA_DIR)
  app.setPath("userData", resolve(process.env.REA_DESKTOP_USER_DATA_DIR));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.on("before-quit", (event) => {
    if (canQuit) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void (async () => {
      try {
        const result = engine ? await engine.close() : { closed: true };
        if (!result.closed || result.cleanupUnknown)
          throw new Error(result.message ?? "分析引擎仍保留未清理的资源。");
        canQuit = true;
        app.quit();
      } catch (error) {
        closing = false;
        await dialog.showMessageBox(mainWindow, {
          type: "warning",
          title: "等待分析任务结束",
          message: "当前还不能确认分析资源已关闭",
          detail: error.message + "\n请先取消活动任务，再重试关闭。",
          buttons: ["返回工作台"],
        });
      }
    })();
  });
  void app
    .whenReady()
    .then(async () => {
      protocol.handle("rea", (request) => {
        const url = new URL(request.url);
        if (url.hostname !== "app" || request.method !== "GET")
          return new Response("Forbidden", { status: 403 });
        let target;
        try {
          target = resolve(
            rendererRoot,
            "." + decodeURIComponent(url.pathname),
          );
        } catch {
          return new Response("Bad path", { status: 400 });
        }
        if (!target.startsWith(rendererRoot + sep))
          return new Response("Forbidden", { status: 403 });
        return net.fetch(pathToFileURL(target).href);
      });
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      mainWindow = new BrowserWindow({
        width: 1480,
        height: 960,
        minWidth: 1100,
        minHeight: 760,
        show: false,
        frame: false,
        title: "REA Desktop",
        backgroundColor: "#f5f6f8",
        webPreferences: {
          preload: join(appRoot, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      mainWindow.setMenu(null);
      mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      mainWindow.webContents.on("will-navigate", (event) =>
        event.preventDefault(),
      );
      mainWindow.on("close", (event) => {
        if (!canQuit) {
          event.preventDefault();
          app.quit();
        }
      });
      mainWindow.once("ready-to-show", () => mainWindow.show());
      const assertSender = (event) => {
        if (
          event.sender !== mainWindow.webContents ||
          event.senderFrame !== mainWindow.webContents.mainFrame ||
          event.senderFrame.url !== startUrl
        )
          throw new Error("Unknown application sender");
      };
      ipcMain.handle("rea:engine", async (event, request) => {
        assertSender(event);
        if (!request || !allowedMethods.has(request.method))
          throw new Error("不支持的操作");
        if (!engine) {
          if (request.method === "state") return startupState;
          throw new Error(startupState.error ?? "本地分析引擎正在连接");
        }
        return engine.request(request.method, request.payload);
      });
      ipcMain.handle("rea:example", (event) => {
        assertSender(event);
        const path = join(appRoot, "examples", "hello-app");
        return {
          path,
          tool: "analyze_javascript_application",
          arguments: { input_path: path, detail: "complete" },
        };
      });
      ipcMain.handle("rea:pick-path", async (event, options) => {
        assertSender(event);
        if (!options || !["file", "directory"].includes(options.kind))
          throw new Error("请选择文件或文件夹");
        const selected = await dialog.showOpenDialog(mainWindow, {
          title:
            typeof options.title === "string"
              ? options.title.slice(0, 160)
              : "选择分析目标",
          properties: [
            options.kind === "directory" ? "openDirectory" : "openFile",
          ],
        });
        return selected.canceled ? null : (selected.filePaths[0] ?? null);
      });
      ipcMain.handle("rea:export-result", async (event, id) => {
        assertSender(event);
        if (typeof id !== "string") throw new Error("无效任务");
        const result = await engine.request("result", { id });
        const selection = await dialog.showSaveDialog(mainWindow, {
          title: "导出完整分析记录",
          defaultPath: "rea-" + id + ".json",
          filters: [{ name: "JSON 分析记录", extensions: ["json"] }],
        });
        if (selection.canceled || !selection.filePath) return { saved: false };
        await writeFile(
          selection.filePath,
          JSON.stringify(result, null, 2) + "\n",
          { encoding: "utf8" },
        );
        return { saved: true, path: selection.filePath };
      });
      ipcMain.handle("rea:copy-text", (event, text) => {
        assertSender(event);
        if (
          typeof text !== "string" ||
          Buffer.byteLength(text) > 16 * 1024 * 1024
        )
          throw new Error("复制内容超出限制");
        clipboard.writeText(text);
        return true;
      });
      ipcMain.handle("rea:window", (event, action) => {
        assertSender(event);
        if (action === "minimize") mainWindow.minimize();
        else if (action === "maximize") {
          if (mainWindow.isMaximized()) mainWindow.unmaximize();
          else mainWindow.maximize();
        } else if (action === "close") app.quit();
        else throw new Error("Unknown window action");
      });
      try {
        if (!nodePath)
          throw new Error(
            "未找到随应用配置的 Node 运行时，请使用桌面启动命令或完整便携包。",
          );
        const { stdout } = await promisify(execFile)(nodePath, ["--version"], {
          windowsHide: true,
          timeout: 10_000,
        });
        if (stdout.trim() !== "v24.18.0")
          throw new Error("需要固定 Node v24.18.0，当前为 " + stdout.trim());
        await readFile(join(coreRoot, "dist/mcp/main.js"));
        engine = new EngineBridge({
          node: nodePath,
          engine: join(appRoot, "engine.mjs"),
          coreRoot,
          dataDir: app.getPath("userData"),
        });
        engine.on("event", (message) => {
          if (!mainWindow.isDestroyed())
            mainWindow.webContents.send("rea:event", message);
        });
      } catch (error) {
        startupState = {
          connection: "error",
          toolsCount: 0,
          error: error.message,
        };
      }
      await mainWindow.loadURL(startUrl);
    })
    .catch((error) => {
      dialog.showErrorBox("REA Desktop 启动失败", error.message);
      canQuit = true;
      app.quit();
    });
}
