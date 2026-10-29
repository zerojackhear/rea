import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  assertOutputOutside,
  assertPackageOutputRoot,
  copyTree,
  safeRelative,
} from "./toolchain.mjs";

async function fixture(t) {
  const base = resolve(tmpdir());
  const root = await mkdtemp(join(base, "rea-desktop-toolchain-"));
  t.after(async () => {
    const absolute = resolve(root);
    assert.ok(
      absolute.startsWith(base + sep),
      "Cleanup stays inside the created temp root parent",
    );
    const metadata = await lstat(absolute);
    assert.ok(
      metadata.isDirectory() && !metadata.isSymbolicLink(),
      "Cleanup root remains the owned plain directory",
    );
    await rm(absolute, { recursive: true });
  });
  const source = join(root, "renderer");
  await mkdir(source);
  await writeFile(join(source, "index.html"), "self-owned desktop fixture\n");
  return { root, source };
}

async function absent(path) {
  await assert.rejects(
    lstat(path),
    { code: "ENOENT" },
    "Rejected copies create no output directory",
  );
}

test("copyTree rejects its own source before writing", async (t) => {
  const { source } = await fixture(t);
  await assert.rejects(copyTree(source, source), /Output overlaps/);
  assert.deepEqual(await readdir(source), ["index.html"]);
  assert.equal(
    await readFile(join(source, "index.html"), "utf8"),
    "self-owned desktop fixture\n",
  );
});

test("copyTree rejects a nonexistent output nested inside the source before mkdir", async (t) => {
  const { source } = await fixture(t);
  const output = join(source, "new-delivery", "resources", "app", "renderer");
  await assert.rejects(copyTree(source, output), /Output overlaps/);
  await absent(join(source, "new-delivery"));
  assert.deepEqual(await readdir(source), ["index.html"]);
});

test("copyTree rejects a junction-alias output before writing", async (t) => {
  const { root, source } = await fixture(t);
  const alias = join(root, "source-alias");
  await symlink(source, alias, "junction");
  await assert.rejects(
    copyTree(source, join(alias, "new-delivery")),
    /Output overlaps/,
  );
  await absent(join(source, "new-delivery"));
  assert.deepEqual(await readdir(source), ["index.html"]);
});

test(
  "copyTree rejects a case-alias source descendant on Windows",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { source } = await fixture(t);
    await assert.rejects(
      copyTree(source, join(source.toUpperCase(), "new-delivery")),
      /Output overlaps/,
    );
    await absent(join(source, "new-delivery"));
  },
);

test("copyTree permits sibling destinations sharing a source-name prefix", async (t) => {
  const { root, source } = await fixture(t);
  const output = join(root, "renderer-delivery");
  const records = await copyTree(source, output);
  assert.equal(records.length, 1);
  assert.equal(records[0].path, "index.html");
  assert.equal(
    await readFile(join(output, "index.html"), "utf8"),
    "self-owned desktop fixture\n",
  );
  assert.equal(
    await readFile(join(source, "index.html"), "utf8"),
    "self-owned desktop fixture\n",
  );
});

test("unresolved dangling junction output fails without creating its target", async (t) => {
  const { root, source } = await fixture(t);
  const missing = join(root, "missing-target");
  const alias = join(root, "dangling-alias");
  await symlink(missing, alias, "junction");
  await assert.rejects(copyTree(source, join(alias, "output")));
  await absent(missing);
});

test("package output rejects renderer/examples sources while allowing task delivery and external folders", async (t) => {
  const { root, source } = await fixture(t);
  const examples = join(root, "examples");
  await mkdir(examples);
  const config = { repository: root, recursiveSources: [source, examples] };
  for (const owner of [source, examples]) {
    await assert.rejects(
      assertPackageOutputRoot(join(owner, "new-delivery"), config),
      /Output overlaps/,
    );
    await absent(join(owner, "new-delivery"));
  }
  const alias = join(root, "examples-alias");
  await symlink(examples, alias, "junction");
  await assert.rejects(
    assertPackageOutputRoot(join(alias, "new-delivery"), config),
    /Output overlaps/,
  );
  await assertPackageOutputRoot(
    join(root, ".cache", "desktop-deliveries"),
    config,
  );
  await assertPackageOutputRoot(join(root, "external-deliveries"), config);
  await absent(join(root, ".cache"));
  await absent(join(root, "external-deliveries"));
});

test("package output protects worktree and common Git metadata aliases", async (t) => {
  const { root, source } = await fixture(t);
  const repository = join(root, "repository");
  const common = join(root, "git-common");
  const gitDirectory = join(common, "worktrees", "fixture");
  await mkdir(repository);
  await mkdir(gitDirectory, { recursive: true });
  await writeFile(join(repository, ".git"), "gitdir: " + gitDirectory + "\n");
  await writeFile(join(gitDirectory, "commondir"), "../..\n");
  const alias = join(root, "git-alias");
  await symlink(common, alias, "junction");
  const config = { repository, recursiveSources: [source] };
  for (const parent of [
    common,
    gitDirectory,
    alias,
    join(repository, ".agents"),
    join(repository, ".codex"),
  ]) {
    await assert.rejects(
      assertPackageOutputRoot(join(parent, "new-delivery"), config),
      /Output overlaps/,
    );
    await absent(join(parent, "new-delivery"));
  }
  assert.equal(
    await readFile(join(gitDirectory, "commondir"), "utf8"),
    "../..\n",
  );
});

test("output guard does not confuse an ancestor or unrelated sibling with a source descendant", async (t) => {
  const { root, source } = await fixture(t);
  await assertOutputOutside(root, [source]);
  await assertOutputOutside(join(root, "renderer-out"), [source]);
  for (const path of [
    "../outside",
    "C:/outside",
    "x\\outside",
    ".git/config",
    "x/.npmrc",
    "x/.env",
    "CON",
    "a/NUL.txt",
  ]) {
    assert.throws(() => safeRelative(path));
  }
});
