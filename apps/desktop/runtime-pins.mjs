/** Own the runtime versions and complete official Windows x64 archive pins. */
export const DESKTOP_NODE_VERSION = "24.22.1";
export const DESKTOP_ELECTRON_VERSION = "44.9.1";

export const PINNED_TOOLS = Object.freeze({
  electron: Object.freeze({
    version: DESKTOP_ELECTRON_VERSION,
    filename: "electron-v" + DESKTOP_ELECTRON_VERSION + "-win32-x64.zip",
    url:
      "https://github.com/electron/electron/releases/download/v" +
      DESKTOP_ELECTRON_VERSION +
      "/electron-v" +
      DESKTOP_ELECTRON_VERSION +
      "-win32-x64.zip",
    bytes: 158389896,
    sha256: "41bd7900bd42d0f49110a81617876137041fbbf473466920248ddb076349ef91",
    executable: "electron.exe",
    executableSha256:
      "1432afee01d6a788f11cb6649efd271923e1e490beef688c24d31f47965013aa",
  }),
  node: Object.freeze({
    version: DESKTOP_NODE_VERSION,
    filename: "node-v" + DESKTOP_NODE_VERSION + "-win-x64.zip",
    url:
      "https://nodejs.org/dist/v" +
      DESKTOP_NODE_VERSION +
      "/node-v" +
      DESKTOP_NODE_VERSION +
      "-win-x64.zip",
    bytes: 37748064,
    sha256: "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5",
    directory: "node-v" + DESKTOP_NODE_VERSION + "-win-x64",
    executable: "node.exe",
    executableSha256:
      "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5",
  }),
});
