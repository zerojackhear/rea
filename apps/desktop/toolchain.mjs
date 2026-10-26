import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
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

export const appSourceRoot = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(appSourceRoot, "../..");
export const toolCacheRoot = join(
  repositoryRoot,
  ".cache",
  "desktop-toolchain",
);
export const PINNED_TOOLS = Object.freeze({
  electron: Object.freeze({
    version: "44.7.0",
    filename: "electron-v44.7.0-win32-x64.zip",
    url: "https://github.com/electron/electron/releases/download/v44.7.0/electron-v44.7.0-win32-x64.zip",
    bytes: 158293649,
    sha256: "eee30dc8fa1f5ea95490e59f44e46ea68dd24c6e93d22facf70fe5c2d4c2665c",
    executable: "electron.exe",
    executableSha256:
      "2529b494f4123f152bce346051f7bd855ef95006424a561953cf17c49a3d1ba8",
  }),
  node: Object.freeze({
    version: "24.18.0",
    filename: "node-v24.18.0-win-x64.zip",
    url: "https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip",
    bytes: 37176245,
    sha256: "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
    directory: "node-v24.18.0-win-x64",
    executable: "node.exe",
    executableSha256:
      "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de",
  }),
});

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

async function downloadArchive(destination, pin) {
  let url = new URL(pin.url),
    response;
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
    response = await fetch(url, {
      redirect: "manual",
      headers: {
        "Accept-Encoding": "identity",
        "User-Agent": "REA-Desktop-Builder",
      },
      signal: AbortSignal.timeout(300000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    assert.ok(
      location && redirect < 5,
      "Tool archive redirect limit exceeded.",
    );
    url = new URL(location, url);
  }
  assert.equal(response.status, 200, "Tool ZIP download HTTP status.");
  if (response.headers.has("content-length"))
    assert.equal(
      Number(response.headers.get("content-length")),
      pin.bytes,
      "HTTP tool ZIP length mismatch.",
    );
  const partial = destination + "." + randomUUID() + ".partial";
  const output = await open(partial, "wx");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert.ok(bytes <= pin.bytes, "Tool archive exceeded its pinned length.");
      await output.writeFile(chunk);
      hash.update(chunk);
    }
  } finally {
    await output.close();
  }
  assert.equal(bytes, pin.bytes, "Incomplete tool archive.");
  assert.equal(
    hash.digest("hex"),
    pin.sha256,
    "Downloaded tool archive SHA-256 mismatch.",
  );
  await rename(partial, destination);
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
      await downloadArchive(archive, pin);
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
