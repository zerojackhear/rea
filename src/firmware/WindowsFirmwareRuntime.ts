import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { z } from "zod";
import { windowsPrivateRuntime } from "../windows/WindowsPrivateRuntime.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import { hashFirmwareFile } from "./FirmwareFiles.js";

const fileSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(512 * 1024 ** 2),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  files: z.array(fileSchema).min(1).max(8192),
});

/** Validate the caller's runtime inventory before creating any executable copy. */
export const parseWindowsFirmwareManifest = (value: unknown) => {
  const manifest = manifestSchema.parse(value);
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of manifest.files) {
    const parts = file.path.split("/");
    if (
      parts.length > 32 ||
      parts.some(
        (part) =>
          !/^[A-Za-z0-9_.+ ()-]+$/u.test(part) ||
          part === "." ||
          part === ".." ||
          /[. ]$/u.test(part) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part),
      )
    )
      throw new Error(`Unsafe Windows runtime coordinate: ${file.path}`);
    const key = file.path.toLowerCase();
    if (paths.has(key))
      throw new Error(`Aliased Windows runtime coordinate: ${file.path}`);
    paths.add(key);
    bytes += file.bytes;
    if (bytes > 512 * 1024 ** 2)
      throw new Error("Windows runtime exceeds the 512 MiB admission budget");
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++)
      if (paths.has(parts.slice(0, index).join("/")))
        throw new Error(`Runtime file is also used as a directory: ${path}`);
  }
  if (!paths.has("python.exe"))
    throw new Error("Windows Unblob runtime has no python.exe entry");
  return manifest;
};

/** Snapshot a complete caller-supplied Python runtime, then seal it before launch. */
export const prepareWindowsFirmwareRuntime = async (
  rootPath: string,
  configuredCommand: string,
  commandSha256: string,
  inputPath: string,
  signal: AbortSignal,
) => {
  if (basename(configuredCommand).toLowerCase() !== "python.exe")
    throw new Error(
      "Windows Unblob requires its admitted runtime's python.exe and adjacent rea-unblob-runtime.json",
    );
  const owner = windowsPrivateRuntime(rootPath);
  if (owner === undefined)
    throw new Error("Windows firmware workspace has no native owner");
  const sourceRoot = dirname(configuredCommand);
  const manifestPath = join(sourceRoot, "rea-unblob-runtime.json");
  const handle = await open(manifestPath, "r");
  let bytes: Buffer | undefined;
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Windows runtime manifest is not a regular file");
    bytes = await readBoundedFileBytes(handle, 4 * 1024 ** 2, signal);
  } finally {
    await handle.close();
  }
  if (bytes === undefined)
    throw new Error(
      "Windows runtime manifest exceeds its 4 MiB admission budget",
    );
  const manifest = parseWindowsFirmwareManifest(
    JSON.parse(bytes.toString("utf8")) as unknown,
  );
  if (
    manifest.files.find((file) => file.path.toLowerCase() === "python.exe")
      ?.sha256 !== commandSha256
  )
    throw new Error(
      "Configured Python executable differs from the runtime inventory",
    );
  const directories = new Set<string>();
  const mkdir = (path: string): void => {
    if (path === "." || directories.has(path)) return;
    mkdir(dirname(path));
    owner.mkdir(path);
    directories.add(path);
  };
  mkdir("engine");
  mkdir("input");
  mkdir("output");
  for (const file of manifest.files) {
    signal.throwIfAborted();
    const destination = join("engine", file.path);
    mkdir(dirname(destination));
    const observed = await owner.snapshot(
      join(sourceRoot, file.path),
      destination,
      signal,
      file.bytes,
    );
    if (
      observed.sha256 !== file.sha256 ||
      observed.snapshot.size !== file.bytes
    )
      throw new Error(
        `Windows runtime bytes differ from their inventory: ${file.path}`,
      );
  }
  const input = await owner.snapshot(
    inputPath,
    "input/firmware.bin",
    signal,
    128 * 1024 ** 2,
  );
  const isolation = owner.prepareAppContainer();
  // Snapshot writers become deny-write readers during sealing. Rehash through
  // those retained leases before exposing any launch authority to the provider.
  for (const file of manifest.files) {
    if (
      (await hashFirmwareFile(join(rootPath, "engine", file.path), signal)) !==
      file.sha256
    )
      throw new Error(`Windows runtime changed during sealing: ${file.path}`);
  }
  const admittedInput = join(rootPath, "input", "firmware.bin");
  if ((await hashFirmwareFile(admittedInput, signal)) !== input.sha256)
    throw new Error("Windows firmware input changed during sealing");
  return {
    command: join(rootPath, "engine", relative(sourceRoot, configuredCommand)),
    args: ["-I", "-B", "-X", "utf8", "-m", "unblob.cli"],
    inputPath: admittedInput,
    outputPath: join(rootPath, "output"),
    handle: owner.observation.handle,
    evidence: {
      manifest_path: manifestPath,
      manifest_sha256: createHash("sha256").update(bytes).digest("hex"),
      manifest,
      isolation,
      provenance:
        "caller-supplied inventory; exact copied bytes verified, publisher identity not authenticated",
    },
  };
};
