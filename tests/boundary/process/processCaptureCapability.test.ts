import { describe, expect, it } from "vitest";

import {
  processCaptureProbeFailureReason,
  processCaptureOwnershipUnavailableReason,
  probeProcessCaptureCapability,
  windowsProcessScenarioUnavailableReason,
} from "../../../src/process/capture/ProcessCaptureCapability.js";
import { processScenarioSchema } from "../../../src/domain/process/processScenario.js";

const missingNative = () => ({
  available: false as const,
  failureStage: "artifact" as const,
  reason: "verified artifact missing",
});

describe("process capture capability diagnostics", () => {
  it("distinguishes missing native modules from runtime ABI mismatches", () => {
    expect(
      processCaptureProbeFailureReason(
        Object.assign(
          new Error("Cannot find package '@lydell/node-pty-win32-x64'"),
          {
            code: "ERR_MODULE_NOT_FOUND",
          },
        ),
      ),
    ).toContain("optional dependencies enabled");
    expect(
      processCaptureProbeFailureReason(
        Object.assign(
          new Error("compiled against a different Node.js version"),
          {
            code: "ERR_DLOPEN_FAILED",
          },
        ),
      ),
    ).toContain("incompatible with this Node.js runtime");
  });

  it("returns the actual cause from the real probe boundary", async () => {
    const capability = await probeProcessCaptureCapability({
      platform: "darwin",
      loadPty: async () => {
        throw Object.assign(new Error("optional binary was not installed"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    });
    expect(capability).toEqual({
      available: false,
      backend: "node-pty",
      reason: expect.stringContaining("optional binary was not installed"),
    });
  });

  it("preserves the actual diagnostic for a genuine probe failure", () => {
    expect(
      processCaptureProbeFailureReason(new Error("spawn EACCES")),
    ).toContain("spawn EACCES");
  });

  it("prepares Darwin ownership inspection before probing or admitting a PTY", async () => {
    let loaded = false;
    const capability = await probeProcessCaptureCapability({
      platform: "darwin",
      prepareOwnershipInspector: async () => {
        throw new Error(
          "macOS process ownership inspection requires the Apple Swift compiler via xcrun",
        );
      },
      loadPty: async () => {
        loaded = true;
        return await import("@lydell/node-pty");
      },
    });

    expect(loaded).toBe(false);
    expect(capability).toEqual({
      available: false,
      backend: "node-pty",
      reason: expect.stringContaining(
        "requires the Apple Swift compiler via xcrun",
      ),
    });
  });

  it("keeps the ownership limitation separate from native PTY support", () => {
    expect(
      processCaptureOwnershipUnavailableReason("win32", missingNative),
    ).toContain("verified artifact missing");
  });

  it("explains Windows capture admission before loading or spawning a PTY", async () => {
    let loaded = false;
    const capability = await probeProcessCaptureCapability({
      platform: "win32",
      loadWindowsAuthority: missingNative,
      loadPty: async () => {
        loaded = true;
        throw new Error("Windows admission must precede PTY loading");
      },
    });
    expect(loaded).toBe(false);
    expect(capability).toMatchObject({
      available: false,
      backend: "windows-conpty",
      reason: expect.stringContaining("verified artifact missing"),
    });
    if (capability.available)
      throw new Error("expected Windows capture refusal");
    expect(capability.reason).toContain("Windows owned ConPTY capture");
  });
  it("rejects unsupported Windows controls before target launch", () => {
    expect(
      windowsProcessScenarioUnavailableReason(
        processScenarioSchema.parse({
          executable: "self.exe",
          events: [{ type: "signal", at_ms: 1, signal: "SIGTERM" }],
        }),
      ),
    ).toContain("POSIX signals");
    expect(
      windowsProcessScenarioUnavailableReason(
        processScenarioSchema.parse({
          executable: "self.exe",
          terminal: { columns: 32768, rows: 1, scrollback: 0 },
        }),
      ),
    ).toContain("COORD");
    expect(
      windowsProcessScenarioUnavailableReason(
        processScenarioSchema.parse({
          executable: "self.exe",
          events: [
            { type: "input", at_ms: 1, data: "a".repeat(1024 * 1024 + 1) },
          ],
        }),
      ),
    ).toContain("1 MiB");
    expect(
      windowsProcessScenarioUnavailableReason(
        processScenarioSchema.parse({
          executable: "self.exe",
          events: [{ type: "signal", at_ms: 1, signal: "SIGKILL" }],
        }),
      ),
    ).toBeUndefined();
  });
});
