// Executed inside the caller-selected GDB, never inside an inferior. Windows
// CreateProcess otherwise lets targets inherit GDB's private MI pipes in
// addition to their selected standard handles, keeping protocol output open
// after verified detach. Require a Python-enabled GDB and read back each flag.
const preventProtocolInheritance = `import ctypes
from ctypes import wintypes
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.GetStdHandle.argtypes=[wintypes.DWORD];k.GetStdHandle.restype=wintypes.HANDLE
k.GetFileType.argtypes=[wintypes.HANDLE];k.GetFileType.restype=wintypes.DWORD
k.SetHandleInformation.argtypes=[wintypes.HANDLE,wintypes.DWORD,wintypes.DWORD];k.SetHandleInformation.restype=wintypes.BOOL
k.GetHandleInformation.argtypes=[wintypes.HANDLE,ctypes.POINTER(wintypes.DWORD)];k.GetHandleInformation.restype=wintypes.BOOL
for selected in (-10,-11,-12):
 h=k.GetStdHandle(selected)
 if not h or h==ctypes.c_void_p(-1).value or k.GetFileType(h)!=3: raise RuntimeError('GDB protocol handle is not a pipe')
 if not k.SetHandleInformation(h,1,0): raise ctypes.WinError(ctypes.get_last_error())
 flags=wintypes.DWORD()
 if not k.GetHandleInformation(h,ctypes.byref(flags)) or flags.value&1: raise RuntimeError('GDB protocol handle remains inheritable')
print('REA_PRIVATE_STDIO_OK')`;

/** Trusted startup command changes only GDB's own protocol-handle inheritance. */
export const WINDOWS_GDB_PRIVATE_STDIO_COMMAND = `python exec(${JSON.stringify(preventProtocolInheritance)})`;
