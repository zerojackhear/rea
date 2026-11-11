import { z } from "zod";
import type {
  OwnedInferiorIdentity,
  ProcessStartTimeReader,
} from "../process/ownedDebuggerSession.js";
import {
  requireWindowsNativeAuthority,
  systemWindowsNativeAuthority,
  windowsFileIdentitySchema,
} from "./WindowsNativeLoader.js";

const outputFileSchema = windowsFileIdentitySchema.extend({
  directory: z.literal(false),
});
const outputObservationSchema = z.strictObject({
  pid: z.number().int().positive().max(0xffff_ffff),
  startTime: z.string().regex(/^\d+$/u),
  output: outputFileSchema,
  stdoutVerified: z.literal(true),
  stderrVerified: z.literal(true),
});

const processId = (pid: string): number => {
  const value = z
    .string()
    .regex(/^[1-9]\d*$/u)
    .parse(pid);
  return z.number().int().positive().max(0xffff_ffff).parse(Number(value));
};

/** Admission for native debugger lifetime and read-only inferior inspection. */
export const windowsDebuggerUnavailableReason = (): string | undefined => {
  const loaded = systemWindowsNativeAuthority();
  if (!loaded.available) return loaded.reason;
  return loaded.authority.inspection.debuggerLeaderOnly === true
    ? undefined
    : "The matching Windows native artifact lacks debugger-only lifetime control and inferior output identity inspection.";
};

/** Inspect an existing local output file without creating, truncating or writing it. */
export const inspectWindowsDebuggerOutputFile = (path: string) =>
  outputFileSchema.parse(
    requireWindowsNativeAuthority().call("debugger_output_file", [path]),
  );

/** Observe start identity without treating access failure as process absence. */
export const readWindowsProcessStartTime: ProcessStartTimeReader = async (
  pid,
) =>
  z
    .string()
    .regex(/^\d+$/u)
    .nullable()
    .parse(
      requireWindowsNativeAuthority().call("debugger_process_start", [
        processId(pid),
      ]),
    );

/** Read kernel debugger attachment state while retaining the process identity. */
export const readWindowsDebuggerState = (pid: string) => {
  const selectedPid = processId(pid);
  const observed = z
    .strictObject({
      pid: z.number().int().positive().max(0xffff_ffff),
      startTime: z.string().regex(/^\d+$/u),
      attached: z.boolean(),
    })
    .nullable()
    .parse(
      requireWindowsNativeAuthority().call("debugger_process_debug_state", [
        selectedPid,
      ]),
    );
  if (observed !== null && observed.pid !== selectedPid)
    throw new Error("Debugger-state observation belongs to a different PID");
  return observed;
};

/** Bind both live output handles to the selected NTFS file and retain identity. */
export const verifyWindowsInferiorOutputSink = async (
  pid: string,
  selectedOutput: string,
  rememberIdentity: (identity: OwnedInferiorIdentity) => void,
): Promise<void> => {
  const selectedPid = processId(pid);
  const observation = outputObservationSchema.parse(
    requireWindowsNativeAuthority().call("debugger_inspect_stdio", [
      selectedPid,
      selectedOutput,
    ]),
  );
  if (observation.pid !== selectedPid)
    throw new Error("Inferior output observation belongs to a different PID");
  rememberIdentity({ pid, startTime: observation.startTime });
};
