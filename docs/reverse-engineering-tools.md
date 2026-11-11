# Reverse-engineering tool integrations

REA can call caller-supplied GNU objdump, GDB, and Rizin installations. REA does not install or update these tools. Static objdump/Rizin workflows use the same services from CLI and MCP. GDB and Rizin debugger workflows support Linux and Windows x64 with the provider requirements below. Persistent debugger sessions exist only for the lifetime of the REA MCP server process.

In a shared MCP server, unrestricted Rizin and Cutter commands, GDB console
commands, Rizin debugger start/close, and GDB debugger close retire any active
binary analysis session after the operation. This prevents a fresh analysis
provider from being rebound automatically while command effects may still be
writing. After the command and any background writers have stopped, call
`open_binary` explicitly before continuing analysis. A successful command
response alone does not prove that background writers have stopped. An active
Ghidra analysis session must be closed explicitly before an external mutation
can run.

## GNU objdump

`inspect_with_objdump` and `rea inspect-with-objdump` capture stdout and stderr as inline Evidence. Artifact inspection Evidence records SHA-256 digests before and after the provider call and whether those observed digests differ; this cannot prove the exact bytes consumed if the artifact changes during execution. Choose one artifact operation: `file_headers`, `section_headers`, `symbols`, `relocations`, `dwarf`, `disassemble`, or `disassemble_all`. `disassemble` maps to `-d`; `disassemble_all` maps to `-D` and has different symbol-boundary semantics. The pathless `inspect_with_objdump {"operation":"architectures"}` MCP call or `rea list-objdump-architectures` CLI command maps to `-i` and produces subjectless provider-capability Evidence describing BFD targets compiled into the installed binary, not a guarantee that a target is supported.

For DWARF, REA does not follow local debug links by default. Set `follow_debug_links` to `true` to pass `-WK`; external debug-file identities are not bound to Evidence when following links is enabled. The CLI flag is `--follow-debug-links`; `--no-follow-debug-links` or `--follow-debug-links=false` keeps the default. A separate `true` or `false` word after the flag is not its value. REA clears `DEBUGINFOD_URLS` in the objdump child environment to disable debuginfod network access on GNU binutils versions that do not support `-WE`. The complete raw output is authoritative; REA does not normalize it into a version-independent disassembly schema.

```sh
rea inspect-with-objdump ./program disassemble
rea inspect-with-objdump ./program dwarf
rea inspect-with-objdump ./program dwarf --follow-debug-links
```

Captured stdout and stderr are retained up to a 16 MiB combined limit; `output_truncated` marks output beyond that limit.

## GDB

Persistent GDB sessions, including the MCP workflow and one-shot `rea debug-with-gdb` CLI, are available on Linux and Windows x64. Linux verifies live inferior output descriptors through `/proc`. Windows uses matching native controls and a Python-enabled GDB: the debugger owns only its own lifetime, and private MI pipes are made non-inheritable before any target is selected. Native Windows x64 inferiors can be detached after read-only creation-time and output-file identity checks; Windows x86/ARM inferior descriptor layouts and macOS descriptor verification are not covered by this implementation.

On Windows, first create a dedicated empty regular file on local NTFS and pass its absolute path as `inferior_tty`. GDB may truncate the selected file when starting the target. The native reader verifies both target standard-output handles against that file and keeps uncertainty when inspection fails. For example, `rea debug-with-gdb --inferior-tty C:\work\target-output.txt 'file C:/work/program.exe'`. Neither an absent file, directory, reparse route, nor a protocol pipe is accepted as a durable output file.

On supported hosts, `start_gdb_session`, `gdb_console`, `gdb_session_status`, and `close_gdb_session` manage a persistent GDB/MI session in MCP. On Linux the one-shot CLI requires a caller-selected durable TTY: `rea debug-with-gdb --inferior-tty /dev/pts/7 'file ./program'`. The TTY must remain available after GDB exits so a detached inferior can continue writing. MCP starts GDB with `--nx --quiet --interpreter=mi3`, retries initialization with MI2 if MI3 initialization returns an error and cleanup succeeds, waits for its prompt, and disables auto-loading. Pass optional `inferior_tty` to select the terminal that future inferior runs use; REA configures it before the session becomes ready and checks the exact value with GDB/MI. `gdb_session_status` reports the selected path, whether REA still considers the configuration verified, and whether invalid UTF-8 has been observed in MI bytes (`mi_invalid_utf8`) or stderr (`stderr_invalid_utf8`). Commands that can change the inferior TTY or redirect a run revoke that verification permanently for the session, so close retains GDB ownership if a live inferior remains. Closing a session with one live inferior and a verified TTY automatically detaches the target, which can resume execution; MCP clients receive destructive-operation annotations for this behavior. The console remains unrestricted and can run shell commands, change target state, access files, and use network in the REA process user's security context. Raw MI records and console/target/log streams are returned with Evidence; command output is retained up to 16 MiB and explicitly marked when truncated.

