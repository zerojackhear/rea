import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyTool,
  choosePreferred,
  toolsForModule,
  fileEntry,
} from "./renderer/modules.mjs";
import { ToolDraftStore } from "./renderer/drafts.mjs";
import { describeTarget } from "./target.mjs";
import { providerEnvironment } from "./provider-environment.mjs";
import { toolDiagnostic } from "./renderer/diagnostics.mjs";

test("native selection never falls through to the DOS-only session operation", () => {
  const tools = [
    { name: "inspect_native_load_image" },
    { name: "inspect_binary_layout" },
    { name: "open_binary" },
  ];
  assert.equal(choosePreferred(tools, "native").name, "open_binary");
  assert.equal(
    choosePreferred([...tools].reverse(), "native").name,
    "open_binary",
  );
  assert.equal(choosePreferred([tools[0]], "native"), null);
});

test("Electron shares the named application analyzer instead of inspecting ASAR as an executable", () => {
  const tools = [
    { name: "inspect_electron_fuses" },
    { name: "analyze_javascript_application" },
  ];
  const entries = toolsForModule(tools, "electron");
  assert.equal(
    choosePreferred(entries, "electron").name,
    "analyze_javascript_application",
  );
  assert.deepEqual(fileEntry("C:\\应用\\resources\\app.asar"), {
    tool: "analyze_javascript_application",
    module: "electron",
  });
});

test("file entries use matching contracts and extensionless executables stay native", () => {
  for (const [path, name] of [
    ["app.exe", "open_binary"],
    ["no-extension", "open_binary"],
    ["app.apk", "inspect_android_package"],
    ["app.wasm", "inspect_wasm_artifact"],
    ["app.pcap", "inspect_pcap_capture"],
    ["app.har", "inspect_web_network_capture"],
    ["app.sqlite", "inspect_sqlite_database"],
    ["app.zip", "open_binary"],
    ["index.js", "open_binary"],
    ["index.js.map", "open_binary"],
  ])
    assert.equal(fileEntry(path).tool, name);
  assert.equal(
    choosePreferred([{ name: "inspect_managed_artifact" }], "dotnet").name,
    "inspect_managed_artifact",
  );
});

test("HAR and qlog source paths reach capture_path without selecting an output directory", () => {
  const tool = {
    name: "inspect_web_network_capture",
    inputSchema: {
      type: "object",
      properties: {
        output_directory: { type: "string" },
        capture_path: { type: "string" },
        format: { type: "string" },
      },
    },
  };
  const drafts = new ToolDraftStore();
  assert.equal(drafts.applyPath(tool, "C:\\中文 目录\\sample.har").ok, true);
  assert.deepEqual(drafts.readArguments(tool).arguments, {
    capture_path: "C:\\中文 目录\\sample.har",
  });
});

test("target kind comes from filesystem facts, including dotted directories and extensionless files", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-target-"));
  try {
    const directory = join(root, "software.v1");
    const file = join(root, "program");
    await mkdir(directory);
    await writeFile(file, "fixture");
    assert.deepEqual(await describeTarget(directory), {
      path: directory,
      kind: "directory",
    });
    assert.deepEqual(await describeTarget(file), { path: file, kind: "file" });
    await assert.rejects(describeTarget("relative.exe"));
    await assert.rejects(describeTarget(join(root, "missing")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider configuration preserves inherited environment and admits only explicit absolute provider paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-provider-"));
  const env = { PATH: "unchanged", JAVA_HOME: "inherited", OTHER: "retained" };
  try {
    assert.deepEqual(await providerEnvironment(root, env), env);
    await writeFile(
      join(root, "providers.json"),
      JSON.stringify({
        GHIDRA_INSTALL_DIR: root,
        JAVA_HOME: root,
        REA_TSHARK_COMMAND: join(root, "tshark.exe"),
        REA_SIGROK_COMMAND: join(root, "sigrok-cli.exe"),
        REA_WAKARU_COMMAND: join(root, "wakaru.exe"),
        REA_UNBLOB_COMMAND: join(root, "python.exe"),
        REA_GDB_COMMAND: join(root, "gdb.exe"),
        REA_RIZIN_COMMAND: join(root, "rizin.exe"),
        REA_OBJDUMP_COMMAND: join(root, "objdump.exe"),
        REA_KUNA_CACHE_DIR: join(root, "kuna-cache"),
      }),
    );
    assert.deepEqual(await providerEnvironment(root, env), {
      ...env,
      GHIDRA_INSTALL_DIR: root,
      JAVA_HOME: root,
      REA_TSHARK_COMMAND: join(root, "tshark.exe"),
      REA_SIGROK_COMMAND: join(root, "sigrok-cli.exe"),
      REA_WAKARU_COMMAND: join(root, "wakaru.exe"),
      REA_UNBLOB_COMMAND: join(root, "python.exe"),
      REA_GDB_COMMAND: join(root, "gdb.exe"),
      REA_RIZIN_COMMAND: join(root, "rizin.exe"),
      REA_OBJDUMP_COMMAND: join(root, "objdump.exe"),
      REA_KUNA_CACHE_DIR: join(root, "kuna-cache"),
    });
    assert.equal(env.JAVA_HOME, "inherited");
    for (const value of [
      { NODE_OPTIONS: "--require unsafe" },
      { JAVA_HOME: "relative" },
      [],
      null,
    ]) {
      await writeFile(join(root, "providers.json"), JSON.stringify(value));
      await assert.rejects(providerEnvironment(root, env));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("specific MCP failure and provider rejection reasons remain visible without changing the result", () => {
  const result = {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: "provider_unavailable",
            message: "Provider unavailable",
            details: {
              rejections: [{ provider_id: "ghidra", reason: "Not configured" }],
            },
          },
        }),
      },
    ],
  };
  const before = JSON.stringify(result);
  assert.deepEqual(toolDiagnostic(result), {
    code: "provider_unavailable",
    message: "Provider unavailable",
    action: "",
    reasons: ["ghidra: Not configured"],
  });
  assert.equal(JSON.stringify(result), before);
  assert.equal(
    toolDiagnostic({
      isError: false,
      structuredContent: { error: { message: "target data" } },
    }),
    null,
  );
  assert.equal(
    toolDiagnostic({
      isError: true,
      content: [{ type: "text", text: "plain non-JSON diagnostic" }],
    }),
    null,
  );
});

test("native packet and signal tools remain in the network module", () => {
  const names = [
    "inspect_packet_capture",
    "inspect_packet_fields",
    "decode_signal_recording",
    "inspect_signal_decoders",
  ];
  const tools = names.map((name) => ({ name }));
  for (const tool of tools) assert.equal(classifyTool(tool), "network");
  assert.deepEqual(toolsForModule(tools, "network"), tools);
  assert.deepEqual(toolsForModule(tools, "native"), []);
});
