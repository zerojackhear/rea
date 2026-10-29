# REA Android hybrid app

Native Java, Android framework UI, Storage Access Framework, Android Keystore,
and HTTPS. No WebView, native ABI library, broad storage permission, analytics,
or account service. Android 8 (API 26) or newer. The app works offline without
a configured computer. It does not execute selected files.

Local observations: SHA-256, file header candidates, a bounded ASCII string
projection, ZIP/APK directory/ABI observations, private history, JSON export.
ZIP64/large or malformed directories remain unknown. APK manifest decoding,
signature verification and decompilation are not local capabilities.

The separately launched Node HTTPS adapter uses the existing desktop engine and
its real stdio MCP client. It offers eight named static workflows: JavaScript,
APK/JADX, Flutter identity, Dart AOT, Go, Rust, SQLite, and WASM/WABT. Providers
remain prerequisites on the server. Other REA tools are not exposed by this app.
One uploaded script is an explicit source selection inside its own artifact
directory; no implicit dependency upload occurs. ASAR files use the existing
ASAR reader. Original names and bytes are retained separately from metadata.

## Build

Use an installed JDK 17+ and Android SDK platform/build-tools 36. Run `build.ps1`
with `-AndroidJar`, `-BuildTools`, and `-JavaHome`. It creates a new ignored output
directory, signs with a persistent local key in `.cache/android-signing`, and
verifies signature and alignment. Preserve that private signing directory to
ship future updates under the same identity. Do not commit it or include it in
the APK, source archive, or server package.

## Connect a backend when available

The app does not require a backend until a remote analysis is requested. A
personal PC or a user-provisioned cloud host can run it. This project does not
purchase hosting or create a public relay account.

On Windows, `remote/start.ps1` uses a supplied REA Desktop directory and an
existing JDK for initial certificate creation. First run prompts for the HTTPS
URL reachable from the phone. The private service directory defaults to
`%LOCALAPPDATA%/REA-Mobile-Server`. Import the generated `rea-connection-*.json`
into Android and confirm its host and certificate fingerprint. The file is a
device credential; transfer it privately and remove unneeded transfer copies.

The transport has no subnet restriction. A VPN address, reachable public
address/domain, or TCP tunnel can work. The network route, firewall and any
port forwarding must actually reach the service. TLS passthrough retains the
configured certificate. A TLS-terminating proxy requires a separate deployment
with its actual certificate pin; do not disable certificate verification.
Neither a public route nor real Internet connectivity is created by this code.

For an existing Linux/cloud environment, run `node remote/setup.mjs --root
<private-dir> --core <installed-rea-package> --node <node-executable> --url
https://<reachable-host>:8443 --keytool <jdk-keytool>`, then `node remote/server.mjs
<private-dir>`. The source layout must retain sibling `apps/desktop/engine.mjs`
and `bridge.mjs`. Linux/cloud execution has not been verified by this delivery;
use the core's provider requirements and Linux owned-process prerequisites.

`setup.mjs --root <private-dir> --revoke <device-uuid>` removes a device; restart
the service to apply it. Repeated setup reuses the existing connection; explicit
`--new-device` creates distinct tokens up to four devices. Existing configuration
is backed up before changes and replaced atomically. A server
process retains failed cleanup ownership; its final receipt distinguishes
unknown cleanup. Do not treat a disconnected phone as proof of cancellation.

## Boundaries and verification

No raw MCP endpoint, arbitrary server file paths, debugger, target execution,
injection, shell operation or automatic provider installation is exposed.
Authentication is per-device; each device has a separate upload root and engine.
TLS pins are checked before authorization headers are sent. Tokens are hashed
server-side and encrypted with Keystore on Android. Backup is disabled.

Uploads: 256 MiB each, 100 files and 2 GiB per device. SHA-256 is verified on
receipt and again before analysis. Task intent is durable before dispatch;
an ambiguous interrupted submission remains unknown and is never silently
replayed. Server request records are capped at 500 per device. Phone history is
50 records / 64 MiB; receive limit 16 MiB. Larger results stay on the computer.
No automatic deletion of analysis evidence occurs at a quota limit.

`remote/server.test.mjs` exercises the real HTTPS protocol with a simulated
engine; set `REA_ANDROID_TEST_TLS` to a private test setup directory. These tests
do not establish provider behavior. `tests/build-probe.ps1` builds a separate
instrumentation APK against the signed app. It contains a temporary validation
credential and must stay private in ignored cache, never in deliverables.
`tests/Probe.java` covers native content import, offline analysis, Keystore,
invalid TLS/credentials, reconnect idempotency, and a real JavaScript MCP result.
Public Internet routing and physical ARM devices require separate verification.
