# REA Desktop (Windows x64 development build)

Desktop adds a local Electron interface to the existing REA MCP runtime. The renderer is isolated; it receives named application operations rather than a shell or executable launcher. Core analysis still runs in a separate pinned Node process. External providers remain bring-your-own, and unavailable capabilities keep REA's original errors and limitations.

## Run from source

First install the repository's locked dependencies, provide a Windows native artifact that matches this exact core version/source, and run `npm run build:cached` with Node 24.18.0 and npm 11.16.0. Then run:

```powershell
node apps/desktop/launch.mjs --electron-zip C:\path\electron-v44.7.0-win32-x64.zip
```

The launcher checks the complete ZIP against its pinned size and SHA-256, extracts a new owned runtime, and starts Electron with `windowsHide: true`. It passes its exact Node executable to the application. No global Node/npm setting is changed. Omitting `--electron-zip` uses the fixed official HTTPS URL and the same admission checks. Failed downloads and prior extractions remain in `.cache/desktop-toolchain/` for diagnosis; the scripts do not recursively delete them.

## Build a portable directory and ZIP

```powershell
node apps/desktop/package.mjs --electron-zip C:\path\electron-v44.7.0-win32-x64.zip --node-zip C:\path\node-v24.18.0-win-x64.zip --npm-cli C:\path\npm\bin\npm-cli.js
```

Run this command with Node 24.18.0 Windows x64 after the standard core build. npm must be 11.16.0. The builder prefers the explicit `--npm-cli`, then `npm_execpath`, then npm from the verified Node ZIP; it refuses a different version instead of upgrading globally. Optional `--output-root DIRECTORY` selects the output parent. `--no-zip` creates only the portable directory. Both scripts support `--help`.

Each build creates a new versioned timestamp directory under `dist/desktop/`; it never replaces an old delivery. Double-click `REA.exe` inside that directory, or extract the complete ZIP and run it. Keep the entire directory together. The packaged application uses `resources/runtime/node.exe` and `resources/core`, so it does not need Node or npm on the destination computer's PATH.

The layout contains the fresh, completely verified Electron distribution and its notices, the pinned Node executable and LICENSE, the desktop application/renderer/self-owned examples, and REA's npm package contents. Core is copied using `npm pack --json --dry-run --ignore-scripts` file metadata with relative-path validation; the repository, `.git`, `.cache`, source tests, development tools and user credentials are not copied. Its lockfile drives a separate `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`. Production optional platform packages remain enabled for node-pty. No dependency lifecycle script runs.

The builder checks the packaged native artifact, actual SDK/node-pty/native module loads and the real CLI version. A sibling `.receipt.json` records source hashes, exact tools, checks, native manifest, output path and ZIP digest. `BUILD-INFO.json` inside the application records its versions and limitations. Source snapshots are rechecked before final output to detect edits during packaging.

## Coverage

This is an unsigned REA development build, currently Windows x64 only, with no installer registration or auto-update. Module loading and CLI version checks do not establish interactive acceptance or coverage of all modules/providers. Verify the real packaged UI and relevant public CLI/MCP workflows separately. Optional Frida's native install step is intentionally not performed or claimed to work. Ghidra/JDK, IDA, Android tools and other external providers are not bundled or silently installed.

Electron and Node are admitted by fixed complete-archive length/SHA-256 and fresh extraction, then executable SHA-256. These checks do not constitute a new independent signature verification. Their upstream license/notices and REA's LICENSE/THIRD_PARTY_NOTICES.md remain in the portable application.
