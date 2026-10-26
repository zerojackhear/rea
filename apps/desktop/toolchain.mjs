import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
  win32,
} from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_TOOLS } from "./runtime-pins.mjs";

export const appSourceRoot = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(appSourceRoot, "../..");
export const toolCacheRoot = join(
  repositoryRoot,
  ".cache",
  "desktop-toolchain",
);
export { PINNED_TOOLS } from "./runtime-pins.mjs";

export function requireBuildHost() {
  assert.equal(process.platform, "win32", "Desktop assembly requires Windows.");
  assert.equal(
    process.arch,
    "x64",
    "Desktop assembly currently targets Windows x64.",
  );
  assert.equal(
    process.version,
    "v24.18.0",
    "Use the pinned Node v24.18.0 to launch or package Desktop.",
  );
}

export function parseOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    assert.ok(allowed.includes(key), "Unknown option: " + key);
    assert.equal(options[key], undefined, "Duplicate option: " + key);
    if (key === "--help" || key === "--no-zip") options[key] = true;
    else {
      assert.ok(
        args[index + 1] && !args[index + 1].startsWith("--"),
        "Missing value for " + key,
      );
      options[key] = args[++index];
    }
  }
  return options;
}

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function safeRelative(path) {
  assert.ok(
    typeof path === "string" && path.length > 0 && path.length < 4096,
    "Invalid relative path.",
  );
  assert.ok(
    !isAbsolute(path) && !win32.isAbsolute(path) && !path.includes("\\"),
    "Path must be relative POSIX: " + path,
  );
  const parts = path.split("/");
  assert.ok(
    parts.every(
      (part) =>
        part &&
        part !== "." &&
        part !== ".." &&
        !/[<>:"|?*\u0000-\u001f]/.test(part) &&
        !/[ .]$/.test(part),
    ),
    "Unsafe path: " + path,
  );
  assert.ok(
    parts.every(
      (part) =>
        ![".git", ".cache", ".codex", ".agents", ".npmrc", ".env"].includes(
          part.toLowerCase(),
        ),
    ),
    "Private source path: " + path,
  );
  assert.ok(
    parts.every(
      (part) => !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
    ),
    "Reserved Windows path: " + path,
  );
  return parts;
}

/** Resolve existing ancestors before creating anything, including junction aliases. */
export async function canonicalCreationPath(path) {
  let ancestor = resolve(path);
  const missing = [];
  for (;;) {
    let metadata;
    try {
      metadata = await lstat(ancestor);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      assert.notEqual(parent, ancestor, "No existing output ancestor: " + path);
      missing.unshift(basename(ancestor));
      ancestor = parent;
      continue;
    }
    // Do not reinterpret an unresolved symlink as a nonexistent plain directory.
    const physical = await realpath(ancestor);
    if (missing.length) {
      const resolvedMetadata = metadata.isSymbolicLink()
        ? await lstat(physical)
        : metadata;
      assert.ok(
        resolvedMetadata.isDirectory(),
        "Output ancestor is not a directory: " + ancestor,
      );
    }
    return resolve(physical, ...missing);
  }
}

/** Reject output inside a source or protected metadata before any target write. */
export async function assertOutputOutside(output, roots) {
  const fold = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const destination = fold(await canonicalCreationPath(output));
  for (const root of roots) {
    const owner = fold(await canonicalCreationPath(root));
    const prefix = owner.endsWith(sep) ? owner : owner + sep;
    assert.ok(
      destination !== owner && !destination.startsWith(prefix),
      "Output overlaps a source or protected metadata directory: " +
        output +
        " -> " +
        root,
    );
  }
}

export async function assertPackageOutputRoot(
  output,
  { repository, recursiveSources },
) {
  const metadataRoots = [
    join(repository, ".git"),
    join(repository, ".agents"),
    join(repository, ".codex"),
  ];
  const marker = join(repository, ".git");
  try {
    if ((await lstat(marker)).isFile()) {
      const entry = (await readFile(marker, "utf8")).trim();
      assert.match(
        entry,
        /^gitdir: .+$/,
        "Invalid worktree Git metadata pointer.",
      );
      const gitDirectory = resolve(repository, entry.slice("gitdir: ".length));
      metadataRoots.push(gitDirectory);
      try {
        const common = (
          await readFile(join(gitDirectory, "commondir"), "utf8")
        ).trim();
        assert.ok(
          common && !common.includes("\n"),
          "Invalid common Git metadata pointer.",
        );
        metadataRoots.push(resolve(gitDirectory, common));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await assertOutputOutside(output, [...recursiveSources, ...metadataRoots]);
}

export async function copyCheckedFile(source, target) {
  const metadata = await lstat(source);
  assert.ok(
    metadata.isFile() && !metadata.isSymbolicLink(),
    "Expected a regular source file: " + source,
  );
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target, 1);
  const digest = await sha256(target);
  assert.equal(
    await sha256(source),
    digest,
    "Source changed during copy: " + source,
  );
  const copiedBytes = (await lstat(target)).size;
  assert.equal(
    (await lstat(source)).size,
    copiedBytes,
    "Source length changed during copy: " + source,
  );
  return { source, bytes: copiedBytes, sha256: digest };
}

export async function copyTree(source, target, records = [], relative = "") {
  const metadata = await lstat(source);
  assert.ok(
    metadata.isDirectory() && !metadata.isSymbolicLink(),
    "Expected an owned regular directory: " + source,
  );
  await assertOutputOutside(target, [source]);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const path = relative ? relative + "/" + entry.name : entry.name;
    safeRelative(path);
    const from = join(source, entry.name),
      to = join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, records, path);
    else {
      assert.ok(
        entry.isFile(),
        "Links and special files are not packaged: " + from,
      );
      records.push({ path, ...(await copyCheckedFile(from, to)) });
    }
  }
  return records;
}

export function runCaptured(
  command,
  args,
  { cwd, env = process.env, timeout = 120000, limit = 16 * 1024 * 1024 } = {},
) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = { stdout: [], stderr: [] };
    const bytes = { stdout: 0, stderr: 0 };
    let fault;
    const stop = (error) => {
      fault ??= error;
      child.kill();
    };
    const timer = setTimeout(
      () => stop(new Error("Timed out: " + basename(command))),
      timeout,
    );
    for (const channel of ["stdout", "stderr"])
      child[channel].on("data", (chunk) => {
        bytes[channel] += chunk.length;
        if (bytes[channel] <= limit) chunks[channel].push(chunk);
        else
          stop(
            new Error("Build output exceeded " + limit + " bytes: " + channel),
          );
      });
    child.on("error", (error) => {
      fault ??= error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks.stdout).toString("utf8");
      const stderr = Buffer.concat(chunks.stderr).toString("utf8");
      if (fault || code !== 0)
        reject(
          new Error(
            (fault?.message ?? "Command exited " + String(code ?? signal)) +
              "\n" +
              stdout.slice(-8192) +
              stderr.slice(-8192),
          ),
        );
      else resolveRun({ stdout, stderr, code, signal });
    });
  });
}

