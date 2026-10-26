import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appSourceRoot,
  parseOptions,
  prepareTool,
  requireBuildHost,
} from "./toolchain.mjs";

async function main() {
  const options = parseOptions(process.argv.slice(2), [
    "--electron-zip",
    "--help",
  ]);
  if (options["--help"]) {
    console.log(
      "Usage: node apps/desktop/launch.mjs [--electron-zip ABSOLUTE_ZIP]\nRequires Node v24.18.0 Windows x64. Downloads the pinned official Electron ZIP when no archive is supplied.",
    );
    return;
  }
  requireBuildHost();
  const electron = await prepareTool("electron", options["--electron-zip"]);
  const env = { ...process.env, REA_DESKTOP_NODE_EXECUTABLE: process.execPath };
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"])
    delete env[key];
  console.log(
    "Starting REA Desktop with pinned Node " +
      process.version +
      " and Electron " +
      electron.receipt.version,
  );
  const child = spawn(electron.executable, [appSourceRoot], {
    cwd: appSourceRoot,
    env,
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(
    result.code,
    0,
    "Desktop exited unsuccessfully: " + String(result.code ?? result.signal),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
