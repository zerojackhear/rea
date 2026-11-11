import { describe, expect, it } from "vitest";
import { parseWindowsFirmwareManifest } from "../../src/firmware/WindowsFirmwareRuntime.js";

const file = (path: string, bytes = 1) => ({
  path,
  bytes,
  sha256: "a".repeat(64),
});
const inventory = (...files: ReturnType<typeof file>[]) => ({
  schemaVersion: 1,
  files: [file("python.exe"), ...files],
});

describe("Windows firmware runtime admission", () => {
  it("accepts package paths including the real setuptools template name", () => {
    expect(
      parseWindowsFirmwareManifest(
        inventory(file("Lib/site-packages/setuptools/script (dev).tmpl")),
      ).files,
    ).toHaveLength(2);
  });
  it.each([
    "../outside.dll",
    "C:/outside.dll",
    "Lib\\outside.dll",
    "Lib//x.py",
    "Lib/file:stream",
    "Lib/NUL.txt",
    "Lib/com1",
    "Lib/x. ",
    "Lib/ends.",
    "Lib/shortn~1.dll",
    "Lib/raw\0hidden",
    "Lib/./x.py",
  ])("rejects Windows namespace reinterpretation: %s", (path) => {
    expect(() => parseWindowsFirmwareManifest(inventory(file(path)))).toThrow();
  });
  it("rejects case aliases and file/directory collisions before snapshotting", () => {
    expect(() =>
      parseWindowsFirmwareManifest(
        inventory(file("Lib/a.py"), file("lib/A.py")),
      ),
    ).toThrow(/Aliased/u);
    expect(() =>
      parseWindowsFirmwareManifest(inventory(file("Lib"), file("Lib/a.py"))),
    ).toThrow(/directory/u);
  });
  it("bounds total admitted bytes independently of per-file limits", () => {
    expect(() =>
      parseWindowsFirmwareManifest(inventory(file("a.dll", 512 * 1024 ** 2))),
    ).toThrow(/budget/u);
  });
  it("requires an executable entry and a complete supported schema", () => {
    expect(() =>
      parseWindowsFirmwareManifest({
        schemaVersion: 1,
        files: [file("Lib/a.py")],
      }),
    ).toThrow(/python.exe/u);
    expect(() =>
      parseWindowsFirmwareManifest({ ...inventory(), noSandbox: true }),
    ).toThrow();
  });
});
