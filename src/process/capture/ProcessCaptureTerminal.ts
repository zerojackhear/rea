import type { IPty } from "@lydell/node-pty";

/** The terminal operations consumed by capture, independent of its provider. */
export type ProcessCaptureTerminal = Pick<
  IPty,
  "pid" | "onData" | "onExit" | "write" | "resize" | "kill"
> & {
  /** Native asynchronous failures are separate from target terminal output. */
  readonly onFailure?: (listener: (cause: Error) => void) => {
    dispose(): void;
  };
};
