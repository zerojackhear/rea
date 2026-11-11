import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { expect, it, onTestFinished } from "vitest";
import { PwntoolsLayoutProvider } from "../../../src/native/pwntools/PwntoolsLayoutProvider.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.runIf(process.platform === "win32" && process.arch === "x64")(
  "cancels the actual Windows decoder and retains one owner for its limit and private request",
  async () => {
    const root = await createTestTempDirectory("rea-pwntools-windows-");
    const path = join(root, "selected.bin");
    const bytes = Buffer.from("source-owned cancellation fixture");
    await writeFile(path, bytes);
    const controller = new AbortController();
    let workspace = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const provider = new PwntoolsLayoutProvider(
      {
        REA_PWNTOOLS_PYTHON: process.execPath,
        SystemRoot: process.env.SystemRoot,
      },
      async (spawn) => {
        workspace = spawn.cwd ?? "";
        const request = z
          .strictObject({
            snapshot_path: z.string(),
            reply_path: z.string(),
            windows_job_memory_bytes: z.number().int().positive(),
          })
          .parse(
            JSON.parse(await readFile(spawn.arguments.at(-1) ?? "", "utf8")),
          );
        expect(request.windows_job_memory_bytes).toBe(3 * 1024 ** 3);
        expect(spawn.memoryLimitBytes).toBe(request.windows_job_memory_bytes);
        expect(await readFile(request.snapshot_path)).toEqual(bytes);
        const child = await spawnOwnedProviderProcess({
          ...spawn,
          command: process.execPath,
          arguments: ["-e", "setInterval(()=>{},1000)"],
        });
        timer = setTimeout(() => controller.abort(), 200);
        return child;
      },
    );
    onTestFinished(async () => {
      clearTimeout(timer);
      await provider.close();
    });
    const result = await provider.inspect(
      { path },
      { signal: controller.signal },
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(workspace).not.toBe("");
    await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path)).toEqual(bytes);
  },
);
