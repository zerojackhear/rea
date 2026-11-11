import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import type { ProcessCleanupResult } from "../process/ProcessOwnership.js";
import type { ProcessCaptureTerminal } from "../process/capture/ProcessCaptureTerminal.js";
import type { ProcessSample } from "../domain/process/processCapture.js";
import { quoteWindowsProcessArgument } from "./WindowsOwnedProcess.js";
import {
  requireWindowsNativeAuthority,
  windowsHandleSchema,
  type WindowsNativeAuthority,
} from "./WindowsNativeLoader.js";

const launchSchema = z.strictObject({
  pid: z.number().int().positive().max(0xffff_ffff),
  handle: windowsHandleSchema,
  jobAssigned: z.literal(true),
  killOnOwnerClose: z.literal(true),
  conpty: z.literal(true),
});
const pollSchema = z.strictObject({
  stdout: z.instanceof(Buffer),
  stderr: z.instanceof(Buffer),
  stdoutEnded: z.boolean(),
  stderrEnded: z.boolean(),
  exitCode: z.number().int().nonnegative().max(0xffff_ffff).nullable(),
  activeProcesses: z.number().int().nonnegative(),
  terminalClosed: z.boolean(),
});
const sampleSchema = z.strictObject({
  rows: z.array(
    z.strictObject({
      pid: z.number().int().positive().max(0xffff_ffff),
      parentPid: z.number().int().nonnegative().max(0xffff_ffff),
      imagePath: z.string().min(1),
      creationTime: z.string().regex(/^\d+$/u),
    }),
  ),
  limited: z.boolean(),
  unreadable: z.number().int().nonnegative(),
});

/** Bound queued interactive input independently of child consumption speed. */
export const WINDOWS_PTY_INPUT_BUDGET = 1024 * 1024;

/** A real ConPTY whose entire descendant tree is held by a private native job. */
export class WindowsPtyProcess implements ProcessCaptureTerminal {
  readonly pid: number;
  readonly #authority: WindowsNativeAuthority;
  readonly #handle: object;
  readonly #decoder = new StringDecoder("utf8");
  readonly #data = new Set<(data: string) => void>();
  readonly #exits = new Set<(event: { exitCode: number }) => void>();
  readonly #failures = new Set<(cause: Error) => void>();
  readonly #identities = new Map<number, string>();
  readonly #queue: Buffer[] = [];
  #queuedBytes = 0;
  #writing = false;
  #closed = false;
  #closing = false;
  #exit: { exitCode: number } | undefined;
  #failure: Error | undefined;
  #timer: NodeJS.Timeout | undefined;
  #drain: NodeJS.Immediate | undefined;
  #cleanup: Promise<ProcessCleanupResult> | undefined;

