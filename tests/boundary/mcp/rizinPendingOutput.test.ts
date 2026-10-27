import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";

import { registerRizinDebugTools } from "../../../src/server/registerRizinDebugTools.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { silentLogger } from "../../../src/logger.js";
import { createInjectedProcess } from "../providers/RizinDebugSessionCoverage.fixtures.js";
import {
  createRizinTestManager,
  rizinTestInferiorTty,
} from "../providers/RizinTestInferiorTty.js";

const test = it.skipIf(process.platform === "win32");

test.each([
  "exit",
  "deadline",
  "framed-exit",
  "drained-exit",
  "drained-framed-exit",
] as const)(
  "retains received command bytes through MCP after %s",
  async (mode) => {
    const injected = createInjectedProcess({
      onWrite: (text, control) => {
        if (!text.includes("!echo __REA_COMMAND_COMPLETE_")) return;
        setImmediate(() => {
          control.output("complete prefix\0");
          if (mode.startsWith("drained-")) {
            control.exitLeader();
            setImmediate(() => {
              control.output("unfinished diagnostic Ω");
              if (mode === "drained-framed-exit") control.output("\0");
              control.closeOutput();
            });
            return;
          }
          control.output("unfinished diagnostic Ω");
          if (mode === "framed-exit") control.output("\0");
          if (mode !== "deadline") control.exit();
        });
      },
    });
    const manager = createRizinTestManager(
      {},
      {
        spawnProcess: injected.spawnProcess,
        frameTimeoutMs: 100,
      },
    );
    const server = new McpServer({ name: "rizin-partial-test", version: "1" });
    registerRizinDebugTools(
      server,
      manager,
      silentLogger,
      createToolResultDelivery(undefined),
    );
    const client = new Client({ name: "rizin-partial-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const startReply = await client.callTool({
        name: "start_rizin_debug_session",
        arguments: {
          path: "fixture.bin",
          inferior_tty: await rizinTestInferiorTty(),
        },
      });
      expect(startReply.isError).not.toBe(true);
      const started = toolContract(
        "start_rizin_debug_session",
      ).outputSchema.parse(startReply.structuredContent);
      const reply = await client.callTool({
        name: "rizin_debug_command",
        arguments: { session_id: started.session_id, command: "dr" },
      });
      expect(reply.isError).not.toBe(true);
      const expected = {
        output: "complete prefix\nunfinished diagnostic Ω",
        completion_status: "unknown",
        output_truncated: mode === "deadline",
      };
      expect(reply.structuredContent).toMatchObject({
        normalized_result: expected,
        raw_result: expected,
      });
    } finally {
      injected.control.exit();
      await client.close();
      await server.close();
      await manager.closeAll();
    }
  },
);

test.each([
  { mode: "exit", maximum: 10, invalid: true, expected: "first\n�A" },
  { mode: "cancel", maximum: 9, invalid: true, expected: "first\n�" },
  { mode: "exit", maximum: 9, invalid: false, expected: "first\n�" },
  { mode: "cancel", maximum: 8, invalid: true, expected: "first" },
])(
  "bounds pending UTF-8 after $mode (budget: $maximum, invalid: $invalid)",
  async ({ mode, maximum, invalid, expected }) => {
    const controller = new AbortController();
    const injected = createInjectedProcess({
      onWrite: (text, control) => {
        if (!text.includes("!echo __REA_COMMAND_COMPLETE_")) return;
        control.output(
          Buffer.concat([
            Buffer.from("first\0"),
            invalid ? Buffer.from([0xff]) : Buffer.from("�"),
            Buffer.from("ABCDEFGHIJKLM"),
          ]),
        );
        if (mode === "exit") control.exit();
        else controller.abort();
      },
    });
    const manager = createRizinTestManager(
      {},
      {
        spawnProcess: injected.spawnProcess,
        maxCommandOutputBytes: maximum,
      },
    );
    try {
      const started = await manager.start({
        path: "fixture.bin",
        inferior_tty: await rizinTestInferiorTty(),
      });
      if (!started.ok) throw started.error;
      const result = await manager.execute(
        started.value.session_id,
        "dr",
        controller.signal,
      );
      const evidence = result.ok
        ? result.value.evidence
        : result.error.partialObservation;
      expect(evidence).toMatchObject({
        normalized_result: {
          output: expected,
          output_truncated: true,
          completion_status: "unknown",
        },
        raw_result: { output: expected, output_truncated: true },
      });
      if (invalid)
        expect(evidence).toMatchObject({
          normalized_result: { output_invalid_utf8: true },
        });
      else
        expect(evidence).not.toHaveProperty(
          "normalized_result.output_invalid_utf8",
        );
      if (!result.ok) expect(result.error.capturedOutput?.truncated).toBe(true);
      expect(
        manager.status(started.value.session_id)?.output_invalid_utf8,
      ).toBe(invalid);
    } finally {
      injected.control.exit();
      await manager.closeAll();
    }
  },
);

