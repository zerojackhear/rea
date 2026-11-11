import { describe, expect, it } from "vitest";
import { parseRizinInferiorRows } from "../../../src/rizin/RizinDebugSessionManager.js";

const row = (uri: string, raised = true) =>
  JSON.stringify([{ fd: 3, raised, uri }]);

describe("Rizin debugger inventory identity", () => {
  it.each(["w32dbg", "attach"])(
    "recognizes %s as a Windows inferior",
    (scheme) => {
      expect(parseRizinInferiorRows(row(`${scheme}://123`), "win32")).toEqual([
        ["3", "123"],
      ]);
    },
  );
  it("preserves Linux ptrace identity", () => {
    expect(parseRizinInferiorRows(row("ptrace://123"), "linux")).toEqual([
      ["3", "123"],
    ]);
  });
  it.each([
    "w32dbg://0",
    "w32dbg://4294967296",
    "w32dbg://bad",
    "ptrace://123",
    "gdb://remote",
    "malloc://16",
  ])("does not turn unknown Windows descriptor %s into no-inferior", (uri) => {
    expect(() => parseRizinInferiorRows(row(uri), "win32")).toThrow();
  });
  it("rejects inactive debugger rows", () => {
    expect(() =>
      parseRizinInferiorRows(row("w32dbg://123", false), "win32"),
    ).toThrow(/not active/u);
  });
  it("does not ignore Windows debugger rows on Linux", () => {
    expect(() =>
      parseRizinInferiorRows(row("w32dbg://123"), "linux"),
    ).toThrow();
  });
  it("permits an empty inventory or ordinary file descriptor", () => {
    expect(parseRizinInferiorRows("[]", "win32")).toEqual([]);
    expect(
      parseRizinInferiorRows(row("file:///C:/target.exe"), "win32"),
    ).toEqual([]);
  });
  it("retains all debugger rows so callers can refuse ambiguous ownership", () => {
    expect(
      parseRizinInferiorRows(
        JSON.stringify([
          { fd: 3, raised: true, uri: "w32dbg://123" },
          { fd: 4, raised: true, uri: "attach://456" },
        ]),
        "win32",
      ),
    ).toHaveLength(2);
  });
});