  constructor(
    command: string,
    arguments_: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly cols: number;
      readonly rows: number;
      readonly authority?: WindowsNativeAuthority;
    },
  ) {
    this.#authority = options.authority ?? requireWindowsNativeAuthority();
    if (this.#authority.inspection.conpty !== true)
      throw new Error(
        "The verified Windows native artifact does not support owned ConPTY capture",
      );
    const launched = launchSchema.parse(
      this.#authority.call("process_pty_spawn", [
        command,
        [command, ...arguments_].map(quoteWindowsProcessArgument).join(" "),
        options.cwd,
        Object.entries(options.env).map(([name, value]) => `${name}=${value}`),
        options.cols,
        options.rows,
      ]),
    );
    this.pid = launched.pid;
    this.#handle = launched.handle;
    this.#schedule();
  }

  readonly onData = (listener: (data: string) => void): { dispose(): void } => {
    this.#data.add(listener);
    return {
      dispose: () => {
        this.#data.delete(listener);
      },
    };
  };
  readonly onExit = (
    listener: (event: { exitCode: number }) => void,
  ): { dispose(): void } => {
    this.#exits.add(listener);
    if (this.#exit !== undefined) {
      const event = this.#exit;
      queueMicrotask(() => {
        if (this.#exits.has(listener)) listener(event);
      });
    }
    return {
      dispose: () => {
        this.#exits.delete(listener);
      },
    };
  };
  readonly onFailure = (
    listener: (cause: Error) => void,
  ): { dispose(): void } => {
    this.#failures.add(listener);
    if (this.#failure !== undefined) {
      const cause = this.#failure;
      queueMicrotask(() => {
        if (this.#failures.has(listener)) listener(cause);
      });
    }
    return {
      dispose: () => {
        this.#failures.delete(listener);
      },
    };
  };

  /** Enqueue bounded UTF-8 input; a later pipe failure reaches onFailure. */
  write(data: string | Buffer): void {
    if (this.#closed || this.#closing || this.#exit !== undefined)
      throw new Error("The captured Windows terminal has exited");
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
    if (size > WINDOWS_PTY_INPUT_BUDGET - this.#queuedBytes)
      throw new Error(
        "Pending Windows terminal input exceeds the 1 MiB queue budget",
      );
    if (size === 0) return;
    this.#queue.push(Buffer.from(data));
    this.#queuedBytes += size;
    if (!this.#writing) void this.#flushInput();
  }

  async #flushInput(): Promise<void> {
    this.#writing = true;
    try {
      while (this.#queue.length > 0 && !this.#closing && !this.#closed) {
        const bytes = this.#queue[0];
        if (bytes === undefined) break;
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          const chunk = bytes.subarray(offset, offset + 65536);
          const written = z
            .number()
            .int()
            .nonnegative()
            .parse(
              await this.#authority.call("process_stdin_write", [
                this.#handle,
                chunk,
              ]),
            );
          if (written !== chunk.length)
            throw new Error("Windows terminal input write was incomplete");
          if (this.#closing || this.#closed) break;
        }
        this.#queue.shift();
        this.#queuedBytes -= bytes.length;
      }
    } catch (cause: unknown) {
      if (!this.#closing && !this.#closed) this.#fail(cause);
    } finally {
      this.#queue.length = 0;
      this.#queuedBytes = 0;
      this.#writing = false;
    }
  }

  resize(columns: number, rows: number): void {
    this.#authority.call("process_pty_resize", [this.#handle, columns, rows]);
  }

  /** SIGKILL means forced termination of the retained root handle on Windows. */
  kill(signal = "SIGKILL"): void {
    if (signal !== "SIGKILL")
      throw new Error(`Windows capture does not implement POSIX ${signal}`);
    if (!this.#closed)
      this.#authority.call("process_terminate_leader", [this.#handle]);
  }

  async signalRoot(signal: "SIGTERM" | "SIGKILL"): Promise<{
    readonly delivery: "signaled" | "gone" | "unverified";
    readonly reason?: string;
  }> {
    if (signal === "SIGTERM")
      return {
        delivery: "unverified",
        reason: "Windows has no POSIX SIGTERM delivery; no signal was sent",
      };
    if (this.#closed) return { delivery: "gone" };
    const signaled = z
      .boolean()
      .parse(this.#authority.call("process_terminate_leader", [this.#handle]));
    return { delivery: signaled ? "signaled" : "gone" };
  }

  /** Observe job membership without deriving authority from parent PIDs. */
  activeProcesses(): number {
    return this.#closed
      ? 0
      : z
          .number()
          .int()
          .nonnegative()
          .parse(this.#authority.call("process_alive", [this.#handle]));
  }

  /** Sample handle-bound parent and image facts; command-line arguments are unknown. */
  sample(
    elapsedMs: number,
    limit: number,
  ): {
    readonly values: readonly ProcessSample[];
    readonly limited: boolean;
    readonly incompleteReason?: string;
  } {
    if (this.#closed) return { values: [], limited: false };
    const observed = sampleSchema.parse(
      this.#authority.call("process_sample", [this.#handle, limit]),
    );
    const values: ProcessSample[] = [];
    let changed = 0;
    let limited = observed.limited;
    for (const row of observed.rows) {
      const previous = this.#identities.get(row.pid);
      if (previous !== undefined && previous !== row.creationTime) {
        changed += 1;
        continue;
      }
      if (
        previous === undefined &&
        this.#identities.size >= Math.min(limit, 16384)
      ) {
        limited = true;
        continue;
      }
      this.#identities.set(row.pid, row.creationTime);
      values.push({
        at_ms: elapsedMs,
        pid: row.pid,
        parent_pid: row.parentPid,
        command: row.imagePath,
        process_group_id: null,
        session_id: null,
      });
    }
    const omitted = observed.unreadable + changed;
    return {
      values,
      limited,
      ...(omitted === 0
        ? {}
        : {
            incompleteReason: `${String(omitted)} Windows job members exited, changed identity, or could not be read during sampling`,
          }),
    };
  }

  /** Keep the native job until its members, terminal and output are all settled. */
  cleanup(): Promise<ProcessCleanupResult> {
    this.#cleanup ??= this.#stop().then((result) => {
      if (!result.cleaned) this.#cleanup = undefined;
      return result;
    });
    return this.#cleanup;
  }

  async #stop(): Promise<ProcessCleanupResult> {
    if (this.#closed) return { cleaned: true, signaled: false };
    this.#closing = true;
    // Capture observations have ended; drain cleanup output without invoking a
    // renderer that the resource scope may already have disposed.
    this.#data.clear();
    try {
      const signaled = z
        .boolean()
        .parse(this.#authority.call("process_terminate", [this.#handle]));
      this.#schedule(0);
      const deadline = performance.now() + 5000;
      while (!this.#closed && performance.now() < deadline) await delay(10);
      return this.#closed
        ? { cleaned: true, signaled }
        : {
            cleaned: false,
            reason:
              this.#failure?.message ??
              "Windows terminal job did not settle before the cleanup deadline",
          };
    } catch (cause: unknown) {
      return {
        cleaned: false,
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  #schedule(wait = 25): void {
    if (this.#closed || this.#timer !== undefined || this.#drain !== undefined)
      return;
    if (wait === 0)
      this.#drain = setImmediate(() => {
        this.#drain = undefined;
        this.#poll();
      });
    else
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#poll();
      }, wait);
  }

  #emitData(value: string): void {
    if (value !== "") for (const listener of this.#data) listener(value);
  }

  #poll(): void {
    if (this.#closed) return;
    try {
      const state = pollSchema.parse(
        this.#authority.call("process_poll", [this.#handle]),
      );
      if (state.stderr.length !== 0)
        throw new Error(
          "ConPTY unexpectedly returned a separate stderr stream",
        );
      this.#emitData(this.#decoder.write(state.stdout));
      if (state.activeProcesses === 0 && !state.terminalClosed) {
        // A private native thread closes ConPTY while this loop drains output.
        this.#closing = true;
        this.#authority.call("process_pty_close", [this.#handle]);
      }
      const settled =
        state.activeProcesses === 0 &&
        state.terminalClosed &&
        state.stdoutEnded &&
        state.stderrEnded;
      if (settled) {
        this.#emitData(this.#decoder.end());
        this.#authority.call("process_close", [this.#handle]);
        this.#closed = true;
      }
      if (
        this.#exit === undefined &&
        state.exitCode !== null &&
        (state.activeProcesses > 0 || settled)
      ) {
        this.#exit = { exitCode: state.exitCode };
        for (const listener of this.#exits) listener(this.#exit);
      }
      if (!this.#closed) this.#schedule(state.stdout.length > 0 ? 0 : 25);
    } catch (cause: unknown) {
      this.#fail(cause);
      // Retain the exact native owner for explicit cleanup retry.
    }
  }

  #fail(cause: unknown): void {
    this.#failure = cause instanceof Error ? cause : new Error(String(cause));
    for (const listener of this.#failures) listener(this.#failure);
  }
}
