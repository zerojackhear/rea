# Windows Unblob source port

The Unblob patch targets version 26.6.4, commit
`1fcc7a0a584a70a96c31f5a276c20944d199a089`. Apply it to a clean copy of
that source. These files contain source changes, not engine binaries or a REA
installer. Keep the upstream and dependency licenses with locally built engines.

The Windows CLI initializes one worker inside REA's native AppContainer. The
native token, exact package SID, Job ownership, child-process prohibition and
sealed engine/input directories are checked before parsing. The worker does not
launch a shell or an archive helper. Cancellation terminates the owned Job;
cleanup retains ownership until the Job and profile can actually be removed.

The stream adapters cover gzip, bzip2, xz/lzma, zstd and LZ4; archive adapters
cover ZIP, TAR and CPIO. The libarchive adapter adds 7z, CAB, RAR and ISO9660.
The Android sparse adapter materializes RAW, FILL and DONT_CARE chunks and checks
declared extents and CRC32 values. The 7-Zip decoder adds Ext, FAT, NTFS,
SquashFS, CramFS, ARJ, MSI/compound streams and DMG. These are format-family
implementations; individual versions, codecs and malformed variants require
their own real validation and must not be inferred from one passing sample.

`windows-sevenzip.cc` is a narrow read-only bridge using the official IInArchive
interfaces. It accepts only fixed format names and existing read/write handles;
it never opens output paths, applies archive permissions, creates links or
launches programs. The Python owner validates paths and exclusively creates
regular output files. NTFS alternate streams are exported as ordinary `.bin`
files with `stream-map.json` preserving the decoder's source coordinates and
content digests. No Windows alternate data stream is created.

The 7-Zip source patch targets official 26.06 (`7z2606-src.tar.xz`, SHA-256
`a4e374c8f864f51df48c2cfd0e1413ec3b2ea030deae852d6a655402ebb61ac4`). It enables
stack protection, CFG, DEP and ASLR and preserves POSIX filesystem names before
Win32 admission. Invalid UTF-8 and unrepresentable names remain explicit errors;
the Ext, CramFS and SquashFS adapters do not substitute underscores or guess an
OEM encoding. This does not establish the name encoding of legacy ARJ files.
Normalize touched source files from CRLF to LF before applying the patch; keep
the admitted original archive unchanged. Build the
patched `CPP/7zip/Bundles/Format7zF` with MSVC `nmake PLATFORM=x64 MP_NPROC=2`.
Build the adjacent bridge against the same source headers, using the MSVC
developer environment and `/std:c++20 /O2 /EHsc /MT /GS /guard:cf`; link as a DLL
with `/DYNAMICBASE /NXCOMPAT /guard:cf`, `kernel32.lib`, `ole32.lib`,
`oleaut32.lib` and `uuid.lib`. Both DLLs belong in `unblob/_windows_native`.

The validated Python tree uses Python 3.14, hyperscan 0.9.1 with the adjacent
binding/build fixes, and Intel Hyperscan 5.4.2. The binding owns its database and
callback references, participates in cyclic GC and rejects use after close.
plotext 5.3.2 needs the native-console patch so importing it does not run cmd.exe.
`python-magic-standalone==0.4.29` is an unofficial distribution; its bundled
libmagic DLL crashed on a valid ZIP containing a zero DOS date. Replace that DLL
with the official file/libmagic 5.48 source plus the adjacent date/conversion
patch and admitted dependency DLLs. Preserve provenance for every replacement.
The libarchive adapter was verified with official MSYS2 libarchive 3.8.11-1 and
its checked runtime DLL closure. No publisher identity is authenticated merely
by a caller-created inventory.

For an isolated Python tree, generate `rea-unblob-runtime.json` with
`schemaVersion: 1` and a `files` array of relative path, byte length and SHA-256.
Exclude that manifest itself and caches. Set `REA_UNBLOB_COMMAND` to its
`python.exe`. REA verifies the copied and sealed bytes before execution. The
current limits are 128 MiB input, 512 MiB runtime inventory, 512 MiB decoded
output per extractor, 10,000 native archive entries and a 1 GiB worker Job.
NTFS, Android Sparse and legacy archive adapters reserve 4 MiB of their output
allowance for provenance mappings.

