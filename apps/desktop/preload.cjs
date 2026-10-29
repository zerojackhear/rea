// oxlint-disable-next-line typescript/no-var-requires -- Electron sandboxed preload requires its built-in CommonJS bridge.
const { contextBridge, ipcRenderer, webUtils } = require("electron");
const request = (method, payload) =>
  ipcRenderer.invoke("rea:engine", { method, payload });
contextBridge.exposeInMainWorld(
  "rea",
  Object.freeze({
    getExample: () => ipcRenderer.invoke("rea:example"),
    getState: () => request("state"),
    listTools: () => request("tools"),
    submit: (input) => request("submit", input),
    cancelTask: (id) => request("cancel", { id }),
    listHistory: () => request("history"),
    getResult: (id) => request("result", { id }),
    pickPath: (options) => ipcRenderer.invoke("rea:pick-path", options),
    exportResult: (id) => ipcRenderer.invoke("rea:export-result", id),
    copyText: (text) => ipcRenderer.invoke("rea:copy-text", text),
    windowControl: (action) => ipcRenderer.invoke("rea:window", action),
    getDroppedPath: (file) => webUtils.getPathForFile(file),
    onEvent: (callback) => {
      const handler = (_event, value) => callback(value);
      ipcRenderer.on("rea:event", handler);
      return () => ipcRenderer.removeListener("rea:event", handler);
    },
  }),
);
