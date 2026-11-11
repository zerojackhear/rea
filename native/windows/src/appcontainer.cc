#include "authority.hpp"
#include <userenv.h>
#include <sddl.h>
#include <netfw.h>
#include <objbase.h>
#include <shlobj.h>

namespace rea {

Sandbox::~Sandbox() {
  // The runtime keeps job leases until verified settlement. Closing the JS
  // process owner still terminates its job even while these leases exist.
  for (auto& job : jobs) TerminateJobObject(job.get(), 1);
}

void Sandbox::verifyStopped() {
  for (auto& job : jobs) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};
    require(QueryInformationJobObject(job.get(), JobObjectBasicAccountingInformation,
                                      &state, sizeof(state), nullptr),
            "Read AppContainer job settlement failed", profilePath);
    require(state.ActiveProcesses == 0, "AppContainer process is still active", profilePath, ERROR_BUSY);
  }
  jobs.clear();
}

void Sandbox::close() {
  verifyStopped();
  if (!created) return;
  directoryLeases.clear();
  if (!deletionConfirmed) {
    const auto status = DeleteAppContainerProfile(name.c_str());
    require(SUCCEEDED(status), "Delete owned AppContainer profile failed", profilePath,
            static_cast<DWORD>(status));
    deletionConfirmed = true;
  }
  // Keep the profile identity on a failed verification; never infer removal
  // from DeriveAppContainerSidFromAppContainerName, which is deterministic.
  if (!profilePath.empty()) {
    const auto attributes = GetFileAttributesW(profilePath.c_str());
    const auto error = GetLastError();
    require(attributes == INVALID_FILE_ATTRIBUTES &&
                (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND),
            "Owned AppContainer profile removal is unverified", profilePath,
            attributes == INVALID_FILE_ATTRIBUTES ? error : ERROR_DIR_NOT_EMPTY);
  }
  created = false;
}

