#include "authority.hpp"
#include <winternl.h>
#include <cstddef>
#include <cstring>

namespace rea {

using QueryProcess = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
static QueryProcess queryProcess() {
  auto query = reinterpret_cast<QueryProcess>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  require(query != nullptr, "Read-only process inspection is unavailable", L"", ERROR_NOT_SUPPORTED);
  return query;
}

static DWORD selectedPid(napi_env env, napi_value value) {
  const auto number = numeric(env, value);
  require(number >= 1 && number <= MAXDWORD && number == static_cast<DWORD>(number),
          "Process observation requires a valid PID", L"", ERROR_INVALID_PARAMETER);
  return static_cast<DWORD>(number);
}

static bool ended(HANDLE process) {
  const auto state = WaitForSingleObject(process, 0);
  require(state == WAIT_OBJECT_0 || state == WAIT_TIMEOUT, "Read process observation liveness failed");
  return state == WAIT_OBJECT_0;
}

static std::string creationTime(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  require(GetProcessTimes(process, &created, &exited, &kernel, &user), "Read process creation identity failed");
  return std::to_string((static_cast<ULONGLONG>(created.dwHighDateTime) << 32) | created.dwLowDateTime);
}

template<class Value> static Value readValue(HANDLE process, const void* address) {
  require(address != nullptr, "Process structure pointer is null", L"", ERROR_INVALID_DATA);
  Value value{}; SIZE_T count = 0;
  require(ReadProcessMemory(process, address, &value, sizeof(value), &count) && count == sizeof(value),
          "Read process standard-handle structure failed");
  return value;
}

struct StandardHandles { HANDLE input; HANDLE output; HANDLE error; };

// The SDK deliberately reserves the standard-handle slots. Calibrate them
// against this host's actual GetStdHandle values before reading another x64
// process. No unsupported layout is guessed and no remote memory is written.
static StandardHandles readStandardHandles(HANDLE process) {
  USHORT machine = 0, nativeMachine = 0;
  require(IsWow64Process2(process, &machine, &nativeMachine) && machine == IMAGE_FILE_MACHINE_UNKNOWN &&
          nativeMachine == IMAGE_FILE_MACHINE_AMD64,
          "Durable output inspection currently requires a native x64 Windows process", L"", ERROR_NOT_SUPPORTED);
  PROCESS_BASIC_INFORMATION basic{}; ULONG size = 0;
  const auto status = queryProcess()(process, 0, &basic, sizeof(basic), &size);
  require(status >= 0 && size == sizeof(basic), "Read process PEB identity failed", L"", static_cast<DWORD>(status));
  const auto peb = readValue<PEB>(process, basic.PebBaseAddress);
  require(peb.ProcessParameters != nullptr, "Process parameters are absent", L"", ERROR_INVALID_DATA);
  const auto* address = reinterpret_cast<const unsigned char*>(peb.ProcessParameters) +
                        offsetof(RTL_USER_PROCESS_PARAMETERS, Reserved2) + 2 * sizeof(void*);
  return readValue<StandardHandles>(process, address);
}

static void calibrateStandardHandles() {
  const auto observed = readStandardHandles(GetCurrentProcess());
  const StandardHandles expected{GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)};
  require(expected.output != nullptr && expected.output != INVALID_HANDLE_VALUE &&
          observed.input == expected.input && observed.output == expected.output && observed.error == expected.error,
          "Host standard-handle layout could not be calibrated; output identity is unknown", L"", ERROR_NOT_SUPPORTED);
}

static Handle duplicateOutput(HANDLE process, HANDLE remote) {
  require(remote != nullptr && remote != INVALID_HANDLE_VALUE,
          "Inferior output handle is absent", L"", ERROR_INVALID_HANDLE);
  HANDLE local = nullptr;
  // The duplicated handle stays private to this read-only function. Neither it
  // nor write/seek authority is exposed to JavaScript or other native APIs.
  require(DuplicateHandle(process, remote, GetCurrentProcess(), &local, 0, FALSE, DUPLICATE_SAME_ACCESS),
          "Inspect inferior output handle failed");
  return Handle(local);
}

static FILE_ID_INFO regularFileIdentity(HANDLE handle) {
  require(GetFileType(handle) == FILE_TYPE_DISK, "Inferior output is not a durable disk file", L"", ERROR_NOT_SUPPORTED);
  FILE_ATTRIBUTE_TAG_INFO attributes{}; FILE_ID_INFO value{};
  require(GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, sizeof(attributes)) &&
          GetFileInformationByHandleEx(handle, FileIdInfo, &value, sizeof(value)), "Read output file identity failed");
  require((attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0,
          "Output destination must be a regular file", L"", ERROR_NOT_SUPPORTED);
  return value;
}

