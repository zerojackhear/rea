import { describe, expect, it } from "vitest";

import { isRizinCommandDeadlineExpired } from "../../../src/rizin/RizinDebugSessionManager.js";
import { absoluteCallerPath } from "../../../src/filesystem/callerPath.js";
import { createInjectedProcess } from "./RizinDebugSessionCoverage.fixtures.js";
import {
  createRizinTestManager,
  rizinTestInferiorTty,
} from "./RizinTestInferiorTty.js";

describe("Rizin command timeout semantics", () => {
  it("treats zero and negative remaining time as expired", () => {
    expect(isRizinCommandDeadlineExpired(1)).toBe(false);
    expect(isRizinCommandDeadlineExpired(0)).toBe(true);
    expect(isRizinCommandDeadlineExpired(-1)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "retains consumed frames and unfinished bytes when the command deadline expires",
    async () => {
      const injected = createInjectedProcess({
        onWrite: (text, control) => {
          if (text.includes("!echo __REA_COMMAND_COMPLETE_"))
            control.output(
              "first frame\0second frame\0unfinished diagnostic Ω",
            );
        },
      });
      const manager = createRizinTestManager(
        {},
        { spawnProcess: injected.spawnProcess, frameTimeoutMs: 100 },
      );
      try {
        const inferiorTty = await rizinTestInferiorTty();
        const started = await manager.start({
          path: "fixture.bin",
          inferior_tty: inferiorTty,
        });
        if (!started.ok) throw started.error;
        const result = await manager.execute(started.value.session_id, "dr");
        if (!result.ok) throw result.error;

        expect(result.value.result).toMatchObject({
          output: "first frame\nsecond frame\nunfinished diagnostic Ω",
          output_truncated: true,
          completion_status: "unknown",
        });
        expect(result.value.evidence.raw_result).toEqual(result.value.result);
        expect(result.value.evidence.normalized_result).toEqual(
          result.value.result,
        );
        expect(result.value.evidence.limitations).toContain(
          "The command timed out before its completion marker; retained output is partial and completion is unknown.",
        );
        expect(result.value.evidence.subject).toBeNull();
        expect(result.value.evidence.parameters).toEqual({
          session_id: started.value.session_id,
          command: "dr",
          inferior_tty: inferiorTty,
          launch_provenance: {
            caller_selected_path: "fixture.bin",
            resolved_path: absoluteCallerPath("fixture.bin"),
          },
        });
        expect(result.value.evidence.limitations).toContain(
          "The current debugger target identity is not established by the Rizin session identifier.",
        );
        expect(manager.status(started.value.session_id)).toEqual({
          session_id: started.value.session_id,
          state: "closed",
          inferior_tty: inferiorTty,
          recent_output: ["", "first frame", "second frame"],
          recent_output_truncated: false,
          diagnostics_truncated: false,
          output_invalid_utf8: false,
        });
      } finally {
        injected.control.exit();
        await manager.closeAll();
      }
    },
  );
});
