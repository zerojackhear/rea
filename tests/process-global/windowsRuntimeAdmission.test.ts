import { beforeEach, expect, it, vi } from "vitest";
import { WindowsPrivateRuntime } from "../../src/windows/WindowsPrivateRuntime.js";
import { PrivateRuntimeRootUnavailableError } from "../../src/process/PrivateRuntimeRootUnavailableError.js";

const { nativeCall } = vi.hoisted(() => ({ nativeCall: vi.fn() }));
vi.mock("../../src/windows/WindowsNativeLoader.js", async (original) => ({
  ...(await original<
    typeof import("../../src/windows/WindowsNativeLoader.js")
  >()),
  requireWindowsNativeAuthority: () => ({ call: nativeCall }),
}));
beforeEach(() => {
  nativeCall.mockReset();
});

it.each([
  {
    label: "sharing conflict before allocation",
    win32Code: 32,
    runtimeAllocation: "not-started",
    retryable: true,
  },
  {
    label: "lock conflict before allocation",
    win32Code: 33,
    runtimeAllocation: "not-started",
    retryable: true,
  },
  { label: "unknown allocation", win32Code: 32, retryable: false },
  {
    label: "possible allocation",
    win32Code: 32,
    runtimeAllocation: "started",
    retryable: false,
  },
  {
    label: "permission failure",
    win32Code: 5,
    runtimeAllocation: "not-started",
    retryable: false,
  },
  {
    label: "string code",
    win32Code: "32",
    runtimeAllocation: "not-started",
    retryable: false,
  },
  {
    label: "inconsistent error code",
    win32Code: 32,
    code: "EACCES",
    runtimeAllocation: "not-started",
    retryable: false,
  },
])(
  "retains $label without guessing runtime ownership",
  ({ retryable, label: _label, ...facts }) => {
    const cause = Object.assign(new Error("Selected native diagnostic"), {
      code: "ERR_REA_WINDOWS_NATIVE",
      ...facts,
    });
    nativeCall.mockImplementation(() => {
      throw cause;
    });
    let observed: unknown;
    try {
      WindowsPrivateRuntime.create("D:/selected parent", "selected-prefix-");
    } catch (failure: unknown) {
      observed = failure;
    }
    expect(nativeCall).toHaveBeenCalledTimes(1);
    expect(nativeCall).toHaveBeenCalledWith("runtime_create", [
      "D:/selected parent",
      "selected-prefix-",
    ]);
    if (retryable) {
      expect(observed).toBeInstanceOf(PrivateRuntimeRootUnavailableError);
      expect(observed).toMatchObject({
        message: cause.message,
        cause,
        retryable: true,
      });
    } else expect(observed).toBe(cause);
  },
);

it("does not infer a transient status from a human-readable diagnostic", () => {
  const cause = new Error("Open Windows path component failed (Win32 32)");
  nativeCall.mockImplementation(() => {
    throw cause;
  });
  let observed: unknown;
  try {
    WindowsPrivateRuntime.create("D:/selected parent", "selected-prefix-");
  } catch (failure: unknown) {
    observed = failure;
  }
  expect(observed).toBe(cause);
});

const identity = {
  requestedPath: "C:\\test\\selected",
  finalPath: "C:\\test\\selected",
  filesystem: "NTFS",
  volumeSerial: "0".repeat(16),
  fileId: "1".repeat(32),
  size: 3,
  directory: false,
} as const;
const copied = { sha256: "a".repeat(64), source: identity, snapshot: identity };
const snapshotFailure = (facts: Record<string, unknown> = {}) =>
  Object.assign(new Error("Selected snapshot admission failure"), {
    code: "ERR_REA_WINDOWS_NATIVE",
    win32Code: 32,
    snapshotAllocation: "not-started",
    ...facts,
  });
const admittedRuntime = (copy: () => unknown) => {
  nativeCall.mockImplementation((operation: string) => {
    if (operation === "runtime_create")
      return {
        ...identity,
        path: identity.finalPath,
        directory: true,
        privateDacl: true,
        handle: {},
      };
    if (operation === "runtime_snapshot") return copy();
    return undefined;
  });
  return WindowsPrivateRuntime.create("C:\\test", "selected-");
};

it("retries only pre-copy sharing admission and preserves the byte bound", async () => {
  const failure = snapshotFailure();
  const copy = vi
    .fn()
    .mockImplementationOnce(() => {
      throw failure;
    })
    .mockResolvedValue(copied);
  const runtime = admittedRuntime(copy);
  try {
    await expect(
      runtime.snapshot("selected", "output", undefined, 3),
    ).resolves.toEqual(copied);
    expect(copy).toHaveBeenCalledTimes(2);
    expect(nativeCall).toHaveBeenLastCalledWith("runtime_snapshot", [
      runtime.observation.handle,
      "selected",
      "output",
      3,
    ]);
  } finally {
    await runtime.close();
  }
});

it.each([
  { snapshotAllocation: undefined },
  { snapshotAllocation: "started" },
  { win32Code: 5 },
  { win32Code: "32" },
  { code: "EACCES" },
])(
  "does not retry an unproven or non-sharing copy failure: %j",
  async (facts) => {
    const failure = snapshotFailure(facts);
    const copy = vi.fn(() => {
      throw failure;
    });
    const runtime = admittedRuntime(copy);
    try {
      await expect(runtime.snapshot("selected", "output")).rejects.toBe(
        failure,
      );
      expect(copy).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  },
);

it("never replays an asynchronously rejected accepted copy", async () => {
  const failure = snapshotFailure();
  const copy = vi.fn().mockRejectedValue(failure);
  const runtime = admittedRuntime(copy);
  try {
    await expect(runtime.snapshot("selected", "output")).rejects.toBe(failure);
    expect(copy).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.close();
  }
});

it("bounds repeated contention and retains the actual native error", async () => {
  const failure = snapshotFailure();
  const copy = vi.fn(() => {
    throw failure;
  });
  const runtime = admittedRuntime(copy);
  try {
    await expect(runtime.snapshot("selected", "output")).rejects.toBe(failure);
    expect(copy).toHaveBeenCalledTimes(4);
  } finally {
    await runtime.close();
  }
});

it("cancels admission backoff without cancelling another native copy", async () => {
  const failure = snapshotFailure();
  const copy = vi.fn(() => {
    throw failure;
  });
  const runtime = admittedRuntime(copy);
  const controller = new AbortController();
  try {
    const pending = runtime.snapshot("selected", "output", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(copy).toHaveBeenCalledTimes(1);
    expect(
      nativeCall.mock.calls.some(
        ([operation]) => operation === "runtime_snapshot_cancel",
      ),
    ).toBe(false);
  } finally {
    await runtime.close();
  }
});
