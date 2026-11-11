# Rizin Windows native debugger source fix

This source-only patch targets the official [Rizin 0.9.1 release](https://github.com/rizinorg/rizin/releases/tag/v0.9.1), commit `c3a90e9226d977f58f4e9c75f78fa6b07afe13c7`. The release source archive is 22,792,128 bytes, SHA-256 `7ac1cd7daca7afdda742e15478b1f747fc1f813e496fee71839d1e109e543dca`. Verify the source, exact length and digest before applying either patch. The upstream source and license remain authoritative; no provider binaries belong in this repository.

The stock Windows launcher ignores run-profile stdout/stderr and does not set the Windows debugger exit disposition. `io_debug.c.patch` implements an opt-in existing-file output route, an explicit three-handle inheritance list, and `DebugSetProcessKillOnExit` on the actual debugger thread. `cconfig.c.patch` advertises the opt-in `dbg.windows.stdio` setting. It defaults to false. REA checks this capability in a targetless process before launching a debug target.

Both output files must already exist as regular NTFS files. They are opened for append, not create or truncate. The caller's stdout/stderr paths remain unchanged. `stdin` is an inherited NUL reader; the debugger's protocol handles are not inherited. `dbg.create_new_console=false` is required. The patch uses Rizin's existing Windows argv formatter and core configuration callback; no new library dependency is introduced.

Apply the patches to a fresh verified source tree with `git apply --check` followed by `git apply`, passing both absolute patch paths. In an x64 MSVC development environment with Python, Meson and Ninja available, use:

```powershell
$env:CC = 'cl'
$env:CXX = 'cl'
python -m mesonbuild.mesonmain setup build . --buildtype=release --prefix=C:\rea-validation\rizin-runtime --wrap-mode=nodownload -Dportable=true -Denable_tests=false -Denable_rz_test=false -Denable_examples=false -Dregenerate_cmds=disabled -Dsubprojects_check=false
python -m mesonbuild.mesonmain compile -C build -j 4
python -m mesonbuild.mesonmain install -C build
```

The install step stages the development runtime into the selected prefix; it does not create an REA installer or update Desktop software. The exercised toolchain was MSVC 14.44.35207, Windows SDK 10.0.26100, Python 3.14, Meson 1.12.1 and Ninja 1.13.2. Network dependency downloads were disabled; the official source archive supplies the subprojects.

Select the resulting `bin/rizin.exe` through `REA_RIZIN_COMMAND`. The REA Windows native addon must match its manifest. `scripts/verify-rizin-windows-native.mjs` exercises public CLI/MCP workflows using a hash-pinned self-authored finite executable, including actual process creation identity, kernel debugger attachment state, post-detach output, rejection/recovery and Unicode paths. Its local pointers identify admitted fixtures/tool builds; it does not download or trust arbitrary target programs.

Coverage is Windows x64 on local NTFS. Windows x86/ARM inferior output layouts are unverified. A successful command, source build, or descriptor deletion alone is not detach evidence. REA requires native process and output identity observations and preserves unknown/failed cleanup states.
