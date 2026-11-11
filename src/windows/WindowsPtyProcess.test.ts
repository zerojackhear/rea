import { afterEach, expect, it, vi } from "vitest";
import type { WindowsNativeAuthority } from "./WindowsNativeLoader.js";
import {
  WindowsPtyProcess,
  WINDOWS_PTY_INPUT_BUDGET,
} from "./WindowsPtyProcess.js";

afterEach(() => vi.useRealTimers());

const fixture = () => {
  const handle = {};
  const state = {
    active: 1,
    closed: false,
    failPoll: false,
    failClose: false,
    releases: 0,
    input: (bytes: Buffer): Promise<number> => Promise.resolve(bytes.length),
    output: [] as Buffer[],
    creation: "1",
  };
  const native: WindowsNativeAuthority = {
    inspection: {
      abiVersion: 1,
      nodeApiVersion: 8,
      architecture: "x64",
      privateDacl: true,
      privateBridgeDescriptorAccess: true,
      atomicJobAssignment: true,
      killOnOwnerClose: true,
      protocolStdin: true,
      conpty: true,
      filesystem: {
        requestedPath: "C:\\probe",
        finalPath: "C:\\probe",
        filesystem: "NTFS",
        volumeSerial: "0".repeat(16),
        fileId: "0".repeat(32),
        size: 0,
        directory: true,
      },
    },
    call(operation, arguments_) {
      if (operation === "process_pty_spawn")
        return {
          pid: 42,
          handle,
          jobAssigned: true,
          killOnOwnerClose: true,
          conpty: true,
        };
      expect(arguments_[0]).toBe(handle);
      if (operation === "process_poll") {
        if (state.failPoll) throw new Error("job observation failed");
        return {
          stdout: state.output.shift() ?? Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          stdoutEnded: state.closed,
          stderrEnded: true,
          activeProcesses: state.active,
          exitCode: state.active === 0 ? 0 : null,
          terminalClosed: state.closed,
        };
      }
      if (operation === "process_stdin_write") {
        if (!Buffer.isBuffer(arguments_[1]))
          throw new Error("input is not bytes");
        return state.input(arguments_[1]);
      }
      if (operation === "process_pty_close") {
        state.closed = true;
        return null;
      }
      if (operation === "process_terminate") {
        state.active = 0;
        return true;
      }
      if (operation === "process_close") {
        if (state.failClose) throw new Error("native resource release failed");
        state.releases += 1;
        return null;
      }
      if (operation === "process_sample")
        return {
          rows: [
            {
              pid: 42,
              parentPid: 7,
              imagePath: "C:\\self.exe",
              creationTime: state.creation,
            },
          ],
          limited: false,
          unreadable: 0,
        };
      throw new Error(`Unexpected operation ${operation}`);
    },
  };
  const terminal = new WindowsPtyProcess("C:\\self.exe", [], {
    cwd: "C:\\",
    env: {},
    cols: 80,
    rows: 24,
    authority: native,
  });
  return { terminal, state };
};

const cleanup = async (terminal: WindowsPtyProcess) => {
  const pending = terminal.cleanup();
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toMatchObject({ cleaned: true });
};

it("preserves split UTF-8 output and excludes native failures from target output", async () => {
  vi.useFakeTimers();
  const { terminal, state } = fixture();
  const bytes = Buffer.from("中");
  state.output.push(bytes.subarray(0, 1), bytes.subarray(1));
  let output = "";
  const failures: string[] = [];
  terminal.onData((data) => {
    output += data;
  });
  terminal.onFailure((error) => failures.push(error.message));
  await vi.advanceTimersByTimeAsync(60);
  expect(output).toBe("中");
  state.failPoll = true;
  await vi.advanceTimersByTimeAsync(30);
  expect(failures).toEqual(["job observation failed"]);
  expect(output).toBe("中");
  state.failPoll = false;
  await cleanup(terminal);
});

it("bounds pending input before allocation and reports asynchronous write failures", async () => {
  vi.useFakeTimers();
  const { terminal, state } = fixture();
  let rejectWrite: ((cause: Error) => void) | undefined;
  state.input = (bytes) => {
    expect(bytes.length).toBeLessThanOrEqual(65536);
    return new Promise((_resolve, reject) => {
      rejectWrite = reject;
    });
  };
  const failures: string[] = [];
  terminal.onFailure((error) => failures.push(error.message));
  terminal.write(Buffer.alloc(WINDOWS_PTY_INPUT_BUDGET));
  expect(() => terminal.write("x")).toThrow("1 MiB");
  rejectWrite?.(new Error("input pipe failed"));
  await vi.advanceTimersByTimeAsync(1);
  expect(failures).toEqual(["input pipe failed"]);
  await cleanup(terminal);
});

it("retains a failed native release so a later cleanup can retry the same owner", async () => {
  vi.useFakeTimers();
  const { terminal, state } = fixture();
  state.failClose = true;
  const first = terminal.cleanup();
  await vi.advanceTimersByTimeAsync(5100);
  expect(await first).toMatchObject({
    cleaned: false,
    reason: "native resource release failed",
  });
  expect(state.releases).toBe(0);
  state.failClose = false;
  await cleanup(terminal);
  expect(state.releases).toBe(1);
});

it("does not merge reused PIDs or pretend to deliver POSIX signals", async () => {
  vi.useFakeTimers();
  const { terminal, state } = fixture();
  expect(terminal.sample(0, 10).values).toHaveLength(1);
  state.creation = "2";
  expect(terminal.sample(1, 10)).toMatchObject({
    values: [],
    incompleteReason: expect.stringContaining("changed identity"),
  });
  expect(() => terminal.kill("SIGTERM")).toThrow("POSIX");
  expect(await terminal.signalRoot("SIGTERM")).toMatchObject({
    delivery: "unverified",
  });
  await cleanup(terminal);
});
