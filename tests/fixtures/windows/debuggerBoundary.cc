#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>

extern "C" __declspec(dllexport) void rea_boundary_pause() { Sleep(700); }

static bool writeBytes(HANDLE handle, const void* bytes, DWORD length) {
  DWORD count = 0;
  return WriteFile(handle, bytes, length, &count, nullptr) && count == length;
}

int main() {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  setvbuf(stdout, nullptr, _IONBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  printf("READY %lu\n", GetCurrentProcessId());
#ifdef REA_SWITCH_OUTPUT
  wchar_t path[32768]{};
  const DWORD length = GetModuleFileNameW(nullptr, path, 32700);
  if (!length || length >= 32700) return 81;
  wcscat_s(path, L".switched-output.bin");
  HANDLE other = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                             nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (other == INVALID_HANDLE_VALUE) return 82;
  if (!SetStdHandle(STD_OUTPUT_HANDLE, other) || !SetStdHandle(STD_ERROR_HANDLE, other)) return 83;
#endif
  rea_boundary_pause();
#ifdef REA_EXCEPTION
  const char marker[] = "BEFORE_EXCEPTION\n";
  if (!writeBytes(GetStdHandle(STD_OUTPUT_HANDLE), marker, sizeof(marker) - 1)) return 84;
  RaiseException(0xe0424242, EXCEPTION_NONCONTINUABLE, 0, nullptr);
  return 85;
#else
  unsigned char bytes[65536];
  for (unsigned i = 0; i < sizeof(bytes); ++i) bytes[i] = static_cast<unsigned char>(i % 251);
  for (int i = 0; i < 4; ++i)
    if (!writeBytes(GetStdHandle(STD_OUTPUT_HANDLE), bytes, sizeof(bytes))) return 86;
  const char marker[] = "BOUNDARY_STDERR\n";
  if (!writeBytes(GetStdHandle(STD_ERROR_HANDLE), marker, sizeof(marker) - 1)) return 87;
  return 0;
#endif
}
