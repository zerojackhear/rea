import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderProcessSupervisor } from "../../../src/process/ProviderProcess.js";
import {
  spawnProviderProcessFixture,
  stopProviderProcessFixture,
  waitForProviderProcessReady,
} from "../../fixtures/providerProcess.js";

interface ControlledProcessFixture {
  readonly child: EventEmitter & {
    readonly stdout: PassThrough;
    readonly stderr: PassThrough;
  };
  readonly supervisor: ProviderProcessSupervisor;
}

const controlledProcesses: ControlledProcessFixture[] = [];

// Control only the process event producer; keep the supervisor and its wait
// lifecycle real so same-turn events and released timers are deterministic.
const controlledProcess = (): ControlledProcessFixture => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => true,
  });
  const supervisor = new ProviderProcessSupervisor({
    process: child,
    ownsProcessLifetime: true,
  });
  const fixture = { child, supervisor };
  controlledProcesses.push(fixture);
  return fixture;
};

afterEach(() => {
  for (const { child, supervisor } of controlledProcesses.splice(0)) {
    supervisor.dispose();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  vi.useRealTimers();
});

describe("provider process output-close waits", () => {
  it("keeps exit independent from physical output closure and releases settled waits", async () => {
    vi.useFakeTimers();
    const { child, supervisor } = controlledProcess();
    const controller = new AbortController();
    const exited = supervisor.waitForExit(1_000);
    const closed = supervisor.waitForOutputClose(1_000, controller.signal);

    child.emit("exit", 0, null);
    await expect(exited).resolves.toBe(true);
    expect(supervisor.observedExit()).toEqual({ code: 0, signal: null });
    expect(supervisor.observedOutputClose()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

    child.emit("close", 0, null);
    await expect(closed).resolves.toBe(true);
    expect(supervisor.observedOutputClose()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    controller.abort();
    await expect(
      supervisor.waitForOutputClose(1_000, controller.signal),
    ).resolves.toBe(true);
    await expect(supervisor.waitForExit(1_000)).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not register a timer or abort listener for a pre-aborted open wait", async () => {
    vi.useFakeTimers();
    const { supervisor } = controlledProcess();
    const controller = new AbortController();
    controller.abort();

    await expect(
      supervisor.waitForOutputClose(1_000, controller.signal),
    ).resolves.toBe(false);

    expect(supervisor.observedOutputClose()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("releases the timer and abort listener when an open wait is cancelled", async () => {
    vi.useFakeTimers();
    const { child, supervisor } = controlledProcess();
    const controller = new AbortController();
    const closed = supervisor.waitForOutputClose(60_000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

    controller.abort();
    await expect(closed).resolves.toBe(false);
    expect(supervisor.observedOutputClose()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    const laterClose = supervisor.waitForOutputClose(1_000);
    child.emit("close", 0, null);
    await expect(laterClose).resolves.toBe(true);
    expect(supervisor.observedOutputClose()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the abort listener on timeout without claiming physical closure", async () => {
    vi.useFakeTimers();
    const { child, supervisor } = controlledProcess();
    const controller = new AbortController();
    const closed = supervisor.waitForOutputClose(25, controller.signal);

    await vi.advanceTimersByTimeAsync(25);
    await expect(closed).resolves.toBe(false);
    expect(supervisor.observedOutputClose()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    controller.abort();
    child.emit("close", 0, null);
    expect(supervisor.observedOutputClose()).toBe(true);
  });

  it.each(["close-first", "abort-first"] as const)(
    "preserves physical close when cancellation wins the same-turn wait (%s)",
    async (order) => {
      vi.useFakeTimers();
      const { child, supervisor } = controlledProcess();
      const controller = new AbortController();
      const closed = supervisor.waitForOutputClose(1_000, controller.signal);

      if (order === "close-first") {
        child.emit("close", 0, null);
        controller.abort();
      } else {
        controller.abort();
        child.emit("close", 0, null);
      }

      await expect(closed).resolves.toBe(false);
      expect(supervisor.observedOutputClose()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      await expect(
        supervisor.waitForOutputClose(1_000, controller.signal),
      ).resolves.toBe(true);
    },
  );

  it("can observe real owned-process closure after cancelling its pending wait", async () => {
    const child = spawnProviderProcessFixture("stubborn");
    const supervisor = new ProviderProcessSupervisor({
      process: child,
      ownsProcessLifetime: true,
    });
    const controller = new AbortController();
    try {
      await waitForProviderProcessReady(child);
      const closed = supervisor.waitForOutputClose(60_000, controller.signal);
      controller.abort();
      await expect(closed).resolves.toBe(false);
      expect(supervisor.observedOutputClose()).toBe(false);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

      await stopProviderProcessFixture(child);
      await expect(supervisor.waitForOutputClose(2_000)).resolves.toBe(true);
      expect(supervisor.observedOutputClose()).toBe(true);
      expect(supervisor.snapshot().stdout.text).toBe("ready\n");
    } finally {
      await stopProviderProcessFixture(child);
      supervisor.dispose();
    }
  });
});