static bool sameFile(const FILE_ID_INFO& left, const FILE_ID_INFO& right) {
  return left.VolumeSerialNumber == right.VolumeSerialNumber &&
         std::memcmp(left.FileId.Identifier, right.FileId.Identifier, sizeof(left.FileId.Identifier)) == 0;
}

napi_value debuggerCall(napi_env env, const std::wstring& operation, const std::vector<napi_value>& args) {
  if (operation == L"debugger_output_file") {
    require(args.size() == 1, "Wrong output file observation argument count", L"", ERROR_INVALID_PARAMETER);
    const auto path = wide(env, args[0]);
    auto file = openFile(path, FILE_READ_ATTRIBUTES, false, FILE_SHARE_READ | FILE_SHARE_WRITE);
    regularFileIdentity(file->get());
    return identity(env, file->get(), path);
  }
  if (operation == L"debugger_process_start") {
    require(args.size() == 1, "Wrong process identity observation argument count", L"", ERROR_INVALID_PARAMETER);
    const auto pid = selectedPid(env, args[0]);
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
    if (!process.valid() && GetLastError() == ERROR_INVALID_PARAMETER) return null(env);
    require(process.valid(), "Read process identity is not permitted");
    return ended(process.get()) ? null(env) : string(env, creationTime(process.get()));
  }
  if (operation == L"debugger_process_debug_state") {
    require(args.size() == 1, "Wrong debugger-state observation argument count", L"", ERROR_INVALID_PARAMETER);
    const auto pid = selectedPid(env, args[0]);
    Handle process(OpenProcess(PROCESS_QUERY_INFORMATION | SYNCHRONIZE, FALSE, pid));
    if (!process.valid() && GetLastError() == ERROR_INVALID_PARAMETER) return null(env);
    require(process.valid(), "Read debugger state is not permitted");
    if (ended(process.get())) return null(env);
    BOOL attached = FALSE;
    require(CheckRemoteDebuggerPresent(process.get(), &attached), "Read debugger attachment state failed");
    const auto start = creationTime(process.get());
    if (ended(process.get())) return null(env);
    auto result = object(env);
    set(env, result, "pid", number(env, pid));
    set(env, result, "startTime", string(env, start));
    set(env, result, "attached", boolean(env, attached != FALSE));
    return result;
  }
  if (operation == L"debugger_inspect_stdio") {
    require(args.size() == 2, "Wrong inferior output observation argument count", L"", ERROR_INVALID_PARAMETER);
    calibrateStandardHandles();
    const auto pid = selectedPid(env, args[0]);
    const auto path = wide(env, args[1]);
    Handle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, pid));
    require(process.valid(), "Read inferior output identity is not permitted");
    require(!ended(process.get()), "Inferior ended before output identity was observed", L"", ERROR_NOT_FOUND);
    const auto start = creationTime(process.get());
    auto selected = openFile(path, FILE_READ_ATTRIBUTES, false, FILE_SHARE_READ | FILE_SHARE_WRITE);
    const auto expected = regularFileIdentity(selected->get());
    const auto before = readStandardHandles(process.get());
    auto output = duplicateOutput(process.get(), before.output);
    auto error = duplicateOutput(process.get(), before.error);
    require(sameFile(expected, regularFileIdentity(output.get())) && sameFile(expected, regularFileIdentity(error.get())),
            "Inferior stdout or stderr does not refer to the selected durable file", path, ERROR_INVALID_DATA);
    const auto after = readStandardHandles(process.get());
    require(before.output == after.output && before.error == after.error && !ended(process.get()),
            "Inferior standard handles changed during inspection", path, ERROR_INVALID_DATA);
    // Repeat duplication to reject numeric handle reuse during inspection.
    auto afterOutput = duplicateOutput(process.get(), after.output);
    auto afterError = duplicateOutput(process.get(), after.error);
    require(sameFile(expected, regularFileIdentity(afterOutput.get())) && sameFile(expected, regularFileIdentity(afterError.get())),
            "Inferior output identity changed during inspection", path, ERROR_INVALID_DATA);
    auto result = object(env);
    set(env, result, "pid", number(env, pid));
    set(env, result, "startTime", string(env, start));
    set(env, result, "output", identity(env, selected->get(), path));
    set(env, result, "stdoutVerified", boolean(env, true));
    set(env, result, "stderrVerified", boolean(env, true));
    return result;
  }
  throw Failure("Unknown read-only debugger operation", L"", ERROR_INVALID_PARAMETER);
}
} // namespace rea
