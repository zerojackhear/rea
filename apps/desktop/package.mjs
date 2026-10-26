import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  appSourceRoot,
  copyCheckedFile,
  copyTree,
  parseOptions,
  prepareTool,
  repositoryRoot,
  requireBuildHost,
  runCaptured,
  safeRelative,
  sha256,
  writePortableZip,
} from "./toolchain.mjs";

async function main() {
  const options = parseOptions(process.argv.slice(2), [
    "--electron-zip",
    "--node-zip",
    "--npm-cli",
    "--output-root",
    "--no-zip",
    "--help",
  ]);
  if (options["--help"]) {
    console.log(
      "Usage: node apps/desktop/package.mjs [--electron-zip ZIP] [--node-zip ZIP] [--npm-cli npm-cli.js] [--output-root DIRECTORY] [--no-zip]\nRequires Windows x64, Node v24.18.0, npm 11.16.0, and a completed npm run build:cached. Each output receives a unique directory; previous outputs are retained.",
    );
    return;
  }
  requireBuildHost();
  const desktopPackage = JSON.parse(
    await readFile(join(appSourceRoot, "package.json"), "utf8"),
  );
  const corePackage = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.match(
    desktopPackage.version,
    /^[0-9A-Za-z.+-]+$/,
    "Unsafe desktop version.",
  );
  for (const required of [
    "dist/mcp/main.js",
    "dist/cli-runtime/cli.js",
    "skills/reverse-engineer-anything/SKILL.md",
    "native/windows/build/manifest.json",
  ]) {
    assert.ok(
      (await lstat(join(repositoryRoot, ...safeRelative(required)))).isFile(),
      "Run npm run build:cached first: " + required,
    );
  }
  console.log("Checking the core native artifact before packaging.");
  await runCaptured(
    process.execPath,
    ["scripts/verify-windows-native-artifact.mjs"],
    { cwd: repositoryRoot },
  );
  console.log(
    "Admitting complete pinned Electron and Node ZIPs; extracting into new task-owned directories.",
  );
  const electron = await prepareTool("electron", options["--electron-zip"]);
  const node = await prepareTool("node", options["--node-zip"]);
  const npmCli = resolve(
    options["--npm-cli"] ??
      process.env.npm_execpath ??
      join(node.runtime, "node_modules/npm/bin/npm-cli.js"),
  );
  assert.ok(
    (await lstat(npmCli)).isFile(),
    "Pass --npm-cli pointing to an isolated npm 11.16.0 npm-cli.js.",
  );
  const version = await runCaptured(node.executable, [npmCli, "--version"]);
  assert.equal(
    version.stdout.trim(),
    "11.16.0",
    "Packaging requires npm 11.16.0. Pass --npm-cli; do not upgrade global npm.",
  );
  const env = { ...process.env, HUSKY: "0", npm_config_ignore_scripts: "true" };
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"])
    delete env[key];
  console.log(
    "Getting the npm package file manifest without running lifecycle scripts.",
  );
  const packed = await runCaptured(
    node.executable,
    [npmCli, "pack", "--json", "--dry-run", "--ignore-scripts"],
    { cwd: repositoryRoot, env },
  );
  const manifest = JSON.parse(packed.stdout);
  assert.ok(
    Array.isArray(manifest) &&
      manifest.length === 1 &&
      Array.isArray(manifest[0].files),
    "npm pack did not return one file manifest.",
  );
  const corePaths = manifest[0].files.map((item) => item.path);
  const seen = new Set();
  for (const path of corePaths) {
    const parts = safeRelative(path);
    assert.ok(
      !["node_modules", "src", "tests", "apps"].includes(parts[0]),
      "Development files must not enter the core package: " + path,
    );
    const identity = path.toLowerCase();
    assert.ok(!seen.has(identity), "Duplicate npm package path: " + path);
    seen.add(identity);
  }
  assert.ok(
    seen.has("package.json") &&
      seen.has("scripts/rea.mjs") &&
      seen.has("dist/mcp/main.js"),
    "Incomplete core package file manifest.",
  );
  const outputRoot = resolve(
    options["--output-root"] ?? join(repositoryRoot, "dist/desktop"),
  );
  await mkdir(outputRoot, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "")
    .replaceAll(".", "");
  const directory = await mkdtemp(
    join(
      outputRoot,
      "REA-Desktop-" + desktopPackage.version + "-win32-x64-" + stamp + "-",
    ),
  );
  const resources = join(directory, "resources");
  const packagedApp = join(resources, "app"),
    core = join(resources, "core");
  console.log("Assembling portable directory: " + directory);
  const electronFiles = await copyTree(electron.runtime, directory);
  await rename(join(directory, "electron.exe"), join(directory, "REA.exe"));
  const nodeFiles = [];
  for (const name of ["node.exe", "LICENSE"])
    nodeFiles.push({
      path: "runtime/" + name,
      ...(await copyCheckedFile(
        join(node.runtime, name),
        join(resources, "runtime", name),
      )),
    });
  const desktopFiles = [];
  for (const name of [
    "package.json",
    "main.mjs",
    "preload.cjs",
    "bridge.mjs",
    "engine.mjs",
  ]) {
    desktopFiles.push({
      path: name,
      ...(await copyCheckedFile(
        join(appSourceRoot, name),
        join(packagedApp, name),
      )),
    });
  }
  for (const name of ["renderer", "examples"]) {
    const members = await copyTree(
      join(appSourceRoot, name),
      join(packagedApp, name),
    );
    desktopFiles.push(
      ...members.map((member) => ({
        ...member,
        path: name + "/" + member.path,
      })),
    );
  }
  const coreFiles = [];
  for (const path of corePaths)
    coreFiles.push({
      path,
      ...(await copyCheckedFile(
        join(repositoryRoot, ...safeRelative(path)),
        join(core, ...safeRelative(path)),
      )),
    });
  if (!seen.has("package-lock.json"))
    coreFiles.push({
      path: "package-lock.json",
      ...(await copyCheckedFile(
        join(repositoryRoot, "package-lock.json"),
        join(core, "package-lock.json"),
      )),
    });
  console.log(
    "Installing locked production dependencies without lifecycle scripts. Optional platform packages stay enabled for node-pty.",
  );
  const installed = await runCaptured(
    node.executable,
    [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: core, env, timeout: 600000 },
  );
  console.log(installed.stdout.trim());
  console.log(
    "Checking the packaged SDK, node-pty, native module, and real core entry point.",
  );
  const moduleProbe = [
    "import assert from 'node:assert/strict';",
    "import {createRequire} from 'node:module';",
    "import {join} from 'node:path'; import {pathToFileURL} from 'node:url';",
    "const require=createRequire(join(process.cwd(),'package.json'));",
    "const sdk=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);",
    "assert.equal(typeof sdk.Client,'function');",
    "const server=await import(pathToFileURL(require.resolve('@modelcontextprotocol/server')).href);",
    "assert.ok(server);",
    "const pty=require('@lydell/node-pty'); assert.equal(typeof pty.spawn,'function');",
    "require(join(process.cwd(),'node_modules/@lydell/node-pty-win32-x64/conpty.node'));",
    "require(join(process.cwd(),'node_modules/@lydell/node-pty-win32-x64/conpty_console_list.node'));",
    "const native=require(join(process.cwd(),'native/windows/build/rea-windows-x64.node')); assert.ok(native);",
    "console.log(JSON.stringify({sdkClient:true,sdkServer:true,nodePtyModule:true,nodePtyNativeBindings:true,nativeModule:true,targetExecution:false}));",
  ].join("\n");
  const moduleCheck = await runCaptured(
    node.executable,
    ["--input-type=module", "-e", moduleProbe],
    { cwd: core, env },
  );
  const nativeCheck = await runCaptured(
    node.executable,
    ["scripts/verify-windows-native-artifact.mjs"],
    { cwd: core, env },
  );
  const entryCheck = await runCaptured(
    node.executable,
    ["scripts/rea.mjs", "--version"],
    { cwd: core, env },
  );
  assert.equal(
    entryCheck.stdout.trim(),
    corePackage.version,
    "Packaged CLI package version mismatch.",
  );
  for (const file of [...desktopFiles, ...coreFiles])
    assert.equal(
      await sha256(file.source),
      file.sha256,
      "Source changed while packaging: " + file.source,
    );
  const nativeManifest = JSON.parse(
    await readFile(join(core, "native/windows/build/manifest.json"), "utf8"),
  );
  assert.equal(
    nativeManifest.packageVersion,
    corePackage.version,
    "Native artifact is for another REA version.",
  );
  const limitations = [
    "Unsigned REA development build; no REA Authenticode signing or installer registration performed.",
    "Windows x64 portable layout only. The module-load checks do not prove every analysis module or provider works.",
    "Dependency lifecycle scripts are disabled. Optional Frida native bindings are not installed or validated by this package.",
    "External Ghidra, Java, IDA, Android tools, browsers and other providers remain bring-your-own; availability is reported by REA.",
    "CLI version, SDK and node-pty/native module admission are checked; interactive UI and provider workflows require their own acceptance evidence.",
  ];
  const buildInfo = {
    application: desktopPackage.name,
    version: desktopPackage.version,
    coreVersion: corePackage.version,
    createdAt: new Date().toISOString(),
    platform: "win32",
    architecture: "x64",
    nodeVersion: node.receipt.version,
    electronVersion: electron.receipt.version,
    limitations,
  };
  await writeFile(
    join(directory, "BUILD-INFO.json"),
    JSON.stringify(buildInfo, null, 2) + "\n",
    { flag: "wx" },
  );
  await writeFile(
    join(directory, "README.txt"),
    "REA Desktop - Windows x64 development build\r\n\r\nDouble-click REA.exe. Node is bundled; no global Node or npm installation is required.\r\nExternal analysis providers remain bring-your-own. Keep the entire folder together.\r\nSee BUILD-INFO.json and the core LICENSE/THIRD_PARTY_NOTICES.md for scope and notices.\r\n",
    { flag: "wx" },
  );
  let archive = null;
  if (!options["--no-zip"]) {
    console.log(
      "Creating portable ZIP. Previous output directories are retained.",
    );
    archive = await writePortableZip(directory, directory + ".zip");
  }
  const receipt = {
    schemaVersion: 1,
    ...buildInfo,
    directory,
    executable: join(directory, "REA.exe"),
    archive,
    tools: {
      electron: electron.receipt,
      node: node.receipt,
      npm: { version: version.stdout.trim(), cli: npmCli },
    },
    nativeManifest,
    desktopFiles,
    coreFiles,
    nodeFiles,
    electronArchiveMembersCopied: electronFiles.length,
    checks: {
      coreNativeBeforeCopy: true,
      productionDependencyInstall: true,
      moduleLoad: JSON.parse(moduleCheck.stdout),
      nativeArtifact: JSON.parse(nativeCheck.stdout),
      cliVersion: entryCheck.stdout.trim(),
    },
    packageManifest: {
      name: manifest[0].name,
      version: manifest[0].version,
      fileCount: coreFiles.length,
    },
  };
  const receiptPath = directory + ".receipt.json";
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify(
      {
        directory,
        executable: receipt.executable,
        archive,
        receipt: receiptPath,
        limitations,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
