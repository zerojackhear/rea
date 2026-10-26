# Isolated ARM64 hosted verification

The branch-scoped `.github/workflows/c19-arm64-verification.yml` runs these
checks on GitHub-hosted Windows and Linux ARM64 virtual machines. These are OS
runtime checks on hosted VMs, not physical-device or bare-metal qualification.
Only recorded completed runs establish verification.

Run REA from a **separate exact c19 runtime checkout**:
HEAD c19c2d6723fb92548b0c8a1ed0696d721a80aae6,
tree d6405587116af64c4d9bac2216525dc68cc262fc. Install/build that runtime with
its pinned Node/npm and locked dependencies. The workflow/scripts checkout can
be elsewhere and need not have the c19 HEAD.

Produce two fresh artifacts on each actual ARM64 runner. Node process.arch may
be x64 under Windows emulation; independently establish native Windows OS
architecture through the bootstrap's OS API (for example .NET
RuntimeInformation.OSArchitecture), and Linux native architecture through uname.
Both artifacts must independently have ARM64 ELF/PE machine headers.
No emulator is invoked by this harness.

## Native producer commands

Go: from fixtures/go, with CGO_ENABLED=0 and native GOOS/GOARCH=arm64, run
"go build -trimpath -o ABS_ARTIFACTS/go-fixture ." (Windows filename .exe).
Record "go version", "go env GOVERSION", compiler binary path and SHA256.
The module has no external dependencies. Do not use "go run": execute the exact
produced file later through the harness.

Rust: use pinned cargo-auditable 0.7.7, and from fixtures/rust run:
cargo auditable build --release --locked -p rea-producer-fixture --target TARGET

TARGET is aarch64-unknown-linux-gnu or aarch64-pc-windows-msvc. Copy that exact
target/TARGET/release/rea-producer-fixture[.exe] to
ABS_ARTIFACTS/rust-fixture[.exe], preserving its bytes. Record rustc -vV,
cargo -V, cargo install --list --root PRIVATE_INSTALL_ROOT, compiler/cargo-auditable binary SHA256,
target, exact build command, artifact SHA256 and fixture source hashes.
Rust target std and MSVC link prerequisites belong to bootstrap; the harness
does not install them or infer native OS architecture from a target name.

The Rust local-bytes, local-protocol, app package identities, dependencies,
lockfile and two library sources derive from the old arm64-msvc/std-project
fixture. The new main prints its compile target OS/architecture and exits.
Expected stdout (LF, empty stderr, exit 0, no timeout):

Linux Go:   rea-go-arm64-cloud os=linux arch=arm64
Linux Rust: rea-rust-arm64-cloud os=linux arch=aarch64 label=rea-fixture-42
Windows Go:   rea-go-arm64-cloud os=windows arch=arm64
Windows Rust: rea-rust-arm64-cloud os=windows arch=aarch64 label=rea-fixture-42

## Explicit bootstrap receipt interface

Write JSON containing these required fields (this is local harness input, not
an invented REA tool contract). Do not write an ambient environment dump:

{
  "status": "passed",
  "source_head": "c19c2d6723fb92548b0c8a1ed0696d721a80aae6",
  "source_tree": "d6405587116af64c4d9bac2216525dc68cc262fc",
  "native_os": "linux",
  "native_arch": "arm64",
  "go_version": "go1.26.0",
  "rustc_commit": "actual 40 lowercase hex from rustc -vV",
  "rust_target": "aarch64-unknown-linux-gnu",
  "toolchains": {
    "go": {"version": "actual", "path": "actual", "sha256": "actual"},
    "rustc": {"version": "actual", "path": "actual", "sha256": "actual"},
    "cargo_auditable": {"version": "cargo-auditable 0.7.7", "path": "actual", "sha256": "actual"}
  },
  "builds": {
    "go": {"command": ["actual"], "artifact_sha256": "actual"},
    "rust": {"command": ["actual"], "artifact_sha256": "actual"}
  }
}

The go_version above is illustrative; use the actual GOVERSION. The bootstrap
should retain native OS probe raw output, command/version/digest evidence and
fixture-source hashes in this explicit receipt or referenced files. Extra
explicit receipt fields are retained by the verifier.

node ABS_DRAFT/verify-arm64.mjs --root ABS_C19_RUNTIME --artifacts-dir ABS_ARTIFACTS --out ABS_NEW_CAPTURE_DIR --bootstrap-receipt ABS_BOOTSTRAP_JSON

Every successful job requires exactly four static reads (CLI+stdio MCP for each
artifact) followed by exactly two 15-second-bounded direct print-and-exit runs
of those same bytes. CLI reads and MCP connect/tool operations are bounded to
45 seconds. Runtime output is capped at 128 KiB, CLI output at 8 MiB, MCP stderr
at 1 MiB, input files at 256 MiB; exceeding a bound fails the receipt.

The verifier uses the actual c19 parseEvidence/goBinarySchema/rustBinarySchema
and installed SDK 2.3.1. Rust .dep-v0 section discovery, ARM64 machine header
checks, decompression and package-index/edge checks have a small independent
ELF64/PE32+ oracle. ELF extended section numbering is intentionally unsupported
for these known compiler fixtures. No synthetic malformed/general ELF support
claim is made.

The independent Rust oracle requires the exact embedded three-package closure,
original package indices and format 1. It preserves omitted kind as null and
root flags. The top-level Evidence is observed; /rustc/ paths are inferred,
including when they match the separately observed compiler commit. If no path
exists, REA rustc_commit must remain null with an unknown limitation.

Capture includes raw CLI stdout/stderr, complete MCP response and parsed
Evidence, independent oracle, every child exit/timeout/signal/close status,
raw runtime stdout/stderr and input SHA256 before/after. MCP client and
transport are closed and public stdio close is observed; failure to observe
cleanup fails the receipt. This does not assert a general process-family
ownership proof or performance measurement.

No native ARM64 cloud run has been performed while authoring this draft.
