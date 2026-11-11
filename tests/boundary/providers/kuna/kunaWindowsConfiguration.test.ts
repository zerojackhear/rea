import { join } from "node:path";
import { expect, it } from "vitest";
import { readKunaConfiguration } from "../../../../src/kuna/KunaConfiguration.js";
import { kunaChildEnvironment } from "../../../../src/kuna/KunaInstallation.js";

it("keeps the Windows provider cache and its fallback under caller-selected local data", () => {
  const home = join(process.cwd(), "caller home");
  const local = join(home, "local data");
  const settings = {
    REA_KUNA_COMMAND: process.execPath,
    USERPROFILE: home,
    LOCALAPPDATA: local,
  };
  const result = readKunaConfiguration(settings, "win32");
  expect(result).toMatchObject({
    ok: true,
    value: { cacheRoot: join(local, "rea", "kuna") },
  });
  expect(
    readKunaConfiguration({ ...settings, LOCALAPPDATA: "relative" }, "win32"),
  ).toMatchObject({
    ok: true,
    value: { cacheRoot: join(home, "AppData", "Local", "rea", "kuna") },
  });
});

it.skipIf(process.platform !== "win32")(
  "keeps Windows embedded-spec and temporary fallbacks in the owned cache",
  () => {
    const cache = join(process.cwd(), "private cache");
    const result = readKunaConfiguration(
      { REA_KUNA_COMMAND: process.execPath, REA_KUNA_CACHE_DIR: cache },
      "win32",
    );
    if (!result.ok) throw new Error(result.error.reason);
    const env = kunaChildEnvironment(result.value);
    expect(env.LOCALAPPDATA).toBe(join(cache, "home", "AppData", "Local"));
    expect(env.TEMP).toBe(join(cache, "home", "tmp"));
    expect(env.TMP).toBe(env.TEMP);
    expect(env.PATH).toBeUndefined();
  },
);
