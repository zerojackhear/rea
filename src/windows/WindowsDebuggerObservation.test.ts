import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  value: null as unknown,
  failure: undefined as Error | undefined,
  calls: [] as string[],
}));
vi.mock("./WindowsNativeLoader.js", async (original) => ({
  ...(await original<typeof import("./WindowsNativeLoader.js")>()),
  requireWindowsNativeAuthority: () => ({
    call: (operation: string) => {
      boundary.calls.push(operation);
      if (boundary.failure !== undefined) throw boundary.failure;
      return boundary.value;
    },
  }),
}));
import {
  readWindowsDebuggerState,
  readWindowsProcessStartTime,
  verifyWindowsInferiorOutputSink,
} from "./WindowsDebuggerObservation.js";

beforeEach(() => {
  boundary.value = null;
  boundary.failure = undefined;
  boundary.calls = [];
});
describe("Windows debugger observation boundary", () => {
  it("keeps an observed process exit distinct from denied inspection", async () => {
    expect(await readWindowsProcessStartTime("123")).toBeNull();
    expect(readWindowsDebuggerState("123")).toBeNull();
    const denied = new Error("Access denied");
    boundary.failure = denied;
    const failure = await readWindowsProcessStartTime("123").then(
      () => undefined,
      (error) => error,
    );
    expect(failure === denied).toBe(true);
    expect(() => readWindowsDebuggerState("123")).toThrow("Access denied");
  });
  it.each(["0", "-1", "123extra", "4294967296"])(
    "refuses invalid PID %s before native dispatch",
    (pid) => {
      expect(() => readWindowsDebuggerState(pid)).toThrow();
      expect(boundary.calls).toEqual([]);
    },
  );
  it("rejects a debug-state observation for another process", () => {
    boundary.value = { pid: 124, startTime: "100", attached: false };
    expect(() => readWindowsDebuggerState("123")).toThrow(/different PID/u);
  });
  it("does not interpret a string as an affirmative detach observation", () => {
    boundary.value = { pid: 123, startTime: "100", attached: "false" };
    expect(() => readWindowsDebuggerState("123")).toThrow();
  });
  it("retains both identity and actual boolean attachment state", () => {
    boundary.value = { pid: 123, startTime: "100", attached: false };
    expect(readWindowsDebuggerState("123")).toEqual({
      pid: 123,
      startTime: "100",
      attached: false,
    });
  });
  it("cannot remember a target identity when native output verification fails", async () => {
    const remember = vi.fn();
    const changed = new Error("Output identity changed");
    boundary.failure = changed;
    const failure = await verifyWindowsInferiorOutputSink(
      "123",
      "C:\\output.txt",
      remember,
    ).then(
      () => undefined,
      (error) => error,
    );
    expect(failure === changed).toBe(true);
    expect(remember).not.toHaveBeenCalled();
  });
});
