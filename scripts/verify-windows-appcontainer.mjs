import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, access, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const R = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "win32")
  throw new Error("Requires a real Windows x64 host");
const P = join(R, ".cache/windows-firmware-verification");
await mkdir(P, { recursive: true });
const out = join(P, "boundary-appcontainer-" + randomUUID().slice(0, 8));
await mkdir(out);
const load = (path) => import(pathToFileURL(join(R, "dist", path)));
const { PrivateRuntimeRoot } = await load("process/PrivateRuntimeRoot.js");
const { prepareWindowsFirmwareRuntime } = await load(
  "firmware/WindowsFirmwareRuntime.js",
);
const { runFirmwareCommand } = await load("firmware/FirmwareCommand.js");
const { WindowsOwnedProcess } = await load("windows/WindowsOwnedProcess.js");
const { windowsPrivateRuntime } = await load(
  "windows/WindowsPrivateRuntime.js",
);
const { spawnOwnedProviderProcess } = await load("process/ProviderProcess.js");
const command = process.env.REA_UNBLOB_COMMAND;
if (!command)
  throw new Error(
    "Set REA_UNBLOB_COMMAND to the inventoried Windows runtime python.exe",
  );
const sha = createHash("sha256")
  .update(await readFile(command))
  .digest("hex");
const input = join(out, "input.txt"),
  outside = join(out, "outside.txt");
await writeFile(input, "REA own input");
await writeFile(outside, "REA own outside");
const root = await PrivateRuntimeRoot.create({
  prefix: "rea-appcontainer-check-",
});
const receipt = {
  root: root.path,
  checks: [],
  started: new Date().toISOString(),
};
let live;
const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );
try {
  const sandbox = await prepareWindowsFirmwareRuntime(
    root.path,
    command,
    sha,
    input,
    AbortSignal.timeout(120000),
  );
  receipt.profile = sandbox.evidence.isolation.profilePath;
  const context = {
    engine: "unblob",
    operation: "extract_firmware",
    command: sandbox.command,
    limiter: null,
    cwd: sandbox.outputPath,
    environment: { ...process.env, REA_PRIVATE_SENTINEL: "must-not-inherit" },
    signal: AbortSignal.timeout(30000),
    appContainerRuntime: sandbox.handle,
    retainCleanup: () => {
      throw new Error("Unexpected incomplete process cleanup");
    },
  };
  const probe = `import os,sys,json,subprocess,shutil
from pathlib import Path
root=Path(sys.argv[1]);outside=Path(sys.argv[2]);profile=Path(sys.argv[3]);results={}
def denied(name,fn):
 try: fn();results[name]={'denied':False}
 except OSError as e: results[name]={'denied':getattr(e,'winerror',0) in (5,32,367) or e.errno in (1,13),'winerror':getattr(e,'winerror',0),'errno':e.errno,'error':str(e)}
results['input_read']=(root/'input/firmware.bin').read_text()=='REA own input'
(root/'output/allowed.txt').write_text('allowed');results['output_write']=True
denied('input_write',lambda:(root/'input/firmware.bin').write_text('wrong'))
denied('engine_write',lambda:(root/'engine/new.txt').write_text('wrong'))
denied('outside_read',lambda:outside.read_text())
denied('outside_write',lambda:outside.write_text('wrong'))
denied('traversal',lambda:(root/'output/../../escape.txt').write_text('wrong'))
denied('profile_write',lambda:(profile/'unexpected.txt').write_text('wrong'))
denied('child_process',lambda:subprocess.run([sys.executable,'-I','-c','pass'],check=True))
shutil.copyfile(sys.executable,root/'output/copied.exe')
denied('copied_execution',lambda:subprocess.run([str(root/'output/copied.exe'),'-I','-c','pass'],check=True))
results['ambient_absent']='REA_PRIVATE_SENTINEL' not in os.environ
print(json.dumps(results))`;
  const result = await runFirmwareCommand({
    ...context,
    args: ["-I", "-B", "-c", probe, root.path, outside, receipt.profile],
  });
  const checked = JSON.parse(result.stdout.text);
  receipt.probe = checked;
  assert.equal(
    await readFile(join(root.path, "input/firmware.bin"), "utf8"),
    "REA own input",
  );
  assert(
    checked.input_read && checked.output_write && checked.ambient_absent,
    JSON.stringify(checked),
  );
  for (const [name, value] of Object.entries(checked))
    if (typeof value === "object")
      assert(value.denied, name + ": " + JSON.stringify(value));
  receipt.checks.push({
    name: "real_filesystem_environment_child_policy",
    results: checked,
  });
  await assert.rejects(
    rename(join(root.path, "engine"), join(root.path, "renamed-engine")),
  );
  receipt.checks.push({
    name: "sealed_engine_directory_rename_refused",
    passed: true,
  });
  const controller = new AbortController();
  await assert.rejects(
    runFirmwareCommand({
      ...context,
      signal: controller.signal,
      args: ["-I", "-B", "-c", "import time;time.sleep(30)"],
      launcher: async (options) => {
        const child = await spawnOwnedProviderProcess(options);
        setTimeout(() => controller.abort(), 250);
        return child;
      },
    }),
    (e) => e._tag === "AnalysisCancelledError",
  );
  receipt.checks.push({ name: "cancelled_job_settled", passed: true });
  const recovered = await runFirmwareCommand({
    ...context,
    args: ["-I", "-B", "-c", 'print("recovered")'],
  });
  assert.equal(recovered.stdout.text.trim(), "recovered");
  receipt.checks.push({ name: "following_launch_recovered", passed: true });
  live = new WindowsOwnedProcess(
    sandbox.command,
    ["-I", "-B", "-c", "import time;time.sleep(30)"],
    sandbox.outputPath,
    {},
    false,
    { memoryLimitBytes: 64 * 1024 ** 2, appContainerRuntime: sandbox.handle },
  );
  live.on("error", () => {});
  live.stdout.resume();
  live.stderr.resume();
  await assert.rejects(
    root.close(),
    (e) => e.win32Code === 170 || String(e.message).includes("still active"),
  );
  assert(await exists(root.path));
  assert(await exists(receipt.profile));
  receipt.checks.push({
    name: "active_job_prevents_workspace_profile_removal",
    passed: true,
  });
  const settled = await live.cleanup();
  assert.equal(settled.cleaned, true);
  live = undefined;
  await root.close();
  assert(!(await exists(root.path)));
  assert(!(await exists(receipt.profile)));
  assert.equal(await readFile(outside, "utf8"), "REA own outside");
  receipt.checks.push({
    name: "retry_removed_owned_profile_and_workspace",
    passed: true,
  });
  receipt.status = "passed";
} catch (e) {
  receipt.status = "failed";
  receipt.error = e.stack;
  console.error(e);
  process.exitCode = 1;
} finally {
  if (live) await live.cleanup().catch(() => {});
  try {
    await root.close();
    receipt.cleaned = true;
  } catch (e) {
    receipt.cleanupError = e.message;
  }
  await writeFile(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({
      status: receipt.status,
      checks: receipt.checks,
      error: receipt.error,
      cleaned: receipt.cleaned,
      evidence: out,
    }),
  );
}