Run `node scripts/verify-firmware-windows.mjs` for the self-created TAR and
malformed-name ZIP lane. Run `node scripts/verify-firmware-windows-formats.mjs
FIXTURE_RECEIPT.json CASE...` for selected real CLI/MCP formats; each case declares
expected coverage, payload digest and any required diagnostic or NTFS stream
oracle. Run `node scripts/verify-windows-appcontainer.mjs` for actual ACL,
child-process, cancellation and cleanup checks. Receipts retain complete
Evidence and distinguish complete, partial and failed runs.

The Windows flash adapters share the handler-owned structures. JFFS2 checks
node/data CRCs and replays versioned inode ranges and unlinks. Missing ranges
remain unknown. Invalid identity metadata prevents falling back to earlier file
state. Real little- and big-endian mkfs images cover stored, zlib, LZO and RTIME
nodes; LZMA and special nodes are not established by those samples.

`ubi-reader-windows.patch` targets the locked `ubi-reader==0.8.10` sdist
(`b2763b85f8b6c68bce592d674aa9e9cadda2939a634f42954518d5c786c60f10`).
Its read-only owners validate UBI PEB identity, checksums and both volume tables,
then the committed UBIFS master/index tree before materializing files. A dirty
journal remains partial; this reader does not replay uncommitted journal nodes.
An absent mapped LEB is not replaced with erased bytes. Volume mappings retain
original name bytes, source PEBs, selected sequence numbers and digests. Real
mkfs.ubifs images cover none, zlib, LZO and Zstd; real ubinize images cover a
dynamic UBIFS volume and a static data volume.

`windows-lzo.cc` is a fixed-buffer bridge to the `lzokay` sources bundled in the
locked `lzallright==0.2.6` sdist
(`15917d4e5aadf601b58da0bbf034c5715853fffe843a3ee4b5040ae0e5d954ad`).
Compile it and `lzokay.cpp` using MSVC `/std:c++20 /O2 /EHsc /MT /GS /guard:cf`,
link `/DLL /DYNAMICBASE /NXCOMPAT /guard:cf`, and retain the upstream MIT notice.
Both caller buffers are bounded before entry; decoded size must match exactly.

The EROFS reader uses official erofs-utils `dev` commit
`de2dbe430f066ab02d7272e6b47fcc70446bca61`, which includes Windows I/O support.
This is a pinned development revision, not a released-version support claim.
Normalize source newlines for autotools, apply `erofs-windows-boundary.patch`,
and build the library for `x86_64-w64-mingw32` with LZ4, LZMA, zlib and Zstd.
Disable multithreading, FUSE, S3, OCI, ublk, fanotify, UUID, SELinux, curl,
OpenSSL, JSON/XML/netlink, xxhash and libdeflate. Compile `windows-erofs.c` with
the same generated config, `-DHAVE_CONFIG_H -D_LARGEFILE_SOURCE
-D_FILE_OFFSET_BITS=64 -D__USE_MINGW_ANSI_STDIO=1 -DNDEBUG`, stack protection,
and link DEP/ASLR/high-entropy VA. This MinGW build does not claim MSVC CFG.
The bridge accepts an existing read-only handle, exposes five fixed functions,
never mounts an image and rejects short device reads instead of padding them.
Preserve the exact runtime DLL dependency closure and dependency licenses.
Real CLI/MCP samples cover none, LZ4, LZMA, Deflate and Zstd, a valid zero
build timestamp, invalid names and a failed superblock checksum.

