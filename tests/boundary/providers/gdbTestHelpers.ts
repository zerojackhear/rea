import { expect } from "vitest";

import type { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";

/** Start only test-authored Node MI fixtures with their actual interpreter. */
export const spawnNodeGdbFixture: typeof spawnOwnedProviderProcess = async (
  options,
) =>
  spawnOwnedProviderProcess({
    ...options,
    command: process.execPath,
    arguments: [options.command, ...options.arguments],
    // Node's Windows entropy initialization needs SystemRoot even when the
    // test deliberately supplies no provider PATH or other ambient values.
    ...(process.platform === "win32"
      ? {
          hostEnvironment: {
            SystemRoot: process.env.SystemRoot,
            ...options.hostEnvironment,
          },
        }
      : {}),
    ...(process.platform === "win32"
      ? { windowsDebuggerLeaderOnly: true }
      : {}),
  });

type GdbSessionStart = Awaited<ReturnType<GdbSessionManager["start"]>>;
type StartedGdbSession = Extract<GdbSessionStart, { readonly ok: true }>;

export const expectGdbSessionStarted = async (
  manager: GdbSessionManager,
  ...arguments_: Parameters<GdbSessionManager["start"]>
): Promise<StartedGdbSession> => {
  const started = await manager.start(...arguments_);
  expect(started.ok, started.ok ? undefined : started.error.message).toBe(true);
  if (!started.ok) throw new Error(started.error.message);
  return started;
};
