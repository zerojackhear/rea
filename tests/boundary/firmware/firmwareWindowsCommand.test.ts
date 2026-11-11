import { rm } from "node:fs/promises";
import { describe, expect, it, onTestFinished } from "vitest";
import { runFirmwareCommand } from "../../../src/firmware/FirmwareCommand.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe.skipIf(process.platform !== "win32")(
  "Windows firmware command lifetime",
  () => {
    const fixture = async () => {
      const cwd = await createTestTempDirectory("rea-firmware-windows-");
      onTestFinished(() => rm(cwd, { recursive: true, force: true }));
      return {
        engine: "binwalk",
        operation: "inspect_firmware_regions",
        command: process.execPath,
        limiter: null,
        cwd,
        environment: process.env,
        signal: new AbortController().signal,
        retainCleanup: () => {
          throw new Error("Owned fixture cleanup remained incomplete");
        },
      };
    };

    it("keeps native temporary output in the owned directory and reports the actual limiter", async () => {
      const context = await fixture();
      const result = await runFirmwareCommand({
        ...context,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({temp:process.env.TEMP,tmp:process.env.TMP}))",
        ],
      });
      expect(JSON.parse(result.stdout.text)).toEqual({
        temp: context.cwd,
        tmp: context.cwd,
      });
      expect(result.resource_limiter).toEqual({
        kind: "windows-job-object",
        scope: "owned-process-tree",
        memory_limit_bytes: 1024 ** 3,
      });
    });

    it("preserves a real failed command's status and diagnostics", async () => {
      const context = await fixture();
      await expect(
        runFirmwareCommand({
          ...context,
          args: [
            "-e",
            "process.stderr.write('invalid selected input');process.exitCode=7",
          ],
        }),
      ).rejects.toMatchObject({
        _tag: "ProviderAdapterError",
        diagnostics: { exit_code: 7, stderr: "invalid selected input" },
      });
    });

    it("cancels an acquired process tree and allows the following command to finish", async () => {
      const context = await fixture();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          runFirmwareCommand({
            ...context,
            signal: controller.signal,
            args: ["-e", "setInterval(()=>{},1000)"],
            launcher: async (options) => {
              const launched = await spawnOwnedProviderProcess(options);
              timer = setTimeout(() => controller.abort(), 200);
              return launched;
            },
          }),
        ).rejects.toMatchObject({ _tag: "AnalysisCancelledError" });
      } finally {
        clearTimeout(timer);
      }
      const next = await runFirmwareCommand({
        ...context,
        args: ["-e", "process.stdout.write('recovered')"],
      });
      expect(next.stdout.text).toBe("recovered");
    });
  },
);
