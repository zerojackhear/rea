import { tmpdir } from "node:os";
import { prepareProcessOwnershipInspection } from "../ProcessOwnershipObservation.js";
import type { ProcessScenario } from "../../domain/process/processScenario.js";
import {
  systemWindowsNativeAuthority,
  type WindowsNativeLoadResult,
} from "../../windows/WindowsNativeLoader.js";
import {
  WindowsPtyProcess,
  WINDOWS_PTY_INPUT_BUDGET,
} from "../../windows/WindowsPtyProcess.js";

export type ProcessCaptureCapability =
  | {
      readonly available: true;
      readonly backend: "node-pty" | "windows-conpty";
    }
  | {
      readonly available: false;
      readonly backend: "node-pty" | "windows-conpty";
      readonly reason: string;
    };

/** Explain why process capture cannot claim owned-process cleanup on a host. */
export const processCaptureOwnershipUnavailableReason = (
  platform: NodeJS.Platform,
  loadWindowsAuthority: () => WindowsNativeLoadResult = systemWindowsNativeAuthority,
): string | undefined => {
  if (platform !== "win32") return undefined;
  const loaded = loadWindowsAuthority();
  if (!loaded.available)
    return `Windows owned ConPTY capture is unavailable: ${loaded.reason}`;
  return loaded.authority.inspection.conpty === true
    ? undefined
    : "Windows capture requires a matching native artifact with ConPTY and atomic Job Object ownership; the installed artifact lacks this capability.";
};

/** Reject unsupported terminal controls before launching the selected target. */
export const windowsProcessScenarioUnavailableReason = (
  scenario: ProcessScenario,
): string | undefined => {
  if (
    scenario.terminal.columns > 32767 ||
    scenario.terminal.rows > 32767 ||
    scenario.events.some(
      (event) =>
        event.type === "resize" &&
        (event.columns > 32767 || event.rows > 32767),
    )
  )
    return "Windows ConPTY dimensions must fit positive signed 16-bit COORD fields (1 through 32767).";
  if (
    scenario.events.some(
      (event) => event.type === "signal" && event.signal !== "SIGKILL",
    )
  )
    return "Windows capture supports only forced SIGKILL requests through the retained root handle; POSIX signals are not delivered.";
  if (
    scenario.events.some(
      (event) =>
        event.type === "input" &&
        Buffer.byteLength(event.data) > WINDOWS_PTY_INPUT_BUDGET,
    )
  )
    return "One Windows terminal input event exceeds the bounded 1 MiB queue budget.";
  return undefined;
};

const pendingWindowsProbes = new Set<WindowsPtyProcess>();

const probeWindowsTerminal = async (): Promise<void> => {
  for (const pending of pendingWindowsProbes) {
    const result = await pending.cleanup();
    if (!result.cleaned) throw new Error(result.reason);
    pendingWindowsProbes.delete(pending);
  }
  const terminal = new WindowsPtyProcess(
    process.execPath,
    ["-e", "process.exit(process.stdin.isTTY && process.stdout.isTTY ? 0 : 1)"],
    {
      cwd: tmpdir(),
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      cols: 80,
      rows: 24,
    },
  );
  pendingWindowsProbes.add(terminal);
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      terminal.onExit(({ exitCode }) =>
        exitCode === 0
          ? resolve()
          : reject(new Error(`ConPTY probe exited with ${String(exitCode)}`)),
      );
      terminal.onFailure(reject);
      timer = setTimeout(
        () => reject(new Error("ConPTY probe timed out")),
        5000,
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    const result = await terminal.cleanup();
    if (result.cleaned) pendingWindowsProbes.delete(terminal);
    else throw new Error(`ConPTY probe cleanup failed: ${result.reason}`);
  }
};

/** Dependencies that make the native PTY probe's host boundary testable. */
export interface ProcessCaptureProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly loadPty?: () => Promise<typeof import("@lydell/node-pty")>;
  readonly prepareOwnershipInspector?: () => Promise<void>;
  readonly loadWindowsAuthority?: () => WindowsNativeLoadResult;
  readonly probeWindowsTerminal?: () => Promise<void>;
}

/** Probe the native PTY seam and explain loader failures at their source. */
export const processCaptureProbeFailureReason = (cause: unknown): string => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const code = "code" in error ? String(error.code) : "";
  const diagnostic = error.message;
  if (
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /cannot find module|cannot find package/iu.test(diagnostic)
  )
    return `the native PTY module is missing (${diagnostic}); reinstall REA for this host with optional dependencies enabled (for a source checkout, run npm ci)`;
  if (
    /NODE_MODULE_VERSION|compiled against a different Node\.js version|module version mismatch/iu.test(
      diagnostic,
    )
  )
    return `the native PTY module is incompatible with this Node.js runtime (${diagnostic}); reinstall REA for this host and active Node.js version with optional dependencies enabled (for a source checkout, run npm ci after selecting that Node.js version)`;
  if (code === "ERR_DLOPEN_FAILED")
    return `the native PTY library failed to load (${diagnostic}); check the loader error, then reinstall REA for this host with optional dependencies enabled (for a source checkout, run npm ci)`;
  return `the native PTY probe failed (${diagnostic}); check the reported operating-system or process-startup error and reinstall REA for this host with optional dependencies enabled if the native binary is missing`;
};

/** Probe the actual native PTY seam instead of inferring support from the OS name. */
export const probeProcessCaptureCapability = async (
  options: ProcessCaptureProbeOptions = {},
): Promise<ProcessCaptureCapability> => {
  const platform = options.platform ?? process.platform;
  const ownershipReason = processCaptureOwnershipUnavailableReason(
    platform,
    options.loadWindowsAuthority,
  );
  if (ownershipReason !== undefined)
    return {
      available: false,
      backend: platform === "win32" ? "windows-conpty" : "node-pty",
      reason: ownershipReason,
    };
  if (platform === "win32") {
    try {
      await (options.probeWindowsTerminal ?? probeWindowsTerminal)();
      return { available: true, backend: "windows-conpty" };
    } catch (cause: unknown) {
      return {
        available: false,
        backend: "windows-conpty",
        reason: `Windows ConPTY probe failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
  }
  if (platform === "darwin") {
    try {
      await (
        options.prepareOwnershipInspector ?? prepareProcessOwnershipInspection
      )();
    } catch (cause: unknown) {
      return {
        available: false,
        backend: "node-pty",
        reason:
          cause instanceof Error
            ? cause.message
            : "macOS process ownership inspection could not be prepared",
      };
    }
  }
  try {
    const { spawn } = await (
      options.loadPty ?? (() => import("@lydell/node-pty"))
    )();
    const terminal = spawn("/bin/sh", ["-c", "exit 0"], {
      cwd: tmpdir(),
      env: { HOME: tmpdir(), TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
      name: "xterm-256color",
    });
    await new Promise<void>((resolveExit) =>
      terminal.onExit(() => resolveExit()),
    );
    return { available: true, backend: "node-pty" };
  } catch (cause: unknown) {
    return {
      available: false,
      backend: "node-pty",
      reason: processCaptureProbeFailureReason(cause),
    };
  }
};