Partclone v2 restoration creates only a regular image and a provenance mapping.
The common format owner validates geometry and on-disk extents, including the
bitmap's CRC trailer when data checksums are disabled. The Windows reader first
checks the entire selected data stream, then materializes it with bounded reads.
Blocks omitted by Partclone remain unknown source content; zero-filled output
holes are explicitly recorded as a representation. Real Partclone 0.3.36 images
with CRC32, no data CRC and continuous CRC groups match official restore output.
Big-endian native-word bitmaps, byte-bitmap v2 trailer semantics and other
checksum algorithms remain unverified; they are not guessed or silently skipped.

Run `python -I -B scripts/verify-firmware-windows-readers.py` with the selected
Windows runtime for producer-boundary checks. These checks complement, and do
not replace, the real public CLI/MCP format receipts above.

Remaining helper-backed legacy variants are separate porting work.
Do not enable `--no-sandbox`, relax child-process policy or pass
arbitrary executable requests through a broker to simulate their availability.

The split-7z adapter joins only the numerically contiguous volumes found within
the selected extraction directory. It validates the first header and bounds both
volume count and joined size before decoding. A missing selected volume is a
reported extraction gap, not a silently ignored candidate. It does not discover
arbitrary sibling files on the host from a standalone `.001` input.

Android Sparse carving and materialization share one layout reader, including
extended v1 file/chunk headers. `sparse-map.json` records DONT_CARE source ranges:
zeroes are an output representation, not recovered original bytes. CRC checks
include those zeroes. The AOSP 34.0.5 producer's CRC-enabled skip-chunk output can
disagree with its own CRC reader; such original files remain failed checks.
Real no-CRC producer files and separately labelled authored CRC samples are
verified independently, without rewriting the failed original into a positive.

`windows-xad.m` supplies fixed ARC, StuffIt and StuffIt 5 readers. It maps an
existing read-only input handle, exposes bounded stream operations and never
opens archive-specified host paths. Data and resource forks become numbered
regular files. `archive-map.json` retains decoder name bytes, display encoding,
fork roles, sizes and digests. A display name is not authenticated identity;
the original archive retains the complete source records. Encrypted, link,
special and corrupt entries are not materialized. ARC continuation errors,
StuffIt header CRCs/name bounds and StuffIt 5 parent coordinates fail explicitly.
StuffIt X is not advertised by this bridge.

The pinned source inputs are MacPaw/XADMaster
`7cb9ee0abbb163f261e4cb74501e15067032319c` and UniversalDetector
`4eb832d999628edcd3d134e46bd35357c8c99a85`. Apply `xad-windows-paths.patch` to the
former. Compile their library source lists and this bridge for
`x86_64-w64-windows-gnu` using Clang 19, Objective-C runtime `gnustep-2.0`,
`-fobjc-exceptions -fexceptions -fblocks -fconstant-string-class=NSConstantString`
and stack protection. Link the XAD/UniversalDetector static libraries with
`--whole-archive`, then GNUstep, libobjc2, zlib, bzip2, WavPack and required
Windows system libraries using LLD. Enable DEP/ASLR/high-entropy VA and export
only the seven `reaxad_*` functions. Do not use PE `--gc-sections` here: it drops
required Objective-C v2 registration metadata from these archives. DLL loading
alone does not detect that error; verify class registration and an actual decode.

GNUstep Base 1.31.1 is rebuilt from official commit
`6307e474dd39e36eb2c5f6ee15ade8b51e337970` with the adjacent official configure
probe patch from commit `bace6f54fd5fb882cb3adc79c87cc82d5c6d9c70`.
Use the matching libobjc2 2.3 headers/runtime. Cross-configuration answers must
come from actual Windows ABI/runtime probes, not guessed configure cache values.
The admitted MSYS2 C++ runtime's exports differ from the cross compiler's older
import library. Generate its matching import library from that exact checked
DLL (`gendef`, then `x86_64-w64-mingw32-dlltool`) and place it before the older
toolchain library search directory. Preserve DATA exports, exact dependency
lengths/hashes and all upstream licenses. This is a native Windows runtime;
WSL is only used to compile its source and generate independent test samples.
These MinGW/Clang builds do not claim MSVC CFG instrumentation.