test("rejects an unfinished unsolicited frame before command dispatch", async () => {
  let dispatched = false;
  const injected = createInjectedProcess({
    onWrite: (text, control) => {
      const marker = /!echo (__REA_COMMAND_COMPLETE_\w+)/u.exec(text)?.[1];
      if (marker === undefined) return;
      dispatched = true;
      setImmediate(() => control.output(`new command\0${marker}\n\0`));
    },
  });
  const manager = createRizinTestManager(
    {},
    { spawnProcess: injected.spawnProcess },
  );
  try {
    const started = await manager.start({
      path: "fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    if (!started.ok) throw started.error;
    injected.control.output("unclaimed old output");
    const result = await manager.execute(started.value.session_id, "dr");
    expect(result.ok).toBe(false);
    expect(dispatched).toBe(false);
  } finally {
    injected.control.exit();
    await manager.closeAll();
  }
});

test.each(["_", "__REA_", "marker-prefix"])(
  "preserves ambiguous diagnostic suffix %s on interruption",
  async (suffix) => {
    let expected = "";
    const injected = createInjectedProcess({
      onWrite: (text, control) => {
        const marker = /!echo (__REA_COMMAND_COMPLETE_\w+)/u.exec(text)?.[1];
        if (marker === undefined) return;
        expected = `literal diagnostic ${suffix === "marker-prefix" ? marker.slice(0, -5) : suffix}`;
        control.output(expected);
        control.exit();
      },
    });
    const manager = createRizinTestManager(
      {},
      { spawnProcess: injected.spawnProcess },
    );
    try {
      const started = await manager.start({
        path: "fixture.bin",
        inferior_tty: await rizinTestInferiorTty(),
      });
      if (!started.ok) throw started.error;
      const result = await manager.execute(started.value.session_id, "dr");
      if (!result.ok) throw result.error;
      expect(result.value.evidence).toMatchObject({
        normalized_result: { output: expected, completion_status: "unknown" },
        raw_result: { output: expected },
      });
      expect(result.value.evidence.limitations).toContain(
        "Interrupted output may include an incomplete completion-marker prefix; it is retained because it cannot be distinguished from command diagnostics.",
      );
    } finally {
      injected.control.exit();
      await manager.closeAll();
    }
  },
);

test("retains partial bytes and uncertainty when exited output never closes", async () => {
  const injected = createInjectedProcess({
    onWrite: (text, control) => {
      if (!text.includes("!echo __REA_COMMAND_COMPLETE_")) return;
      control.output("retained before exit");
      control.exitLeader();
    },
  });
  const manager = createRizinTestManager(
    {},
    { spawnProcess: injected.spawnProcess },
  );
  try {
    const started = await manager.start({
      path: "fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    if (!started.ok) throw started.error;
    const result = await manager.execute(started.value.session_id, "dr");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected retained cleanup uncertainty");
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        output: "retained before exit",
        output_truncated: true,
        completion_status: "unknown",
      },
    });
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  } finally {
    injected.control.closeOutput();
    await manager.closeAll();
  }
});

test.each(["cancel", "overflow", "cancel-overflow"] as const)(
  "preserves exit-drain evidence across %s",
  async (mode) => {
    const controller = new AbortController();
    const injected = createInjectedProcess({
      onWrite: (text, control) => {
        if (!text.includes("!echo __REA_COMMAND_COMPLETE_")) return;
        setImmediate(() => {
          control.output("before exit\0");
          control.exitLeader();
          setImmediate(() => {
            control.output("after exit\0");
            if (mode.includes("overflow"))
              control.output("late\0".repeat(4096));
            if (mode.includes("cancel")) controller.abort();
            control.closeOutput();
          });
        });
      },
    });
    const manager = createRizinTestManager(
      {},
      { spawnProcess: injected.spawnProcess },
    );
    try {
      const started = await manager.start({
        path: "fixture.bin",
        inferior_tty: await rizinTestInferiorTty(),
      });
      if (!started.ok) throw started.error;
      const result = await manager.execute(
        started.value.session_id,
        "dr",
        controller.signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected interrupted command");
      const expected = mode.includes("overflow")
        ? [
            "before exit",
            "after exit",
            ...Array<string>(4094).fill("late"),
          ].join("\n")
        : "before exit\nafter exit";
      expect(result.error.partialObservation).toMatchObject({
        normalized_result: {
          output: expected,
          output_truncated: mode.includes("overflow"),
          completion_status: "unknown",
        },
        raw_result: { output: expected },
      });
      expect(manager.status(started.value.session_id)?.state).toBe("closed");
    } finally {
      injected.control.exit();
      await manager.closeAll();
    }
  },
);

test.each(["before-wait", "during-wait"])(
  "preserves accepted bytes on stdin failure %s",
  async (mode) => {
    const injected = createInjectedProcess({
      onWrite: (text, control) => {
        if (!text.includes("!echo __REA_COMMAND_COMPLETE_")) return;
        const fail = () => {
          control.output("accepted diagnostic Ω");
          control.stdinError();
        };
        if (mode === "before-wait") fail();
        else setImmediate(fail);
      },
    });
    const manager = createRizinTestManager(
      {},
      { spawnProcess: injected.spawnProcess },
    );
    try {
      const started = await manager.start({
        path: "fixture.bin",
        inferior_tty: await rizinTestInferiorTty(),
      });
      if (!started.ok) throw started.error;
      const result = await manager.execute(started.value.session_id, "dr");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected stdin protocol failure");
      expect(result.error.partialObservation).toMatchObject({
        normalized_result: {
          output: "accepted diagnostic Ω",
          output_truncated: false,
          completion_status: "unknown",
        },
      });
    } finally {
      injected.control.exit();
      await manager.closeAll();
    }
  },
);

test("marks output discarded by the byte queue limit during exit drainage", async () => {
  const size = 1024 * 1024;
  const injected = createInjectedProcess({
    onWrite: (text, control) => {
      if (!text.includes("!echo __REA_COMMAND_COMPLETE_")) return;
      setImmediate(() => {
        control.output("before exit\0");
        control.exitLeader();
        setImmediate(() => {
          const frame = Buffer.alloc(size + 1, "x");
          frame[size] = 0;
          for (let index = 0; index < 5; index += 1) control.output(frame);
          control.closeOutput();
        });
      });
    },
  });
  const manager = createRizinTestManager(
    {},
    { spawnProcess: injected.spawnProcess },
  );
  try {
    const started = await manager.start({
      path: "fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    if (!started.ok) throw started.error;
    const result = await manager.execute(started.value.session_id, "dr");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected bounded queue failure");
    const observation = result.error.partialObservation;
    expect(observation).toMatchObject({
      normalized_result: {
        output_truncated: true,
        completion_status: "unknown",
      },
    });
    const output = toolContract("rizin_debug_command").outputSchema.parse(
      observation,
    ).normalized_result.output;
    const frames = output.split("\n");
    expect(frames.map((frame) => frame.length)).toEqual([
      "before exit".length,
      size,
      size,
      size,
      size,
    ]);
    expect(frames.shift()).toBe("before exit");
    expect(frames.every((frame) => /^x+$/u.test(frame))).toBe(true);
  } finally {
    injected.control.exit();
    await manager.closeAll();
  }
});

test("publishes the bounded prefix when an oversized frame has no terminator", async () => {
  const injected = createInjectedProcess({
    onWrite: (text, control) => {
      if (text.includes("!echo __REA_COMMAND_COMPLETE_"))
        setImmediate(() =>
          control.output(Buffer.alloc(16 * 1024 * 1024 + 1, "x")),
        );
    },
  });
  const manager = createRizinTestManager(
    {},
    {
      spawnProcess: injected.spawnProcess,
      maxCommandOutputBytes: 20,
      frameTimeoutMs: 100,
    },
  );
  try {
    const started = await manager.start({
      path: "fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    if (!started.ok) throw started.error;
    const result = await manager.execute(started.value.session_id, "dr");
    if (!result.ok) throw result.error;
    expect(result.value.evidence).toMatchObject({
      normalized_result: {
        output: "x".repeat(20),
        output_truncated: true,
        completion_status: "unknown",
      },
    });
  } finally {
    injected.control.exit();
    await manager.closeAll();
  }
});

test("keeps the original command deadline while additional frames arrive", async () => {
  let ongoing: ReturnType<typeof setInterval> | undefined;
  let markerTimer: ReturnType<typeof setTimeout> | undefined;
  const injected = createInjectedProcess({
    onWrite: (text, control) => {
      const marker = /!echo (__REA_COMMAND_COMPLETE_\w+)/u.exec(text)?.[1];
      if (marker === undefined) return;
      control.output("initial diagnostic\0");
      ongoing = setInterval(() => control.output("ongoing diagnostic\0"), 30);
      markerTimer = setTimeout(() => {
        clearInterval(ongoing);
        control.output(`${marker}\n\0`);
      }, 300);
    },
  });
  const manager = createRizinTestManager(
    {},
    { spawnProcess: injected.spawnProcess, frameTimeoutMs: 120 },
  );
  try {
    const started = await manager.start({
      path: "fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    if (!started.ok) throw started.error;
    const result = await manager.execute(started.value.session_id, "dr");
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({
      output: expect.stringMatching(
        /^initial diagnostic(?:\nongoing diagnostic)*$/u,
      ),
      output_truncated: true,
      completion_status: "unknown",
    });
    expect(result.value.evidence.raw_result).toEqual(result.value.result);
    expect(result.value.evidence.limitations).toContain(
      "The command timed out before its completion marker; retained output is partial and completion is unknown.",
    );
  } finally {
    clearInterval(ongoing);
    clearTimeout(markerTimer);
    injected.control.exit();
    await manager.closeAll();
  }
});

test.each(["before-overflow", "after-overflow"] as const)(
  "keeps a stdin failure primary when it occurs %s",
  async (order) => {
    const size = 1024 * 1024;
    const injected = createInjectedProcess({
      onWrite: (text, control) => {
        if (!text.includes("!echo __REA_COMMAND_COMPLETE_")) return;
        if (order === "before-overflow") control.stdinError();
        const frame = Buffer.alloc(size + 1, "x");
        frame[size] = 0;
        for (let index = 0; index < 5; index += 1) control.output(frame);
        if (order === "after-overflow") control.stdinError();
      },
    });
    const manager = createRizinTestManager(
      {},
      {
        spawnProcess: injected.spawnProcess,
        // The injected handle uses the runner PID; this test isolates protocol
        // classification from independently covered cleanup uncertainty.
        stopProcess: async () => ({ status: "stopped" }),
      },
    );
    try {
      const started = await manager.start({
        path: "fixture.bin",
        inferior_tty: await rizinTestInferiorTty(),
      });
      if (!started.ok) throw started.error;
      const result = await manager.execute(started.value.session_id, "dr");
      if (result.ok) throw new Error("Expected the stdin protocol failure");
      expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
      expect(result.error.message).toContain(
        "Rizin stdin stream failed: injected stdin error",
      );
      const evidence = toolContract("rizin_debug_command").outputSchema.parse(
        result.error.partialObservation,
      );
      expect(evidence.normalized_result).toMatchObject({
        output_truncated: true,
        completion_status: "unknown",
      });
      expect(evidence.raw_result).toEqual(evidence.normalized_result);
      const frames = evidence.normalized_result.output.split("\n");
      expect(frames.map((frame) => frame.length)).toEqual([
        size,
        size,
        size,
        size,
      ]);
      expect(frames.every((frame) => /^x+$/u.test(frame))).toBe(true);
    } finally {
      injected.control.exit();
      await manager.closeAll();
    }
  },
);

test("rejects a same-turn stdin failure after a delivered completion frame", async () => {
  let commandWritten!: (text: string) => void;
  const written = new Promise<string>((resolve) => {
    commandWritten = resolve;
  });
  const injected = createInjectedProcess({ onWrite: commandWritten });
  const manager = createRizinTestManager(
    {},
    {
      spawnProcess: injected.spawnProcess,
      stopProcess: async () => ({ status: "stopped" }),
    },
  );
  try {
    const started = await manager.start({
      path: "fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    if (!started.ok) throw started.error;
    const execution = manager.execute(started.value.session_id, "dr");
    const text = await written;
    const marker = /!echo (__REA_COMMAND_COMPLETE_\w+)/u.exec(text)?.[1];
    if (marker === undefined) throw new Error("Missing command marker");
    // Resolve the installed frame waiter, then fail stdin before its awaiting
    // parser resumes. Neither leader exit nor cancellation drives this case.
    injected.control.output(`accepted\n${marker}\n\0`);
    injected.control.stdinError();

    const result = await execution;
    if (result.ok) throw new Error("Expected the stdin protocol failure");
    expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(result.error.message).toContain(
      "Rizin stdin stream failed: injected stdin error",
    );
    const evidence = toolContract("rizin_debug_command").outputSchema.parse(
      result.error.partialObservation,
    );
    expect(evidence.normalized_result).toMatchObject({
      output: "accepted\n",
      output_truncated: false,
      completion_status: "unknown",
    });
    expect(evidence.raw_result).toEqual(evidence.normalized_result);
  } finally {
    injected.control.exit();
    await manager.closeAll();
  }
});

test("rejects a microtask stdin failure after parsed completion", async () => {
  let commandWritten!: (text: string) => void;
  const written = new Promise<string>((resolve) => {
    commandWritten = resolve;
  });
  const injected = createInjectedProcess({ onWrite: commandWritten });
  const manager = createRizinTestManager(
    {},
    {
      spawnProcess: injected.spawnProcess,
      stopProcess: async () => ({ status: "stopped" }),
    },
  );
  try {
    const started = await manager.start({
      path: "fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    if (!started.ok) throw started.error;
    const execution = manager.execute(started.value.session_id, "dr");
    const text = await written;
    const marker = /!echo (__REA_COMMAND_COMPLETE_\w+)/u.exec(text)?.[1];
    if (marker === undefined) throw new Error("Missing command marker");
    injected.control.output(`accepted\n${marker}\n\0`);
    // The resolved frame waiter parses first. The genuine fault then runs
    // before execute resumes from the parser's completed Result.
    queueMicrotask(() => injected.control.stdinError());

    const result = await execution;
    if (result.ok) throw new Error("Expected the stdin protocol failure");
    expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(result.error.message).toContain(
      "Rizin stdin stream failed: injected stdin error",
    );
    const evidence = toolContract("rizin_debug_command").outputSchema.parse(
      result.error.partialObservation,
    );
    expect(evidence.normalized_result).toMatchObject({
      output: "accepted\n",
      output_truncated: false,
      completion_status: "unknown",
    });
    expect(evidence.raw_result).toEqual(evidence.normalized_result);
  } finally {
    injected.control.exit();
    await manager.closeAll();
  }
});

test("rejects unexpected stdin close after queue overflow", async () => {
  const size = 1024 * 1024;
  let emitStdinClose: (() => void) | undefined;
  const injected = createInjectedProcess({
    onWrite: (text, control) => {
      if (!text.includes("!echo __REA_COMMAND_COMPLETE_")) return;
      const frame = Buffer.alloc(size + 1, "x");
      frame[size] = 0;
      for (let index = 0; index < 5; index += 1) control.output(frame);
      if (emitStdinClose === undefined)
        throw new Error("Missing injected stdin close control");
      // Emit close synchronously so it is observed before any cleanup starts;
      // Writable.destroy() would defer close to a later event-loop phase.
      emitStdinClose();
    },
  });
  const manager = createRizinTestManager(
    {},
    {
      spawnProcess: async (options) => {
        const launched = await injected.spawnProcess(options);
        emitStdinClose = () => launched.process.stdin?.emit("close");
        return launched;
      },
      stopProcess: async () => ({ status: "stopped" }),
    },
  );
  try {
    const started = await manager.start({
      path: "fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    if (!started.ok) throw started.error;
    const result = await manager.execute(started.value.session_id, "dr");
    if (result.ok)
      throw new Error("Expected the unexpected stdin close failure");
    expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(result.error.message).toContain(
      "Rizin stdin stream closed unexpectedly.",
    );
    const evidence = toolContract("rizin_debug_command").outputSchema.parse(
      result.error.partialObservation,
    );
    expect(evidence.normalized_result).toMatchObject({
      output_truncated: true,
      completion_status: "unknown",
    });
    expect(evidence.raw_result).toEqual(evidence.normalized_result);
    const frames = evidence.normalized_result.output.split("\n");
    expect(frames.map((frame) => frame.length)).toEqual([
      size,
      size,
      size,
      size,
    ]);
    expect(frames.every((frame) => /^x+$/u.test(frame))).toBe(true);
  } finally {
    injected.control.exit();
    await manager.closeAll();
  }
});
