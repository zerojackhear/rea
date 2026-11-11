# REA Desktop (Windows x64 development build)

Desktop adds a local Electron interface to the existing REA MCP runtime. The renderer is isolated; it receives named application operations rather than a shell or executable launcher. Core analysis runs in a separate pinned Node 24.22.1 process; Electron is pinned to 44.9.1. Runtime versions and complete archive pins have one owner in `runtime-pins.mjs`. Repository development/build checks remain on Node 24.18.0 and npm 11.16.0; no global runtime is upgraded. External providers remain bring-your-own, and unavailable capabilities keep REA's original errors and limitations.

## Run from source

First install the repository's locked dependencies, provide a Windows native artifact that matches this exact core version/source, and run `npm run build:cached` with Node 24.18.0 and npm 11.16.0. Then run:

```powershell
node apps/desktop/launch.mjs --electron-zip C:\path\electron-v44.9.1-win32-x64.zip --node-zip C:\path\node-v24.22.1-win-x64.zip
```

The launcher checks the complete ZIP against its pinned size and SHA-256, extracts a new owned runtime, and starts Electron with `windowsHide: true`. It separately admits the complete Node 24.22.1 ZIP and passes that executable to the application; the development Node running the launcher is not the backend runtime. No global Node/npm setting is changed. Omitting `--electron-zip` or `--node-zip` uses that tool's fixed official HTTPS URL and the same admission checks. Bootstrap downloads use system curl with identity bytes, manual HTTPS host-checked redirects, and no transparent content decompression in the old development Node. Failed downloads and prior extractions remain in `.cache/desktop-toolchain/` for diagnosis; the scripts do not recursively delete them.

## Build a portable directory and ZIP

```powershell
node apps/desktop/package.mjs --electron-zip C:\path\electron-v44.9.1-win32-x64.zip --node-zip C:\path\node-v24.22.1-win-x64.zip --npm-cli C:\path\npm\bin\npm-cli.js
```

Run this command with Node 24.18.0 Windows x64 after the standard core build. npm must be 11.16.0. The new Node runtime archive bundles npm 11.19.1, so pass the isolated 11.16.0 CLI explicitly when invoking the builder directly. The builder prefers the explicit `--npm-cli`, then `npm_execpath`, then npm from the verified Node ZIP; it refuses a different version instead of upgrading globally. Optional `--output-root DIRECTORY` selects the output parent. `--no-zip` creates only the portable directory. Both scripts support `--help`.

Each build creates a new versioned timestamp directory under `.cache/desktop-deliveries/`; it never replaces an old delivery. Standard core build cleanup does not remove this delivery directory. Explicit output roots inside recursively copied renderer/examples or protected Git/agent metadata are rejected before output creation, including junction aliases. Double-click `REA.exe` inside that directory, or extract the complete ZIP and run it. Keep the entire directory together. The packaged application uses `resources/runtime/node.exe` and `resources/core`, so it does not need Node or npm on the destination computer's PATH.

The layout contains the fresh, completely verified Electron distribution and its notices, the pinned Node executable and LICENSE, the desktop application/renderer/self-owned examples, and REA's npm package contents. Core is copied using `npm pack --json --dry-run --ignore-scripts` file metadata with relative-path validation; the repository, `.git`, `.cache`, source tests, development tools and user credentials are not copied. Its lockfile drives a separate `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`. Production optional platform packages remain enabled for node-pty. No dependency lifecycle script runs.

The builder checks the packaged native artifact, actual SDK/node-pty/native module loads and the real CLI version. A sibling `.receipt.json` records source hashes, exact tools, checks, native manifest, output path and ZIP digest. `BUILD-INFO.json` inside the application records its versions and limitations. Source snapshots are rechecked before final output to detect edits during packaging.

## Windows analysis

The desktop launches its bundled Windows core directly. Explicit provider paths
select locally installed Windows tools. Caller-selected file paths, target
identity, Evidence and cleanup ownership remain in the same native session.
The desktop has no WSL launcher or cross-platform path rewriting.

## Desktop coverage

The tool list, global search and parameter panel include Chinese names, purposes,
operation steps and prerequisites for the current engine catalog. Technical tool
IDs and expandable original descriptions remain available. These presentation
guides do not change tool schemas or provider authority. New unknown tool IDs
explicitly fall back to the engine description until a guide is added; they are
not assigned invented capabilities. Validate guide coverage against the live
catalog when changing the packaged engine.

The desktop entry points use named tools from the live catalog. Native files start
with `open_binary` to identify the file and explicitly bind
a target before session-based analysis such as `binary_overview`. Folder selection asks whether to choose a
program inside it or analyze it as a JavaScript/Electron project. A directory name
or a missing filename extension is not evidence of JavaScript content.

For existing local providers, `%APPDATA%/REA Desktop/providers.json` may contain
absolute path values for `GHIDRA_INSTALL_DIR`, `JAVA_HOME`, `REA_JADX_MCP_JAR`,
`REA_WABT_BIN_DIRECTORY`, `REA_TSHARK_COMMAND`, `REA_CAPINFOS_COMMAND`,
`REA_SIGROK_COMMAND`, `REA_WAKARU_COMMAND`, `REA_MITMDUMP_COMMAND`,
`REA_BINWALK_COMMAND`, `REA_UNBLOB_COMMAND`, `REA_PWNTOOLS_PYTHON`,
`REA_KUNA_COMMAND`, `REA_KUNA_CACHE_DIR`, `REA_GDB_COMMAND`,
`REA_RIZIN_COMMAND`, and `REA_OBJDUMP_COMMAND`.
Restart the app after editing. These explicit values
override inherited values for the analysis child only. The desktop does not save
the ambient environment, bundle this private file, install providers, or weaken
their version/integrity admission checks. Missing configuration retains inherited
settings; malformed configuration reports a startup error without deleting it.

This is an unsigned REA development build, currently Windows x64 only, with no installer registration or auto-update. Module loading and CLI version checks do not establish interactive acceptance or coverage of all modules/providers. Verify the real packaged UI and relevant public CLI/MCP workflows separately. Optional Frida's native install step is intentionally not performed or claimed to work. Ghidra/JDK, IDA, Android tools and other external providers are not bundled or silently installed.

Electron and Node are admitted by fixed complete-archive length/SHA-256 and fresh extraction, then executable SHA-256. These checks do not constitute a new independent signature verification. Their upstream license/notices and REA's LICENSE/THIRD_PARTY_NOTICES.md remain in the portable application.

## Manual MCP agent handoff

The Environment page contains **连接 MCP Agent** with a default-off
**汇报后等待你确认** switch and **复制 MCP 连接配置**. Settings are stored in the
Desktop user-data directory as `mcp-settings.json`; a changed existing setting
is backed up before atomic replacement. Invalid settings are preserved and
reported instead of silently reset. The renderer can only toggle this boolean,
not choose configuration paths or executable arguments.

The copied configuration launches this application's Windows REA core and
runtime, includes only explicit provider paths, and sets
`REA_MCP_REVIEW_AFTER_ANALYSIS`. It never edits another agent's configuration.
Update and reconnect the external MCP client after changing the switch. That
agent receives its own analysis results and the requested report-and-wait
policy; enforcement of its next action belongs to the client. Desktop history
and the external agent's REA session remain separate.