void Sandbox::create() {
  std::array<unsigned char, 16> random{};
  require(BCryptGenRandom(nullptr, random.data(), random.size(), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0,
          "Create AppContainer identity failed", L"", ERROR_GEN_FAILURE);
  constexpr wchar_t hex[] = L"0123456789abcdef";
  name = L"REA.Firmware.";
  for (auto value : random) { name += hex[value >> 4]; name += hex[value & 15]; }
  PSID raw = nullptr;
  const auto status = CreateAppContainerProfile(name.c_str(), L"REA firmware extraction",
                                               L"Owned static analysis workspace", nullptr, 0, &raw);
  require(SUCCEEDED(status), "Create unique AppContainer profile failed", L"", static_cast<DWORD>(status));
  created = true;
  struct SidOwner { PSID sid; ~SidOwner() { FreeSid(sid); } } owner{raw};
  sid.resize(GetLengthSid(raw));
  require(CopySid(static_cast<DWORD>(sid.size()), sid.data(), raw), "Retain AppContainer SID failed");
  LPWSTR text = nullptr;
  require(ConvertSidToStringSidW(sid.data(), &text), "Format AppContainer identity failed");
  struct LocalOwner { HLOCAL value; ~LocalOwner() { LocalFree(value); } } textOwner{text};
  LPWSTR path = nullptr;
  const auto folder = GetAppContainerFolderPath(text, &path);
  require(SUCCEEDED(folder), "Read owned AppContainer profile path failed", L"", static_cast<DWORD>(folder));
  profilePath = path;
  CoTaskMemFree(path);
  require(profilePath.size() > 3 && profilePath.substr(profilePath.size() - 3) == L"\\AC",
          "Unexpected owned AppContainer storage layout", profilePath, ERROR_NOT_SUPPORTED);
  // The API names the AC subdirectory. Own and restrict the entire package's
  // storage, including sibling Settings/LocalState directories.
  profilePath.resize(profilePath.size() - 3);
  // A capability-free token must not inherit a loopback exemption. Read only;
  // never add/remove exemptions or change global firewall policy.
  DWORD count = 0;
  PSID_AND_ATTRIBUTES exemptions = nullptr;
  HMODULE library = LoadLibraryExW(L"FirewallAPI.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  require(library != nullptr, "Load system AppContainer network policy reader failed", profilePath);
  struct Library { HMODULE value; ~Library() { FreeLibrary(value); } } loaded{library};
  const auto query = reinterpret_cast<decltype(&NetworkIsolationGetAppContainerConfig)>(
      GetProcAddress(library, "NetworkIsolationGetAppContainerConfig"));
  require(query != nullptr, "System AppContainer network policy reader is unavailable", profilePath);
  const auto observed = query(&count, &exemptions);
  require(observed == ERROR_SUCCESS, "Read AppContainer loopback exemptions failed", profilePath, observed);
  struct Exemptions {
    DWORD count; PSID_AND_ATTRIBUTES value;
    ~Exemptions() {
      if (!value) return;
      for (DWORD i = 0; i < count; ++i) HeapFree(GetProcessHeap(), 0, value[i].Sid);
      HeapFree(GetProcessHeap(), 0, value);
    }
  } list{count, exemptions};
  for (DWORD i = 0; i < count; ++i)
    require(!EqualSid(exemptions[i].Sid, sid.data()), "Fresh AppContainer has a loopback exemption", profilePath, ERROR_ACCESS_DENIED);
}

std::vector<std::wstring> sandboxEnvironment(const std::wstring& command, const std::wstring& cwd) {
  std::array<wchar_t, 32768> windows{}, system{};
  const auto wn = GetWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
  const auto sn = GetSystemDirectoryW(system.data(), static_cast<UINT>(system.size()));
  require(wn > 0 && wn < windows.size() && sn > 0 && sn < system.size(), "Resolve AppContainer system paths failed");
  LPWSTR raw = nullptr;
  const auto status = SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &raw);
  require(SUCCEEDED(status), "Resolve AppContainer profile initialization path failed", L"", static_cast<DWORD>(status));
  const std::wstring local = raw;
  CoTaskMemFree(raw);
  // LOCALAPPDATA is needed by CreateProcess's profile initialization. It does
  // not confer access; the capability-free SID is checked by the filesystem.
  return {L"LOCALAPPDATA=" + local, L"SystemRoot=" + std::wstring(windows.data()),
          L"WINDIR=" + std::wstring(windows.data()),
          L"PATH=" + command.substr(0, command.find_last_of(L'\\')) + L";" + system.data(),
          L"TEMP=" + cwd, L"TMP=" + cwd, L"TMPDIR=" + cwd, L"NO_COLOR=1",
          L"OMP_NUM_THREADS=1", L"OPENBLAS_NUM_THREADS=1", L"RAYON_NUM_THREADS=1"};
}

void verifySandboxProcess(HANDLE process, Sandbox& sandbox) {
  HANDLE raw;
  require(OpenProcessToken(process, TOKEN_QUERY, &raw), "Read suspended AppContainer token failed");
  Handle token(raw);
  DWORD bytes = 0, app = 0;
  require(GetTokenInformation(token.get(), TokenIsAppContainer, &app, sizeof(app), &bytes) && app == 1,
          "Suspended child is not an AppContainer", sandbox.profilePath, ERROR_ACCESS_DENIED);
  GetTokenInformation(token.get(), TokenAppContainerSid, nullptr, 0, &bytes);
  std::vector<unsigned char> identity(bytes);
  require(GetTokenInformation(token.get(), TokenAppContainerSid, identity.data(), bytes, &bytes) &&
              EqualSid(reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(identity.data())->TokenAppContainer,
                       sandbox.sid.data()),
          "Suspended AppContainer SID differs from its owner", sandbox.profilePath, ERROR_ACCESS_DENIED);
  GetTokenInformation(token.get(), TokenCapabilities, nullptr, 0, &bytes);
  std::vector<unsigned char> capabilities(bytes);
  require(GetTokenInformation(token.get(), TokenCapabilities, capabilities.data(), bytes, &bytes) &&
              reinterpret_cast<TOKEN_GROUPS*>(capabilities.data())->GroupCount == 0,
          "Suspended AppContainer has unexpected capabilities", sandbox.profilePath, ERROR_ACCESS_DENIED);
  PROCESS_MITIGATION_CHILD_PROCESS_POLICY policy{};
  require(GetProcessMitigationPolicy(process, ProcessChildProcessPolicy, &policy, sizeof(policy)) &&
              policy.NoChildProcessCreation && !policy.AuditNoChildProcessCreation && !policy.AllowSecureProcessCreation,
          "Suspended AppContainer permits child creation", sandbox.profilePath, ERROR_ACCESS_DENIED);
}

} // namespace rea
