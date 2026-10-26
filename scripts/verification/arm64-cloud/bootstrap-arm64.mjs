#!/usr/bin/env node
// Bounded, private toolchain setup for the manually dispatched ARM64 producer lane.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const PINS = Object.freeze({
  source_head: 'c19c2d6723fb92548b0c8a1ed0696d721a80aae6',
  source_tree: 'd6405587116af64c4d9bac2216525dc68cc262fc',
  go: 'go1.27.2', rust: '1.99.1', cargo_auditable: '0.7.7',
});
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--root', '--fixtures', '--artifacts-dir', '--out'].includes(args[i]) || !args[i + 1] || options[args[i]]) {
    throw new Error('Usage: bootstrap-arm64.mjs --root ROOT --fixtures FIXTURES --artifacts-dir DIR --out OUT');
  }
  options[args[i]] = path.resolve(args[i + 1]);
}
if (Object.keys(options).length !== 4) throw new Error('Required: --root ROOT --fixtures FIXTURES --artifacts-dir DIR --out OUT');
const root = options['--root'];
const fixtureRoot = options['--fixtures'];
const artifacts = options['--artifacts-dir'];
const output = options['--out'];
const privateRoot = path.join(artifacts, 'toolchains');
const logs = path.join(artifacts, 'bootstrap-logs');
const downloads = path.join(artifacts, 'bootstrap-downloads');
await Promise.all([mkdir(privateRoot, { recursive: true }), mkdir(logs, { recursive: true }), mkdir(downloads, { recursive: true }), mkdir(path.dirname(output), { recursive: true })]);
const report = {
  schema_version: 1, status: 'running', ...PINS, started_at: new Date().toISOString(),
  native_os: process.platform === 'win32' ? 'windows' : process.platform,
  native_arch: 'unknown', node_process_arch: process.arch, node_version: process.version,
  root, artifacts_dir: artifacts, commands: [], downloads: [], toolchains: {}, builds: {},
  os: { release: os.release(), version: os.version(), machine: os.machine() },
  runner: Object.fromEntries(['RUNNER_OS', 'RUNNER_ARCH', 'ImageOS', 'ImageVersion', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  cleanup_scope: 'Direct child handle and streams only; no process-family ownership claim',
};
let sequence = 0;
let env = { ...process.env };
const windows = process.platform === 'win32';
const exe = windows ? '.exe' : '';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const save = async () => writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const exists = async (file) => access(file).then(() => true, () => false);
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const info = await stat(file);
  return { path: await realpath(file), size: info.size, sha256: hash.digest('hex') };
}
async function fixtureSnapshot(directory) {
  const records = [];
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      ensure(!entry.isSymbolicLink(), 'Fixture symlinks are not allowed');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const record = await digest(file);
        records.push({ ...record, path: path.relative(directory, file).split(path.sep).join('/') });
      }
    }
  }
  await visit(directory);
  return records;
}
async function command(label, file, commandArgs, { cwd = root, timeout = 60_000, allowFailure = false, environment = env, windowsVerbatimArguments = false } = {}) {
  const name = `${String(++sequence).padStart(3, '0')}-${label}`;
  const item = { label, executable: file, args: commandArgs, cwd, timeout_ms: timeout, started_at: new Date().toISOString(), stdout: path.join(logs, `${name}.stdout.log`), stderr: path.join(logs, `${name}.stderr.log`), status: 'running' };
  report.commands.push(item);
  await save();
  // Persist raw output with a bound; never persist the inherited environment.
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), bytes = 0;
  const started = Date.now();
  const child = spawn(file, commandArgs, { cwd, env: environment, shell: false, windowsHide: true, windowsVerbatimArguments, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
  let forcedReason;
  const terminate = (reason) => {
    if (forcedReason) return;
    forcedReason = reason;
    child.kill('SIGKILL');
  };
  const collect = (stream) => (chunk) => {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024) return terminate('output_limit');
    if (stream === 'stdout') stdout = Buffer.concat([stdout, chunk]);
    else stderr = Buffer.concat([stderr, chunk]);
  };
  child.stdout.on('data', collect('stdout'));
  child.stderr.on('data', collect('stderr'));
  const timer = setTimeout(() => terminate('timeout'), timeout);
  let hardDeadline;
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
    hardDeadline = setTimeout(() => {
      terminate('timeout');
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      resolve({ code: null, signal: null, error: 'Process tree did not close within kill grace period' });
    }, timeout + 10_000);
  });
  clearTimeout(timer); clearTimeout(hardDeadline);
  Object.assign(item, result, { elapsed_ms: Date.now() - started, status: forcedReason ?? (result.code === 0 ? 'passed' : 'failed') });
  await Promise.all([writeFile(item.stdout, stdout), writeFile(item.stderr, stderr)]);
  await writeFile(path.join(logs, `${name}.command.json`), `${JSON.stringify(item, null, 2)}\n`);
  await save();
  if (!allowFailure && (result.code !== 0 || forcedReason)) { console.error(`[${label}] stdout tail:\n${stdout.toString('utf8').slice(-16000)}\nstderr tail:\n${stderr.toString('utf8').slice(-16000)}`); throw new Error(`${label}: ${forcedReason ?? result.error ?? `exit ${result.code}`} (see ${item.stderr})`); }
  return { ...result, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), log: item };
}
async function download(label, url, { limit = 16 * 1024 * 1024, timeout = 120_000 } = {}) {
  const destination = path.join(downloads, label);
  const entry = { url, path: destination, limit_bytes: limit, timeout_ms: timeout, started_at: new Date().toISOString(), status: 'running' };
  report.downloads.push(entry);
  const chunks = [];
  let bytes = 0;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'follow' });
    const final = new URL(response.url);
    ensure(final.protocol === 'https:' && ['go.dev', 'dl.google.com', 'static.rust-lang.org'].includes(final.hostname), `Untrusted redirect: ${response.url}`);
    Object.assign(entry, { final_url: response.url, http_status: response.status, declared_length: response.headers.get('content-length'), content_type: response.headers.get('content-type') });
    if (entry.declared_length !== null) ensure(/^\d+$/.test(entry.declared_length) && Number(entry.declared_length) <= limit, `${label}: declared length exceeds bound`);
    for await (const chunk of response.body) {
      bytes += chunk.length;
      ensure(bytes <= limit, `${label}: response exceeds bound`);
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    await writeFile(destination, body);
    Object.assign(entry, { size: bytes, sha256: sha256(body) });
    ensure(response.ok, `${label}: HTTP ${response.status}`);
    if (entry.declared_length !== null && !response.headers.get('content-encoding')) ensure(Number(entry.declared_length) === bytes, `${label}: incomplete response`);
    entry.status = 'passed';
    await save();
    return { bytes: body, metadata: entry };
  } catch (error) {
    entry.status = 'failed'; entry.error = String(error);
    if (error?.cause) entry.error_cause = { message: error.cause.message, code: error.cause.code };
    if (chunks.length) await writeFile(destination, Buffer.concat(chunks));
    await save();
    throw error;
  }
}
function expectedHash(bytes) {
  const value = bytes.toString('utf8').trim().split(/\s+/)[0];
  ensure(/^[a-f0-9]{64}$/.test(value), 'Official SHA256 response is malformed');
  return value;
}
// Only parse the exact simple [pkg.NAME.target.TRIPLE] sections used below.
// Do not treat an absent field or a different target as usable.
function rustSections(text) {
  const result = new Map();
  let current;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\[([^\]]+)\]\s*$/.exec(line.trim());
    if (section) { current = {}; result.set(section[1], current); continue; }
    const field = /^([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false)\s*(?:#.*)?$/.exec(line.trim());
    if (current && field) current[field[1]] = field[2] === 'true' ? true : field[2] === 'false' ? false : JSON.parse(field[2]);
  }
  return result;
}
async function locate(commandName) {
  const result = windows
    ? await command(`locate-${commandName}`, 'where.exe', [commandName], { allowFailure: true })
    : await command(`locate-${commandName}`, '/bin/sh', ['-c', 'command -v "$1"', 'sh', commandName], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
}
async function configureLinker() {
  if (!windows) {
    const cc = await locate('cc');
    ensure(cc, 'Native C linker cc is missing; runner prerequisite must be provided');
    const version = await command('native-linker-version', cc, ['--version']);
    const machine = (await command('native-linker-target', cc, ['-dumpmachine'])).stdout.trim();
    ensure(/^aarch64[-]/.test(machine), `Runner C compiler is not native ARM64: ${machine}`);
    return { executable: await digest(cc), version: version.stdout.trim(), target: machine, source: 'runner preinstalled C compiler' };
  }
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  ensure(await exists(vswhere), 'Preinstalled VS vswhere.exe is missing; no global installer is allowed');
  const located = await command('vswhere-arm64', vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.ARM64', '-property', 'installationPath']);
  const installation = located.stdout.trim();
  ensure(installation && !/[\r\n"]/.test(installation), 'VS ARM64 tools were not located');
  const vsDevCmd = path.join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
  ensure(await exists(vsDevCmd), 'VS developer command script is missing');
  // set NAME emits matching names only. Never log `set` without a whitelist.
  const keys = ['VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSDKVersion', 'VSCMD_ARG_TGT_ARCH'];
  const setup = `call "${vsDevCmd}" -arch=arm64 -host_arch=arm64 -no_logo && (${keys.map((key) => `set ${key}`).join(' & ')})`;
  const vars = await command('vs-arm64-environment', process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', setup], { windowsVerbatimArguments: true, environment: { ...env, VSCMD_DEBUG: '0', VSCMD_SKIP_SENDTELEMETRY: '1' } });
  for (const line of vars.stdout.split(/\r?\n/)) {
    const split = line.indexOf('=');
    const key = keys.find((name) => name.toLowerCase() === line.slice(0, split).toLowerCase());
    if (split > 0 && key) env[key] = line.slice(split + 1);
  }
  ensure(env.VSCMD_ARG_TGT_ARCH === 'arm64', 'MSVC target environment is not ARM64');
  ensure(env.VCToolsInstallDir && env.WindowsSdkDir && env.WindowsSDKVersion, 'MSVC/SDK directory metadata is missing');
  const toolBin = path.join(env.VCToolsInstallDir, 'bin', 'Hostarm64', 'arm64');
  const linker = path.join(toolBin, 'link.exe');
  ensure(await exists(linker), 'Native ARM64 MSVC linker is missing');
  const sdkVersion = env.WindowsSDKVersion.replace(/[\\/]+$/, '');
  const libraries = [path.join(env.VCToolsInstallDir, 'lib', 'arm64'), path.join(env.WindowsSdkDir, 'Lib', sdkVersion, 'ucrt', 'arm64'), path.join(env.WindowsSdkDir, 'Lib', sdkVersion, 'um', 'arm64')];
  for (const library of libraries) ensure(await exists(library), `ARM64 library directory missing: ${library}`);
  env.LIB = libraries.join(';');
  env.LIBPATH = env.LIB;
  env.INCLUDE = [path.join(env.VCToolsInstallDir, 'include'), ...['ucrt', 'shared', 'um', 'winrt'].map((part) => path.join(env.WindowsSdkDir, 'Include', sdkVersion, part))].join(';');
  env.PATH = [toolBin, path.join(env.WindowsSdkDir, 'bin', sdkVersion, 'arm64'), env.PATH ?? env.Path ?? ''].join(';');
  const version = await command('native-msvc-version', path.join(path.dirname(linker), 'cl.exe'), [], { allowFailure: true });
  return { executable: await digest(linker), version: `${version.stdout}${version.stderr}`.trim(), installation, vswhere: await digest(vswhere), vc_tools_directory: env.VCToolsInstallDir, windows_sdk_directory: env.WindowsSdkDir, windows_sdk_version: env.WindowsSDKVersion, source: 'runner preinstalled VS ARM64 tools and Windows SDK' };
}

try {
  ensure(['win32', 'linux'].includes(process.platform), `Unsupported native OS: ${process.platform}`);
  const native = windows
    ? await command('native-os-architecture', 'pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()'])
    : await command('native-os-architecture', 'uname', ['-m']);
  ensure(/^(arm64|aarch64)$/i.test(native.stdout.trim()), `Native OS is not ARM64: ${native.stdout.trim()} (Node ${process.arch})`);
  report.native_arch = 'arm64';
  const target = windows ? 'aarch64-pc-windows-msvc' : 'aarch64-unknown-linux-gnu';
  report.rust_target = target;
  const head = (await command('source-head', 'git', ['rev-parse', 'HEAD'])).stdout.trim();
  ensure(head === PINS.source_head, 'Runtime checkout is not the pinned source HEAD');
  const sourceTree = (await command('source-tree', 'git', ['rev-parse', `${PINS.source_head}^{tree}`])).stdout.trim();
  ensure(sourceTree === PINS.source_tree, 'Pinned source tree mismatch');
  await command('source-ancestry', 'git', ['merge-base', '--is-ancestor', PINS.source_head, 'HEAD']);
  report.runtime_head = head;

  const cargoHome = path.join(privateRoot, 'cargo');
  const rustupHome = path.join(privateRoot, 'rustup');
  const installRoot = path.join(privateRoot, 'cargo-auditable');
  const targetDir = path.join(privateRoot, 'cargo-target');
  const goCache = path.join(privateRoot, 'go-cache');
  const goPath = path.join(privateRoot, 'go-path');
  await Promise.all([cargoHome, rustupHome, installRoot, targetDir, goCache, goPath].map((directory) => mkdir(directory, { recursive: true })));
  env = { ...env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome, CARGO_TARGET_DIR: targetDir, GOPATH: goPath, GOCACHE: goCache, GOTOOLCHAIN: 'local', GOOS: report.native_os, GOARCH: 'arm64', CGO_ENABLED: '0', RUSTUP_DIST_SERVER: 'https://static.rust-lang.org', RUSTUP_UPDATE_ROOT: 'https://static.rust-lang.org/rustup', RUSTUP_INIT_SKIP_PATH_CHECK: 'yes', RUSTUP_INIT_SKIP_MSVC_CHECK: 'yes' };
  // Prevent ambient Rust selection/flags from overriding explicit pins.
  for (const key of ['RUSTUP_TOOLCHAIN', 'RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'GOFLAGS', 'GOROOT']) delete env[key];
  const goManifest = await download('go-releases.json', 'https://go.dev/dl/?mode=json&include=all');
  const goReleases = JSON.parse(goManifest.bytes.toString('utf8'));
  ensure(Array.isArray(goReleases), 'Go release API must return an array');
  const release = goReleases.filter((entry) => entry.version === PINS.go);
  ensure(release.length === 1 && release[0].stable === true, `Exact stable Go release ${PINS.go} is unavailable`);
  const candidates = release[0].files.filter((entry) => entry.version === PINS.go && entry.os === report.native_os && entry.arch === 'arm64' && entry.kind === 'archive');
  ensure(candidates.length === 1, 'Expected exactly one native Go archive');
  const goArchive = candidates[0];
  ensure(/^[a-f0-9]{64}$/.test(goArchive.sha256) && Number.isSafeInteger(goArchive.size) && goArchive.size > 0 && goArchive.size < 256 * 1024 * 1024, 'Go archive digest or size is invalid');
  ensure(goArchive.filename === `${PINS.go}.${report.native_os}-arm64.${windows ? 'zip' : 'tar.gz'}`, 'Unexpected Go archive name');
  await writeFile(path.join(downloads, 'go-selected-release.json'), `${JSON.stringify(goArchive, null, 2)}\n`);
  let go = await locate('go');
  let goOrigin = 'setup-go / runner existing exact toolchain';
  if (go) {
    const check = await command('existing-go-version', go, ['version'], { allowFailure: true });
    if (check.code !== 0 || check.stdout.trim() !== `go version ${PINS.go} ${report.native_os}/arm64`) go = null;
  }
  if (!go) {
    goOrigin = 'official SHA256 verified native archive';
    const archive = await download(goArchive.filename, `https://go.dev/dl/${goArchive.filename}`, { limit: goArchive.size, timeout: 480_000 });
    ensure(archive.metadata.size === goArchive.size && archive.metadata.sha256 === goArchive.sha256, 'Go archive SHA256 or length mismatch');
    const sdk = path.join(privateRoot, 'go-sdk');
    await mkdir(sdk, { recursive: true });
    if (windows) {
      await command('extract-go', 'pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:REA_GO_ARCHIVE -DestinationPath $env:REA_GO_SDK'], { timeout: 180_000, environment: { ...env, REA_GO_ARCHIVE: archive.metadata.path, REA_GO_SDK: sdk } });
    } else {
      await command('extract-go', 'tar', ['-xzf', archive.metadata.path, '-C', sdk], { timeout: 180_000 });
    }
    go = path.join(sdk, 'go', 'bin', `go${exe}`);
  }
  const goVersion = (await command('go-version', go, ['version'])).stdout.trim();
  ensure(goVersion === `go version ${PINS.go} ${report.native_os}/arm64`, 'Go version/host mismatch');
  const goEnvironment = JSON.parse((await command('go-host-environment', go, ['env', '-json', 'GOHOSTOS', 'GOHOSTARCH', 'GOROOT', 'GOVERSION', 'GOTOOLCHAIN'])).stdout);
  ensure(goEnvironment.GOHOSTOS === report.native_os && goEnvironment.GOHOSTARCH === 'arm64' && goEnvironment.GOVERSION === PINS.go, 'Go host identity mismatch');
  report.go_version = PINS.go;
  report.toolchains.go = { version: goVersion, binary: await digest(go), environment: goEnvironment, source: goOrigin, archive_downloaded_and_verified: goOrigin === 'official SHA256 verified native archive', release_api: goManifest.metadata, selected_archive: goArchive };

  const manifestUrl = `https://static.rust-lang.org/dist/channel-rust-${PINS.rust}.toml`;
  const rustManifestHash = await download('rust-manifest.sha256', `${manifestUrl}.sha256`, { limit: 4096 });
  const rustManifest = await download('rust-manifest.toml', manifestUrl);
  ensure(rustManifest.metadata.sha256 === expectedHash(rustManifestHash.bytes), 'Rust manifest SHA256 mismatch');
  const sections = rustSections(rustManifest.bytes.toString('utf8'));
  const componentSources = {};
  for (const name of ['rust', 'rustc', 'cargo', 'rust-std']) {
    const section = sections.get(`pkg.${name}.target.${target}`);
    ensure(section?.available === true && /^[a-f0-9]{64}$/.test(section['xz_hash'] ?? '') && typeof section['xz_url'] === 'string', `Rust manifest missing native ${name} component`);
    ensure(new URL(section.xz_url).origin === 'https://static.rust-lang.org', 'Unexpected Rust component origin');
    componentSources[name] = { url: section.xz_url, sha256: section.xz_hash };
  }
  const linker = await configureLinker();
  let rustup = await locate('rustup');
  let rustupOrigin = 'runner preinstalled rustup executable; private install homes';
  if (!rustup) {
    rustupOrigin = 'official SHA256 verified rustup-init';
    const initName = `rustup-init${exe}`;
    const initUrl = `https://static.rust-lang.org/rustup/dist/${target}/${initName}`;
    const initHash = await download(`${initName}.sha256`, `${initUrl}.sha256`, { limit: 4096 });
    const init = await download(initName, initUrl, { limit: 64 * 1024 * 1024, timeout: 180_000 });
    ensure(init.metadata.sha256 === expectedHash(initHash.bytes), 'rustup-init SHA256 mismatch');
    if (!windows) await chmod(init.metadata.path, 0o700);
    await command('rustup-private-init', init.metadata.path, ['-y', '--no-modify-path', '--profile', 'minimal', '--default-host', target, '--default-toolchain', 'none'], { timeout: 480_000 });
    rustup = path.join(cargoHome, 'bin', `rustup${exe}`);
  }
  const rustupVersion = (await command('rustup-version', rustup, ['--version'])).stdout.trim();
  await command('rust-toolchain-install', rustup, ['toolchain', 'install', `${PINS.rust}-${target}`, '--profile', 'minimal', '--no-self-update'], { timeout: 480_000 });
  const rustc = (await command('rustc-location', rustup, ['which', '--toolchain', `${PINS.rust}-${target}`, 'rustc'])).stdout.trim();
  const cargo = (await command('cargo-location', rustup, ['which', '--toolchain', `${PINS.rust}-${target}`, 'cargo'])).stdout.trim();
  ensure(path.resolve(rustc).startsWith(`${path.resolve(rustupHome)}${path.sep}`) && path.resolve(cargo).startsWith(`${path.resolve(rustupHome)}${path.sep}`), 'Rust tools escaped private rustup home');
  const rustcVersion = (await command('rustc-version', rustc, ['-vV'])).stdout.trim();
  const fields = Object.fromEntries(rustcVersion.split(/\r?\n/).filter((line) => line.includes(': ')).map((line) => { const i = line.indexOf(': '); return [line.slice(0, i), line.slice(i + 2)]; }));
  ensure(fields.release === PINS.rust && fields.host === target && /^[a-f0-9]{40}$/.test(fields['commit-hash'] ?? ''), 'Rust version/host/commit mismatch');
  const manifestCompiler = sections.get('pkg.rustc');
  ensure(typeof manifestCompiler?.version === 'string' && manifestCompiler.version.startsWith(PINS.rust + ' '), 'Rust manifest compiler version mismatch');
  if (manifestCompiler.git_commit_hash !== undefined) ensure(manifestCompiler.git_commit_hash === fields['commit-hash'], 'Rust manifest compiler commit mismatch');
  report.rustc_commit = fields['commit-hash'];
  env.RUSTUP_TOOLCHAIN = `${PINS.rust}-${target}`;
  env.RUSTC = rustc;
  env.PATH = [path.dirname(cargo), path.join(installRoot, 'bin'), env.PATH ?? env.Path ?? ''].join(path.delimiter);
  report.toolchains.rust = { version: rustcVersion, rustc_commit: fields['commit-hash'], host: target, rustc: await digest(rustc), cargo: await digest(cargo), cargo_version: (await command('cargo-version', cargo, ['--version'])).stdout.trim(), rustup: await digest(rustup), rustup_version: rustupVersion, rustup_source: rustupOrigin, manifest: rustManifest.metadata, manifest_checksum: rustManifestHash.metadata, manifest_components: componentSources, linker };
  await command('cargo-auditable-install', cargo, ['install', 'cargo-auditable', '--version', `=${PINS.cargo_auditable}`, '--locked', '--root', installRoot, '--target', target], { timeout: 480_000 });
  const auditable = path.join(installRoot, 'bin', `cargo-auditable${exe}`);
  // cargo-auditable dispatches only when argv[1] is "auditable" and forwards
  // --version to Cargo; its own exact version comes from Cargo's install ledger.
  const auditableList = (await command('cargo-auditable-install-list', cargo, ['install', '--list', '--root', installRoot])).stdout;
  const auditableVersion = `cargo-auditable ${PINS.cargo_auditable}`;
  ensure(auditableList.split(/\r?\n/).includes(`cargo-auditable v${PINS.cargo_auditable}:`), 'cargo-auditable installed version mismatch');
  report.toolchains.cargo_auditable = { version: auditableVersion, binary: await digest(auditable), source: 'crates.io cargo-auditable exact version, cargo install --locked', private_root: installRoot };

  report.fixture_sources = { before: await fixtureSnapshot(fixtureRoot) };
  const goFixture = path.join(fixtureRoot, 'go');
  const rustFixture = path.join(fixtureRoot, 'rust');
  await Promise.all([access(path.join(goFixture, 'go.mod')), access(path.join(rustFixture, 'Cargo.lock'))]);
  const goOutput = path.join(artifacts, `go-fixture${exe}`);
  const rustOutput = path.join(artifacts, `rust-fixture${exe}`);
  await command('go-build-fixture', go, ['build', '-trimpath', '-o', goOutput, '.'], { cwd: goFixture, timeout: 180_000 });
  await command('rust-build-fixture', cargo, ['auditable', 'build', '--release', '--locked', '-p', 'rea-producer-fixture', '--target', target], { cwd: rustFixture, timeout: 180_000 });
  await copyFile(path.join(targetDir, target, 'release', `rea-producer-fixture${exe}`), rustOutput);
  const goArtifact = await digest(goOutput);
  const rustArtifact = await digest(rustOutput);
  report.builds.go = { status: 'passed', artifact_sha256: goArtifact.sha256, artifact: goArtifact, fixture: goFixture, fixture_module: await digest(path.join(goFixture, 'go.mod')), target: `${report.native_os}/arm64`, executed: false };
  report.builds.rust = { status: 'passed', artifact_sha256: rustArtifact.sha256, artifact: rustArtifact, fixture: rustFixture, lockfile: await digest(path.join(rustFixture, 'Cargo.lock')), target, auditable: true, executed: false };
  report.fixture_sources.after = await fixtureSnapshot(fixtureRoot);
  ensure(JSON.stringify(report.fixture_sources.before) === JSON.stringify(report.fixture_sources.after), 'Fixture sources changed during build');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  await save();
  process.stdout.write(`${JSON.stringify({ status: report.status, out: output, failure: report.failure?.message })}\n`);
}
