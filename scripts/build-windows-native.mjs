#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nodeVersion = "22.19.0";
const windowsHost = process.platform === "win32";
const compiler = windowsHost ? "cl.exe" : "x86_64-w64-mingw32-g++";
const cache = join(homedir(), ".cache", "rea-windows-native");
const inspectionFixture = process.argv[2] === "--inspection-fixture";
if (process.argv.length > 3 || (process.argv.length > 2 && !inspectionFixture))
  throw new Error("Unknown Windows native build argument");
const output = inspectionFixture
  ? join(root, ".cache", "windows-native-inspection-fixture")
  : join(root, "native", "windows", "build");
const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1_024 * 1_024,
    timeout: 120_000,
  });
  if (result.error !== undefined)
    throw new Error(
      `Windows native build lane requires ${command}: ${result.error.message}`,
    );
  if (result.status !== 0)
    throw new Error(
      `Windows native build failed: ${result.stdout}${result.stderr}`,
    );
  return result.stdout;
};
if (process.platform !== "linux" && !windowsHost)
  throw new Error(
    "The Windows x64 artifact build lane requires Windows with an x64 MSVC developer environment, or Linux with MinGW-w64.",
  );
if (windowsHost && process.arch !== "x64")
  throw new Error("The native Windows build lane requires an x64 host");
run(compiler, windowsHost ? ["/?"] : ["--version"]);
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const fetchBytes = async (name) => {
  const response = await fetch(
    `https://nodejs.org/dist/v${nodeVersion}/${name}`,
    {
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Node build prerequisite download failed: ${name}: HTTP ${response.status}`,
    );
  return Buffer.from(await response.arrayBuffer());
};
const checksums = (await fetchBytes("SHASUMS256.txt")).toString("utf8");
const verifiedDownload = async (name, path) => {
  if (!(await exists(path))) await writeFile(path, await fetchBytes(name));
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  const expected = checksums
    .split("\n")
    .find((line) => line.slice(66) === name)
    ?.slice(0, 64);
  if (expected === undefined || digest !== expected)
    throw new Error(`Node build prerequisite SHA-256 mismatch: ${name}`);
};
const cachedHeaders = join(
  homedir(),
  ".cache",
  "node-gyp",
  nodeVersion,
  "include",
  "node",
);
let headers = cachedHeaders;
if (!(await exists(join(headers, "node_api.h")))) {
  const archive = join(cache, `node-v${nodeVersion}-headers.tar.gz`);
  await verifiedDownload(`node-v${nodeVersion}-headers.tar.gz`, archive);
  run("tar", ["xzf", archive, "-C", cache]);
  headers = join(cache, `node-v${nodeVersion}`, "include", "node");
}
const artifact = "rea-windows-x64.node";
// MSVC short-import libraries do not produce a correct Node import table with
// GNU ld. Generate a GNU delay-import library for the exact stable Node-API
// symbols; addon.cc binds it to the host executable, whatever its file name.
const sources = [
  "addon.cc",
  "filesystem.cc",
  "process.cc",
  "appcontainer.cc",
  "debugger.cc",
];
const sourceText = (
  await Promise.all(
    sources.map((path) =>
      readFile(join(root, "native", "windows", "src", path), "utf8"),
    ),
  )
).join("\n");
const symbols = [
  ...new Set(
    [...sourceText.matchAll(/\b(napi_[a-z0-9_]+)\s*\(/gu)].map(
      (match) => match[1],
    ),
  ),
].sort();
const definition = join(output, "node-api.def");
const library = join(cache, "libnode-api.a");
await writeFile(
  definition,
  `LIBRARY node.exe\nEXPORTS\n${symbols.join("\n")}\n`,
);
if (windowsHost) {
  // Use the caller's existing x64 Developer Command Prompt environment. No
  // compiler, SDK or global tool is installed or upgraded by this build lane.
  const importLibrary = join(output, "node-api.lib");
  run("lib.exe", [
    "/nologo",
    "/machine:x64",
    `/def:${definition}`,
    `/out:${importLibrary}`,
  ]);
  const compileSources = [
    "native/windows/src/addon.cc",
    inspectionFixture
      ? "tests/fixtures/windows-native-inspection-failure.cc"
      : "native/windows/src/filesystem.cc",
    "native/windows/src/process.cc",
    "native/windows/src/appcontainer.cc",
    "native/windows/src/debugger.cc",
  ];
  const objects = [];
  for (const [index, source] of compileSources.entries()) {
    const object = join(output, `source-${index}.obj`);
    run(compiler, [
      "/nologo",
      "/std:c++17",
      "/O2",
      "/EHsc",
      "/MT",
      "/GS",
      "/guard:cf",
      "/DNAPI_VERSION=8",
      "/D_WIN32_WINNT=0x0A00",
      "/D_CRT_SECURE_NO_WARNINGS",
      `/I${headers}`,
      "/c",
      source,
      `/Fo${object}`,
    ]);
    objects.push(object);
  }
  run("link.exe", [
    "/nologo",
    "/DLL",
    "/MACHINE:X64",
    "/INCREMENTAL:NO",
    "/BREPRO",
    "/DYNAMICBASE",
    "/NXCOMPAT",
    "/guard:cf",
    "/DELAYLOAD:node.exe",
    `/OUT:${join(output, artifact)}`,
    ...objects,
    importLibrary,
    "delayimp.lib",
    "kernel32.lib",
    "advapi32.lib",
    "bcrypt.lib",
    "ntdll.lib",
    "userenv.lib",
    "ole32.lib",
    "shell32.lib",
  ]);
} else {
  run("x86_64-w64-mingw32-dlltool", ["-d", definition, "-y", library]);
  run(compiler, [
    "-std=c++17",
    "-O2",
    "-DNAPI_VERSION=8",
    "-D_WIN32_WINNT=0x0A00",
    "-shared",
    "-static",
    "-static-libgcc",
    "-static-libstdc++",
    "-Wl,--no-insert-timestamp",
    `-I${headers}`,
    "native/windows/src/addon.cc",
    inspectionFixture
      ? "tests/fixtures/windows-native-inspection-failure.cc"
      : "native/windows/src/filesystem.cc",
    "native/windows/src/process.cc",
    "native/windows/src/appcontainer.cc",
    "native/windows/src/debugger.cc",
    library,
    "-ladvapi32",
    "-lbcrypt",
    "-lntdll",
    "-luserenv",
    "-lole32",
    "-lshell32",
    "-o",
    join(output, artifact),
  ]);
}
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const bytes = await readFile(join(output, artifact));
const metadata = {
  packageVersion: packageJson.version,
  platform: "win32",
  architecture: "x64",
  abiVersion: 1,
  nodeApiVersion: 8,
  artifact,
  artifactSha256: createHash("sha256").update(bytes).digest("hex"),
};
await writeFile(
  join(output, "manifest.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({ ...metadata, artifactBytes: bytes.length })}\n`,
);