Before a normal close, REA checks for live GDB thread groups. If one remains and a durable `inferior_tty` is verified, REA asks GDB to detach it and confirms the detach before stopping the debugger. Without that sink, select and apply a disposition to each inferior through `gdb_console` (for example, detach or kill as appropriate), then retry close. REA never infers target ownership from a PID or path. When the MCP server shuts down, REA terminates only its directly owned GDB process after confirming no inferior or a sink-backed detach; otherwise it retains the process and its output streams for retry.

A Windows close refused by the read-only output check leaves a synchronized session usable: the caller can repair the output configuration or continue the target to its exit, then close again. Actual protocol loss or an attempted detach/cleanup failure still retains its cleanup owner. This distinction also applies to x86 targets: real WOW64 execution and exit have been verified, but automatic live-target detach still requires the native x64 output layout.

```text
start_gdb_session {"inferior_tty":"/dev/pts/7"}
gdb_console {"session_id":"…","command":"file ./program"}
gdb_console {"session_id":"…","command":"info files"}
gdb_session_status {"session_id":"…"}
close_gdb_session {"session_id":"…"}
```

## Rizin

`start_rizin_debug_session` and `rea debug-with-rizin` require an explicit `inferior_tty`. On Linux this is a durable caller-selected TTY; before detach REA checks `/proc/<pid>/fd/1` and `/proc/<pid>/fd/2` against its device/inode identity. Rizin starts with `dbg.exitkills=false`, so a detached target can continue running and writing to the selected destination.

On Windows x64, `inferior_tty` selects an existing regular file on local NTFS. The native backend requires the [Rizin 0.9.1 Windows source fix](../native/windows/rizin/README.md), which appends stdout/stderr without creating or truncating the file and restricts inherited handles to those selected for the target. A bounded targetless preflight refuses unpatched builds before target launch. REA verifies the actual live output handles, creation identity, and `dbg.exitkills=false`; `dp-` is followed by a native `CheckRemoteDebuggerPresent` observation and descriptor-list readback. Closing `w32dbg://` alone is insufficient proof. Windows x86/ARM target output layouts remain unverified.

Both paths serialize cleanup after the active command and refuse ambiguous inventories instead of treating unknown IO plugins as no inferior. A Windows close refused before detach leaves the correlated session available to repair settings and retry; an actual protocol or cleanup failure retains ownership and blocks replacement. A successful close does not claim that the target has ended.

Persistent command Evidence retains the caller-selected and resolved startup paths in `parameters.launch_provenance`. These paths describe launch provenance, not the current target after unrestricted commands. `rizin_debug_session_status.output_invalid_utf8` reports whether lossy frame decoding has been observed during the session. Command Evidence sets `output_invalid_utf8` only when loss was observed in frames collected for that command, including retained partial output; earlier startup or command frames do not mark later valid output as lossy.

```sh
rea debug-with-rizin --inferior-tty /dev/pts/7 ./program dr
```

`execute_rizin_command` and `rea execute-rizin-command` run one selected command against a local artifact. The one-shot profile uses `-N -q -c`, suppressing user settings and scripts while leaving plugins available. Commands and plugins run with the REA process user's security context and may access files, the network, or perform other actions. REA preserves raw output and does not claim that command-specific JSON has one universal schema.

```sh
rea execute-rizin-command ./program iI
```

Captured stdout and stderr are retained up to a 16 MiB combined limit; `output_truncated` marks output beyond that limit.

## Cutter bridge

Cutter commands use the local REA Python bridge and authenticated loopback messages.
The client and plugin must support the current v2 handshake; older peers are
rejected before dispatch because they cannot preserve cross-caller recovery proof.
The client checks the final encoded request against the bridge's 16 MiB frame
limit before dispatch; an oversized command does not retain a cleanup owner.
Discovery admits at most 256 descriptor candidates and reads and probes at most
eight concurrently. A larger directory reports `bridge_directory_capacity_exceeded`.

Terminal receipts are recovered before another command, including from a new CLI
invocation. A signed status response also confirms completion of older bridge
connections after its UI dispatch, preserving recovery proof for a caller whose
receipt another caller has acknowledged. Neither receipt recovery nor a status
probe retries the original command. Failed acknowledgements remain pending and
block new commands until they can be retried successfully.

## Configuration and coverage

The optional `REA_OBJDUMP_COMMAND`, `REA_GDB_COMMAND`, and `REA_RIZIN_COMMAND` values select executable names or paths; otherwise REA searches `PATH`. Values are passed directly to process spawning, not expanded as shell command lines. Provider versions and capabilities remain unknown until observed from the installed tool and verified in the corresponding real-provider lane.

Provider capture limits are separate from the MCP response budget. A result that fits the provider limit may still exceed the default 10 MiB MCP response budget and return a transport `resource_constraint`. Configure `REA_MCP_MAX_RESPONSE_BYTES` to match a larger client receive buffer when that client supports one; otherwise use retained Evidence/export or complete CLI JSON output. See [MCP response limits](./mcp-contracts.md#tool-results).
