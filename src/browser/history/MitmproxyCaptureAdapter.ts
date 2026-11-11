import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import type { HistoricalCaptureFormatAdapter } from "./HistoricalCaptureFormatAdapter.js";
import {
  MITMPROXY_CAPTURE_MEMORY_BYTES,
  MITMPROXY_CAPTURE_PROVIDER_IDENTITY,
} from "./CaptureRelease.js";
const OPERATION = "inspect_web_network_capture";
const MITMDUMP_REQUIREMENT =
  "Native capture decoding requires Windows or Linux and an absolute REA_MITMDUMP_COMMAND path to caller-supplied mitmdump 12.2.3; HAR needs no external engine.";

/** Native mitmproxy decoding is offline and uses only an explicitly configured native tool. */
export class MitmproxyCaptureAdapter implements HistoricalCaptureFormatAdapter {
  readonly format = "mitmproxy";
  readonly identity = MITMPROXY_CAPTURE_PROVIDER_IDENTITY;
  readonly limitations = [
    process.platform === "win32"
      ? "Native mitmproxy runs in an owned Windows Job Object capped at 768 MiB committed memory for the complete process tree. This is not a filesystem or network sandbox; no Linux address-space, CPU-time or per-file limit is claimed."
      : "Native mitmproxy uses Linux limits of 768 MiB address space, 30 CPU seconds and 96 MiB per output file.",
  ];
  constructor(readonly environment: Readonly<NodeJS.ProcessEnv>) {}
  async command(
    requestPath: string,
    runtimePath: string,
  ): ReturnType<HistoricalCaptureFormatAdapter["command"]> {
    const command = this.environment.REA_MITMDUMP_COMMAND;
    if (
      (process.platform !== "linux" && process.platform !== "win32") ||
      command === undefined ||
      !isAbsolute(command)
    )
      throw new AnalysisCapabilityUnavailableError(
        "mitmproxy",
        OPERATION,
        MITMDUMP_REQUIREMENT,
        { userMessage: MITMDUMP_REQUIREMENT },
      );
    try {
      await access(command, constants.R_OK | constants.X_OK);
      if (!(await stat(command)).isFile())
        throw new TypeError("Configured path is not a regular file");
    } catch (cause: unknown) {
      const reason = `Configured mitmdump executable is unavailable: ${command}.`;
      throw new AnalysisCapabilityUnavailableError(
        "mitmproxy",
        OPERATION,
        reason,
        { cause, userMessage: reason },
      );
    }
    return {
      ...(process.platform === "win32"
        ? { memoryLimitBytes: MITMPROXY_CAPTURE_MEMORY_BYTES }
        : {}),
      command,
      arguments: [
        "--no-server",
        "-q",
        "--set",
        `confdir=${runtimePath}`,
        "--set",
        `rea_request_path=${requestPath}`,
        "-s",
        fileURLToPath(
          new URL("../../../bridge/mitmproxy/capture.py", import.meta.url),
        ),
      ],
    };
  }
}