const psLiteral = (value) => "'" + value.replaceAll("'", "''") + "'";
export async function runPowerShell(source, timeout = 120000) {
  const executable = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return runCaptured(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(source, "utf16le").toString("base64"),
    ],
    { timeout },
  );
}

async function verifyArchive(path, pin) {
  const metadata = await lstat(path);
  assert.ok(
    metadata.isFile() && !metadata.isSymbolicLink(),
    "Tool archive must be a regular file.",
  );
  assert.equal(metadata.size, pin.bytes, "Tool ZIP length mismatch: " + path);
  assert.equal(
    await sha256(path),
    pin.sha256,
    "Tool ZIP SHA-256 mismatch: " + path,
  );
}

/** Curl keeps network bodies as identity bytes; old build-Node never decompresses them. */
async function curlRaw(url, { destination, maxBytes, timeoutSeconds = 300 }) {
  const executable = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "curl.exe",
  );
  const args = [
    "-q",
    "--silent",
    "--show-error",
    "--proto",
    "=https",
    "--header",
    "Accept-Encoding: identity",
    "--connect-timeout",
    "30",
    "--max-time",
    String(timeoutSeconds),
    "--max-filesize",
    String(maxBytes),
  ];
  if (destination) args.push("--dump-header", "-", "--output", destination);
  else args.push("--head");
  args.push(url.href);
  return new Promise((resolveTransfer, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let bytes = 0,
      fault;
    const timer = setTimeout(
      () => {
        fault = new Error("Raw HTTPS transfer timeout.");
        child.kill();
      },
      (timeoutSeconds + 15) * 1000,
    );
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= 128 * 1024) chunks.push(chunk);
      else {
        fault = new Error("Raw HTTPS response headers exceeded 128 KiB.");
        child.kill();
      }
    });
    // Diagnostic text may contain signed redirect coordinates; never publish it.
    child.stderr.resume();
    child.once("error", (error) => {
      fault = new Error(
        "Could not start system curl: " + (error.code ?? error.name),
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (fault || code !== 0)
        return reject(
          fault ??
            new Error(
              "Raw HTTPS transfer failed (curl exit " +
                String(code ?? signal) +
                "); partial bytes were not admitted.",
            ),
        );
      try {
        const blocks = Buffer.concat(chunks)
          .toString("latin1")
          .split(/\r?\n\r?\n/)
          .filter((block) => /^HTTP\/[0-9.]+ [0-9]{3}/.test(block));
        assert.ok(blocks.length, "Missing raw HTTPS response status.");
        const lines = blocks.at(-1).split(/\r?\n/);
        const status = Number(
          /^HTTP\/[0-9.]+ ([0-9]{3})/.exec(lines.shift())[1],
        );
        const headers = new Headers();
        for (const line of lines) {
          const at = line.indexOf(":");
          if (at > 0)
            headers.append(line.slice(0, at), line.slice(at + 1).trim());
        }
        resolveTransfer({ status, headers });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function downloadPinnedArchive(destination, pin) {
  let url = new URL(pin.url);
  const allowed = (hostname) =>
    hostname === "nodejs.org" ||
    hostname === "github.com" ||
    hostname.endsWith(".githubusercontent.com");
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    assert.ok(
      url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        allowed(url.hostname),
      "Unexpected tool download host.",
    );
    const head = await curlRaw(url, { maxBytes: pin.bytes });
    if ([301, 302, 303, 307, 308].includes(head.status)) {
      const location = head.headers.get("location");
      assert.ok(
        location && redirect < 5,
        "Tool archive redirect limit exceeded.",
      );
      url = new URL(location, url);
      continue;
    }
    assert.equal(head.status, 200, "Tool ZIP HEAD status.");
    if (head.headers.has("content-length"))
      assert.equal(
        Number(head.headers.get("content-length")),
        pin.bytes,
        "HTTP tool ZIP length mismatch.",
      );
    assert.ok(
      !head.headers.has("content-encoding") ||
        head.headers.get("content-encoding") === "identity",
      "Encoded tool archives are not admitted.",
    );
    const partial = destination + "." + randomUUID() + ".partial";
    const response = await curlRaw(url, {
      destination: partial,
      maxBytes: pin.bytes,
    });
    if (response.status !== 200) {
      // A changed redirect may contain temporary authentication in its HTML.
      await unlink(partial);
      throw new Error(
        "Tool archive GET changed after HEAD; no bytes admitted.",
      );
    }
    if (response.headers.has("content-length"))
      assert.equal(
        Number(response.headers.get("content-length")),
        pin.bytes,
        "Tool ZIP GET length mismatch.",
      );
    assert.ok(
      !response.headers.has("content-encoding") ||
        response.headers.get("content-encoding") === "identity",
      "Encoded tool ZIP body rejected.",
    );
    const bytes = (await lstat(partial)).size;
    assert.equal(bytes, pin.bytes, "Incomplete tool archive.");
    const digest = await sha256(partial);
    assert.equal(
      digest,
      pin.sha256,
      "Downloaded tool archive SHA-256 mismatch.",
    );
    await rename(partial, destination);
    return {
      bytes,
      sha256: digest,
      source: pin.url,
      finalOrigin: url.origin,
      rawIdentityTransfer: true,
    };
  }
  throw new Error("Tool archive redirect limit exceeded.");
}

async function extractPinnedZip(archive, destination) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$archive=" + psLiteral(archive),
    "$destination=" + psLiteral(destination),
    "$zip=[IO.Compression.ZipFile]::OpenRead($archive)",
    '$seen=New-Object "Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)',
    "$total=[int64]0",
    "$count=0",
    "try { foreach($entry in $zip.Entries) {",
    '$count++; if($count -gt 20000){throw "Too many ZIP entries"}',
    "$path=$entry.FullName.Replace([char]92,[char]47)",
    'if($path.StartsWith("/") -or $path.Contains(":")){throw "Absolute or ADS ZIP entry"}',
    '$trimmed=$path.TrimEnd([char]47); if(!$trimmed){throw "Empty ZIP entry"}',
    '$parts=$trimmed.Split([char]47); foreach($part in $parts){if(!$part -or $part -eq "." -or $part -eq ".." -or $part -match "[ .]$" -or $part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0){throw "Unsafe ZIP entry"}}',
    'if(!$seen.Add($trimmed)){throw "Duplicate ZIP entry"}',
    'if((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw "Symlink ZIP entry"}',
    '$total += $entry.Length; if($total -gt 2147483648){throw "ZIP expansion budget exceeded"}',
    "}} finally {$zip.Dispose()}",
    "[IO.Compression.ZipFile]::ExtractToDirectory($archive,$destination)",
  ].join("\n");
  await runPowerShell(script, 180000);
}

export async function prepareTool(name, suppliedArchive) {
  const pin = PINNED_TOOLS[name];
  assert.ok(pin, "Unknown pinned tool.");
  await mkdir(toolCacheRoot, { recursive: true });
  const archive = suppliedArchive
    ? resolve(suppliedArchive)
    : join(toolCacheRoot, pin.filename);
  if (!suppliedArchive) {
    try {
      await lstat(archive);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      console.log("Downloading pinned " + name + " " + pin.version);
      await downloadPinnedArchive(archive, pin);
    }
  }
  await verifyArchive(archive, pin);
  const extraction = await mkdtemp(join(toolCacheRoot, name + "-"));
  await extractPinnedZip(archive, extraction);
  const runtime = pin.directory ? join(extraction, pin.directory) : extraction;
  const executable = join(runtime, pin.executable);
  assert.equal(
    await sha256(executable),
    pin.executableSha256,
    "Extracted tool executable SHA mismatch.",
  );
  return {
    runtime,
    executable,
    receipt: {
      version: pin.version,
      archive,
      archiveBytes: pin.bytes,
      archiveSha256: pin.sha256,
      officialUrl: pin.url,
      executableSha256: pin.executableSha256,
      extraction,
      verification:
        "Complete pinned ZIP length/SHA, safe fresh extraction, and executable SHA; no new signature verification.",
    },
  };
}

export async function writePortableZip(directory, archive) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "[IO.Compression.ZipFile]::CreateFromDirectory(" +
      psLiteral(directory) +
      "," +
      psLiteral(archive) +
      ",[IO.Compression.CompressionLevel]::Optimal,$false)",
  ].join("\n");
  await runPowerShell(script, 600000);
  return {
    path: archive,
    bytes: (await lstat(archive)).size,
    sha256: await sha256(archive),
  };
}
