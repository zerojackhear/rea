#include "authority.hpp"

namespace rea {

// Resolve optional terminal APIs without making older hosts lose unrelated
// native controls when their kernel does not export ConPTY.
struct ConsoleApi {
  decltype(&CreatePseudoConsole) create;
  decltype(&ResizePseudoConsole) resize;
  decltype(&ClosePseudoConsole) close;
  bool available() const { return create && resize && close; }
};
static const ConsoleApi& consoleApi() {
  static const ConsoleApi api = [] {
    auto kernel = GetModuleHandleW(L"kernel32.dll");
    return ConsoleApi{
      reinterpret_cast<decltype(&CreatePseudoConsole)>(GetProcAddress(kernel, "CreatePseudoConsole")),
      reinterpret_cast<decltype(&ResizePseudoConsole)>(GetProcAddress(kernel, "ResizePseudoConsole")),
      reinterpret_cast<decltype(&ClosePseudoConsole)>(GetProcAddress(kernel, "ClosePseudoConsole"))};
  }();
  return api;
}

Process::~Process() {
  if (!launchReady && process.valid()) TerminateProcess(process.get(), 1);
  if ((sandbox || console) && job.valid()) TerminateJobObject(job.get(), 1);
  if (console) {
    // Last-resort abandoned-owner cleanup drops output before closing ConPTY.
    // Normal cleanup uses an async close while the consumer continues draining.
    stdoutRead.reset(); stdinWrite.reset();
    if (consoleCloser.joinable()) consoleCloser.join();
    else consoleApi().close(console);
  }
}

class Attributes {
  std::vector<unsigned char> storage_;
public:
  explicit Attributes(DWORD count) {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, count, 0, &size);
    storage_.resize(size);
    require(InitializeProcThreadAttributeList(get(), count, 0, &size), "Initialize process attributes failed");
  }
  ~Attributes() { DeleteProcThreadAttributeList(get()); }
  LPPROC_THREAD_ATTRIBUTE_LIST get() { return reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage_.data()); }
  void add(DWORD_PTR key, void* value, SIZE_T size) {
    require(UpdateProcThreadAttribute(get(), 0, key, value, size, nullptr, nullptr),
            "Windows atomic process attribute is unavailable");
  }
};

// A nonzero memory limit is a commit limit for the whole job; zero keeps only
// kill-on-owner-close. The policy read back must match exactly.
static Handle createJob(ULONGLONG memoryLimit = 0, bool killOnClose = true) {
  Handle job(CreateJobObjectW(nullptr, nullptr));
  require(job.valid(), "Create owned Job Object failed");
  const DWORD flags = (killOnClose ? JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE : 0) | (memoryLimit != 0 ? JOB_OBJECT_LIMIT_JOB_MEMORY : 0);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION policy{};
  policy.BasicLimitInformation.LimitFlags = flags;
  policy.JobMemoryLimit = static_cast<SIZE_T>(memoryLimit);
  require(SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &policy, sizeof(policy)),
          "Apply kill-on-owner-close Job Object policy failed");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION actual{};
  require(QueryInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &actual, sizeof(actual), nullptr),
          "Read Job Object policy failed");
  require(actual.BasicLimitInformation.LimitFlags == flags,
          "Job Object policy permits unexpected breakaway", L"", ERROR_ACCESS_DENIED);
  require(memoryLimit == 0 || static_cast<ULONGLONG>(actual.JobMemoryLimit) == memoryLimit,
          "Job Object memory limit was not applied exactly", L"", ERROR_INVALID_PARAMETER);
  return job;
}

// Associate a private completion port before any process joins the job, so
// the job's commit-limit notification cannot be missed.
static Handle createNotifications(HANDLE job) {
  Handle port(CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1));
  require(port.valid(), "Create owned Job Object notification port failed");
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT association{};
  association.CompletionKey = job;
  association.CompletionPort = port.get();
  require(SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &association, sizeof(association)),
          "Associate owned Job Object notification port failed");
  return port;
}

// JavaScript numbers cross the boundary as doubles; accept only an exact
// positive safe integer that is a whole number of pages, so read-back is exact.
static ULONGLONG jobMemoryLimit(napi_env env, napi_value value) {
  const double requested = numeric(env, value);
  require(requested >= 1 && requested <= 9007199254740991.0 &&
              static_cast<double>(static_cast<ULONGLONG>(requested)) == requested,
          "Job memory limit must be a positive safe integer", L"", ERROR_INVALID_PARAMETER);
  SYSTEM_INFO system{};
  GetSystemInfo(&system);
  const auto limit = static_cast<ULONGLONG>(requested);
  require(system.dwPageSize != 0 && limit % system.dwPageSize == 0,
          "Job memory limit must be a whole number of pages", L"", ERROR_INVALID_PARAMETER);
  return limit;
}

// An affinity mask is meaningful only inside one processor group, so only a
// process occupying exactly one group has a group a child can inherit. A
// process whose threads span groups, or whose membership cannot be read, has no
// single group.
static bool singleProcessorGroup(HANDLE process, USHORT& group) {
  USHORT count = 1;
  std::array<USHORT, 1> groups{};
  if (!GetProcessGroupAffinity(process, &count, groups.data()) || count != 1) return false;
  group = groups[0];
  return true;
}

static void pipe(Handle& read, Handle& write, bool parentReads = true) {
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE rawRead, rawWrite;
  // Match the bounded native read chunk. The 4 KiB default repeatedly parks
  // block-buffered producers between polls (e.g. TShark's field glossary).
  require(CreatePipe(&rawRead, &rawWrite, &attributes, 65536), "Create owned process output pipe failed");
  read.reset(rawRead); write.reset(rawWrite);
  require(SetHandleInformation(parentReads ? read.get() : write.get(), HANDLE_FLAG_INHERIT, 0), "Protect parent process pipe handle inheritance failed");
}

std::unique_ptr<Process> spawnProcess(const std::wstring& command, const std::wstring& commandLine,
                                    const std::wstring& cwd, const std::vector<std::wstring>& environment,
                                    bool protocolStdin, ULONGLONG memoryLimit, std::shared_ptr<Sandbox> sandbox,
                                    const COORD* terminalSize, bool debuggerLeaderOnly) {
  const auto executable = ordinaryDriveSeparators(command);
  require(executable.size() >= 3 && executable[1] == L':' && executable[2] == L'\\',
          "Owned Windows process requires an absolute executable path", command, ERROR_INVALID_PARAMETER);
  require(!terminalSize || (!sandbox && protocolStdin && consoleApi().available()),
          "Native terminal requires ConPTY and its own input; it is not an AppContainer launch", command, ERROR_NOT_SUPPORTED);
  auto result = std::make_unique<Process>();
  require(!debuggerLeaderOnly || (!sandbox && !terminalSize && memoryLimit == 0 && protocolStdin),
          "Debugger leader ownership cannot replace isolation or terminal controls", command, ERROR_INVALID_PARAMETER);
  result->debuggerLeaderOnly = debuggerLeaderOnly;
  // A debugger does not own the lifetime of its inferior. Its private job
  // observes membership but must not kill a verified detached target on close.
  result->job = createJob(memoryLimit, !debuggerLeaderOnly);
  result->sandbox = std::move(sandbox);
  if (result->sandbox) {
    result->sandbox->verifyStopped();
    HANDLE lease;
    require(DuplicateHandle(GetCurrentProcess(), result->job.get(), GetCurrentProcess(), &lease, 0, FALSE,
                            DUPLICATE_SAME_ACCESS), "Retain AppContainer job settlement lease failed");
    result->sandbox->jobs.emplace_back(lease);
  }
  if (memoryLimit != 0) {
    result->notifications = createNotifications(result->job.get());
    result->memoryLimit = memoryLimit;
  }
  Handle stdoutWrite, stderrWrite;
  pipe(result->stdoutRead, stdoutWrite);
  if (!terminalSize) pipe(result->stderrRead, stderrWrite);
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  Handle input;
  if (protocolStdin) pipe(input, result->stdinWrite, false);
  else {
    input.reset(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    require(input.valid(), "Open owned process null input failed");
  }
  if (terminalSize) {
    const auto status = consoleApi().create(*terminalSize, input.get(), stdoutWrite.get(), 0, &result->console);
    require(SUCCEEDED(status), "Create native pseudoconsole failed", command, static_cast<DWORD>(status));
    result->hasTerminal = true;
  }
  Attributes attributes(result->sandbox ? 4 : 2);
  SECURITY_CAPABILITIES securityCapabilities{};
  DWORD childPolicy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
  if (result->sandbox) {
    securityCapabilities.AppContainerSid = result->sandbox->sid.data();
    attributes.add(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &securityCapabilities, sizeof(securityCapabilities));
    attributes.add(PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &childPolicy, sizeof(childPolicy));
  }
  HANDLE job = result->job.get();
  attributes.add(PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job));
  std::array<HANDLE, 3> inherited{input.get(), stdoutWrite.get(), stderrWrite.get()};
  if (terminalSize)
    attributes.add(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, result->console, sizeof(result->console));
  else attributes.add(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.data(), sizeof(inherited));
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  // Explicit null std handles force console initialization to use this PTY,
  // instead of copying a redirected CLI/MCP host's protocol pipes.
  if (!terminalSize) {
    startup.StartupInfo.hStdInput = input.get();
    startup.StartupInfo.hStdOutput = stdoutWrite.get();
    startup.StartupInfo.hStdError = stderrWrite.get();
  }
  startup.lpAttributeList = attributes.get();
  // Windows environment names use ordinal case-insensitive comparison, not
  // locale collation or JavaScript's expanding Unicode uppercase conversion.
  auto orderedEnvironment = result->sandbox ? sandboxEnvironment(executable, cwd) : environment;
  auto keyLength = [&](const std::wstring& entry) {
    const auto end = entry.find(L'=', entry.front() == L'=' ? 1 : 0);
    require(end != std::wstring::npos && end > 0, "Invalid child environment name", command,
            ERROR_INVALID_PARAMETER);
    return static_cast<int>(end);
  };
  for (const auto& entry : orderedEnvironment) {
    require(!entry.empty(), "Empty child environment entry", command, ERROR_INVALID_PARAMETER);
    keyLength(entry);
  }
  auto compareNames = [&](const std::wstring& left, const std::wstring& right) {
    const auto result = CompareStringOrdinal(left.data(), keyLength(left), right.data(), keyLength(right), TRUE);
    require(result != 0, "Compare Windows environment names failed", command);
    return result;
  };
  std::stable_sort(orderedEnvironment.begin(), orderedEnvironment.end(),
                   [&](const std::wstring& left, const std::wstring& right) {
                     return compareNames(left, right) == CSTR_LESS_THAN;
                   });
  std::vector<std::wstring> uniqueEnvironment;
  for (auto& entry : orderedEnvironment) {
    if (!uniqueEnvironment.empty() && compareNames(uniqueEnvironment.back(), entry) == CSTR_EQUAL)
      uniqueEnvironment.back() = std::move(entry);
    else uniqueEnvironment.push_back(std::move(entry));
  }
  std::vector<wchar_t> variables;
  for (const auto& entry : uniqueEnvironment) {
    variables.insert(variables.end(), entry.begin(), entry.end()); variables.push_back(L'\0');
  }
  variables.push_back(L'\0');
  if (uniqueEnvironment.empty()) variables.push_back(L'\0');
  std::vector<wchar_t> line(commandLine.begin(), commandLine.end()); line.push_back(L'\0');
  PROCESS_INFORMATION process{};
  require(CreateProcessW(executable.c_str(), line.data(), nullptr, nullptr, terminalSize ? FALSE : TRUE,
                         CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
                             (terminalSize ? 0 : (result->sandbox ? DETACHED_PROCESS : CREATE_NO_WINDOW)),
                         variables.data(), cwd.empty() ? nullptr : cwd.c_str(), &startup.StartupInfo, &process),
          "Create process atomically inside owned Job Object failed", command);
  result->process.reset(process.hProcess);
  Handle thread(process.hThread);
  result->pid = process.dwProcessId;
  // An elevated token may default file ownership to Administrators. Normalize
  // only the suspended child's default owner so its runtime files belong to the
  // current user; the caller's token and privileges are not modified.
  HANDLE rawToken;
  require(OpenProcessToken(result->process.get(), TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, &rawToken),
          "Open suspended process default-owner token failed", command);
  Handle token(rawToken);
  DWORD tokenSize = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &tokenSize);
  std::vector<unsigned char> tokenUser(tokenSize);
  require(GetTokenInformation(token.get(), TokenUser, tokenUser.data(), tokenSize, &tokenSize),
          "Read suspended process user identity failed", command);
  TOKEN_OWNER owner{reinterpret_cast<TOKEN_USER*>(tokenUser.data())->User.Sid};
  require(SetTokenInformation(token.get(), TokenOwner, &owner, sizeof(owner)),
          "Set suspended process file owner failed", command);
  // A mask names processors inside one processor group, and Windows assigns a
  // new process to a group of its own choosing, so a mask belonging to another
  // group is rejected (ERROR_INVALID_PARAMETER). An unconstrained caller, whose
  // mask is its group's whole active set, asks for no bound the child's own
  // group cannot give, so such a child keeps that group's default and the spawn
  // proceeds. A narrower mask is a deliberate CPU constraint that a child in
  // another group cannot express, and silently widening it would hand the
  // provider tree the whole group, so that spawn fails naming the constraint.
  DWORD_PTR affinity = 0, systemAffinity = 0;
  require(GetProcessAffinityMask(GetCurrentProcess(), &affinity, &systemAffinity),
          "Read caller process affinity failed", command);
  USHORT callerGroup = 0, childGroup = 0;
  const bool sharedGroup = singleProcessorGroup(GetCurrentProcess(), callerGroup) &&
                           singleProcessorGroup(result->process.get(), childGroup) &&
                           callerGroup == childGroup;
  if (affinity != 0 && sharedGroup)
    require(SetProcessAffinityMask(result->process.get(), affinity), "Preserve caller process affinity failed", command);
  else
    require(affinity == 0 || affinity == systemAffinity,
            "Caller CPU affinity cannot bound an owned process in another processor group", command,
            ERROR_INVALID_PARAMETER);
  const DWORD priority = GetPriorityClass(GetCurrentProcess());
  require(priority != 0 && SetPriorityClass(result->process.get(), priority),
          "Preserve caller process priority failed", command);
  BOOL assigned = FALSE;
  if (!IsProcessInJob(result->process.get(), result->job.get(), &assigned) || !assigned) {
    TerminateJobObject(result->job.get(), 1);
    throw Failure("Suspended process has no owned Job Object membership", command, ERROR_ACCESS_DENIED);
  }
  if (result->sandbox) verifySandboxProcess(result->process.get(), *result->sandbox);
  require(ResumeThread(thread.get()) != MAXDWORD, "Resume job-owned process failed", command);
  result->launchReady = true;
  return result;
}

static napi_value readOutput(napi_env env, Handle& read, bool& ended) {
  constexpr size_t kMaximumReadPerPoll = 1024 * 1024;
  std::array<unsigned char, 65536> chunk;
  std::vector<unsigned char> bytes;
  if (!read.valid()) ended = true;
  else {
    while (bytes.size() < kMaximumReadPerPoll) {
      DWORD available = 0;
      if (!PeekNamedPipe(read.get(), nullptr, 0, nullptr, &available, nullptr)) {
        require(GetLastError() == ERROR_BROKEN_PIPE,
                "Observe owned process output failed");
        read.reset();
        ended = true;
        break;
      }
      if (available == 0) break;
      const auto requested = static_cast<DWORD>(std::min<size_t>(
          {available, chunk.size(), kMaximumReadPerPoll - bytes.size()}));
      DWORD count = 0;
      require(ReadFile(read.get(), chunk.data(), requested, &count, nullptr) &&
                  count > 0,
              "Read owned process output failed");
      bytes.insert(bytes.end(), chunk.begin(), chunk.begin() + count);
    }
  }
  napi_value result;
  check(napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &result));
  return result;
}

static DWORD activeProcesses(Process& process) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};
  require(QueryInformationJobObject(process.job.get(), JobObjectBasicAccountingInformation, &state, sizeof(state), nullptr),
          "Observe owned Job Object settlement failed");
  return state.ActiveProcesses;
}

// Snapshot membership from the retained job, then bind each observation to an
// opened process handle and check that handle's membership. A reused PID alone
// never establishes ownership. Image and parent facts come from that handle.
static napi_value sampleProcesses(napi_env env, Process& process, napi_value requested) {
  const auto amount = numeric(env, requested);
  require(amount >= 1 && amount <= 9007199254740991.0 && static_cast<double>(static_cast<ULONGLONG>(amount)) == amount,
          "Process sample limit must be a positive safe integer", L"", ERROR_INVALID_PARAMETER);
  // Bound one sample to 128 KiB of identifiers and 8 MiB of image text.
  const auto capacity = static_cast<DWORD>(std::min(amount, 16384.0));
  std::vector<unsigned char> storage(offsetof(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList) +
                                     capacity * sizeof(ULONG_PTR));
  auto* listed = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
  const auto complete = QueryInformationJobObject(process.job.get(), JobObjectBasicProcessIdList,
      listed, static_cast<DWORD>(storage.size()), nullptr);
  const auto error = complete ? ERROR_SUCCESS : GetLastError();
  require(complete || error == ERROR_MORE_DATA, "Enumerate owned Job Object processes failed", L"", error);
  require(listed->NumberOfProcessIdsInList <= capacity,
          "Job Object returned an invalid identifier count", L"", ERROR_INVALID_DATA);
  struct BasicInformation {
    LONG exitStatus; void* peb; ULONG_PTR affinity; LONG priority;
    ULONG_PTR pid; ULONG_PTR parent;
  };
  using QueryBasic = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  const auto query = reinterpret_cast<QueryBasic>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  require(query != nullptr, "Process parent identity query is unavailable", L"", ERROR_NOT_SUPPORTED);
  napi_value rows;
  check(napi_create_array(env, &rows));
  uint32_t count = 0, unreadable = 0;
  size_t textBytes = 0;
  bool limited = !complete || listed->NumberOfAssignedProcesses > listed->NumberOfProcessIdsInList;
  for (DWORD index = 0; index < listed->NumberOfProcessIdsInList; ++index) {
    const auto pid = listed->ProcessIdList[index];
    if (pid == 0 || pid > MAXDWORD) { ++unreadable; continue; }
    Handle member(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                              FALSE, static_cast<DWORD>(pid)));
    BOOL belongs = FALSE;
    if (!member.valid() || !IsProcessInJob(member.get(), process.job.get(), &belongs) || !belongs) {
      ++unreadable; continue;
    }
    FILETIME created{}, exited{}, kernel{}, user{};
    BasicInformation basic{};
    ULONG returned = 0;
    std::vector<wchar_t> path(32768);
    DWORD length = static_cast<DWORD>(path.size());
    if (query(member.get(), 0, &basic, sizeof(basic), &returned) < 0 || returned != sizeof(basic) ||
        basic.pid != pid || basic.parent > MAXDWORD ||
        !GetProcessTimes(member.get(), &created, &exited, &kernel, &user) ||
        !QueryFullProcessImageNameW(member.get(), 0, path.data(), &length)) {
      ++unreadable; continue;
    }
    if (textBytes + length * sizeof(wchar_t) > 8 * 1024 * 1024) { limited = true; break; }
    textBytes += length * sizeof(wchar_t);
    const ULONGLONG stamp = (static_cast<ULONGLONG>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    auto row = object(env);
    set(env, row, "pid", number(env, static_cast<double>(pid)));
    set(env, row, "parentPid", number(env, static_cast<double>(basic.parent)));
    set(env, row, "imagePath", string(env, std::wstring(path.data(), length)));
    set(env, row, "creationTime", string(env, std::to_string(stamp)));
    check(napi_set_element(env, rows, count++, row));
  }
  auto result = object(env);
  set(env, result, "rows", rows);
  set(env, result, "limited", boolean(env, limited));
  set(env, result, "unreadable", number(env, unreadable));
  return result;
}

// Drain queued job notifications without waiting. The commit-limit message is
// posted when an allocation fails, before the process can exit. An observed
// exit must be followed by another drain before its diagnostics are published.
static void observeNotifications(Process& process) {
  if (!process.notifications.valid()) return;
  DWORD message = 0;
  ULONG_PTR key = 0;
  LPOVERLAPPED detail = nullptr;
  while (GetQueuedCompletionStatus(process.notifications.get(), &message, &key, &detail, 0)) {
    if (key == reinterpret_cast<ULONG_PTR>(process.job.get()) && message == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT)
      process.memoryLimitReached = true;
  }
  const auto error = GetLastError();
  require(detail == nullptr && error == WAIT_TIMEOUT, "Observe owned Job Object notifications failed", L"", error);
}

static ULONGLONG peakJobMemory(Process& process) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION state{};
  require(QueryInformationJobObject(process.job.get(), JobObjectExtendedLimitInformation, &state, sizeof(state), nullptr),
          "Observe owned Job Object memory failed");
  return static_cast<ULONGLONG>(state.PeakJobMemoryUsed);
}

static napi_value callerToken(napi_env env) {
  HANDLE raw;
  require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &raw), "Read caller token failed");
  Handle token(raw);
  DWORD size;
  TOKEN_ELEVATION elevation{};
  require(GetTokenInformation(token.get(), TokenElevation, &elevation, sizeof(elevation), &size), "Read caller elevation failed");
  std::vector<unsigned char> user(4096), owner(4096), integrity(4096);
  require(GetTokenInformation(token.get(), TokenUser, user.data(), user.size(), &size) &&
          GetTokenInformation(token.get(), TokenOwner, owner.data(), owner.size(), &size) &&
          GetTokenInformation(token.get(), TokenIntegrityLevel, integrity.data(), integrity.size(), &size),
          "Read caller token observations failed");
  HANDLE rawImpersonation;
  require(DuplicateToken(token.get(), SecurityIdentification, &rawImpersonation), "Observe caller group membership failed");
  Handle impersonation(rawImpersonation);
  std::array<unsigned char, SECURITY_MAX_SID_SIZE> administrators;
  DWORD administratorSize = administrators.size();
  require(CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, administrators.data(), &administratorSize),
          "Create administrator group identity failed");
  BOOL administrator = FALSE, assigned = FALSE;
  require(CheckTokenMembership(impersonation.get(), administrators.data(), &administrator), "Read caller administrator membership failed");
  require(IsProcessInJob(GetCurrentProcess(), nullptr, &assigned), "Read caller job membership failed");
  const auto sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(integrity.data())->Label.Sid;
  auto result = object(env);
  set(env, result, "elevated", boolean(env, elevation.TokenIsElevated != 0));
  set(env, result, "administrator", boolean(env, administrator != FALSE));
  set(env, result, "integrityLevel", number(env, *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid) - 1)));
  set(env, result, "defaultOwnerIsUser", boolean(env, EqualSid(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid,
                                                              reinterpret_cast<TOKEN_OWNER*>(owner.data())->Owner)));
  set(env, result, "inJob", boolean(env, assigned != FALSE));
  return result;
}

struct InputWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  napi_ref processReference = nullptr;
  Process* process;
  Handle pipe;
  std::vector<unsigned char> bytes;
  size_t written = 0;
  std::unique_ptr<Failure> failure;
  explicit InputWork(Process& process) : process(&process) {}
};

static void writeInput(napi_env, void* pointer) {
  auto& work = *static_cast<InputWork*>(pointer);
  try {
    // Anonymous pipe writes may block. Keep them off the JS thread so output
    // polling and job termination remain live while a child stops reading.
    while (work.written < work.bytes.size()) {
      DWORD written = 0;
      const auto count = static_cast<DWORD>(std::min<size_t>(65536, work.bytes.size() - work.written));
      require(WriteFile(work.pipe.get(), work.bytes.data() + work.written, count, &written, nullptr),
              "Write owned process input failed");
      require(written > 0, "Owned process input write made no progress", L"", ERROR_WRITE_FAULT);
      work.written += written;
    }
  } catch (const Failure& failure) {
    work.failure = std::make_unique<Failure>(failure);
  } catch (const std::exception& failure) {
    work.failure = std::make_unique<Failure>(failure.what(), L"", ERROR_GEN_FAILURE);
  }
}

static void completeInput(napi_env env, napi_status status, void* pointer) {
  std::unique_ptr<InputWork> work(static_cast<InputWork*>(pointer));
  work->process->inputPending = false;
  if (work->failure) napi_reject_deferred(env, work->deferred, failureValue(env, *work->failure));
  else if (status != napi_ok)
    napi_reject_deferred(env, work->deferred, failureValue(env, Failure("Owned process input worker was cancelled", L"", ERROR_OPERATION_ABORTED)));
  else napi_resolve_deferred(env, work->deferred, number(env, work->written));
  napi_delete_reference(env, work->processReference);
  napi_delete_async_work(env, work->work);
}

static napi_value inputWrite(napi_env env, napi_value owner, Process& process, napi_value input) {
  require(process.stdinWrite.valid(), "Owned process has no writable input", L"", ERROR_BROKEN_PIPE);
  require(!process.inputPending, "Owned process input already has a pending write", L"", ERROR_BUSY);
  auto work = std::make_unique<InputWork>(process);
  void* bytes = nullptr;
  size_t size = 0;
  bool buffer = false;
  check(napi_is_buffer(env, input, &buffer));
  require(buffer, "Owned process input must be a Buffer", L"", ERROR_INVALID_PARAMETER);
  check(napi_get_buffer_info(env, input, &bytes, &size));
  require(!process.hasTerminal || size <= 65536, "Terminal input chunk exceeds 64 KiB", L"", ERROR_INVALID_PARAMETER);
  if (size > 0) work->bytes.assign(static_cast<unsigned char*>(bytes), static_cast<unsigned char*>(bytes) + size);
  HANDLE pipe;
  require(DuplicateHandle(GetCurrentProcess(), process.stdinWrite.get(), GetCurrentProcess(), &pipe,
                          0, FALSE, DUPLICATE_SAME_ACCESS), "Retain owned process input handle failed");
  work->pipe.reset(pipe);
  napi_value promise;
  check(napi_create_promise(env, &work->deferred, &promise));
  check(napi_create_reference(env, owner, 1, &work->processReference));
  try {
    check(napi_create_async_work(env, nullptr, string(env, std::string("REA owned process input")),
                               writeInput, completeInput, work.get(), &work->work));
    check(napi_queue_async_work(env, work->work));
    process.inputPending = true;
  } catch (...) {
    if (work->work) napi_delete_async_work(env, work->work);
    napi_delete_reference(env, work->processReference);
    throw;
  }
  work.release();
  return promise;
}

static void settleConsoleClose(Process& process) {
  if (process.consoleClosing && process.consoleCloseFinished.load()) {
    process.consoleCloser.join();
    process.console = nullptr;
    process.consoleClosing = false;
  }
}
static napi_value startConsoleClose(napi_env env, Process& process) {
  require(process.hasTerminal, "Process does not own a pseudoconsole", L"", ERROR_INVALID_PARAMETER);
  settleConsoleClose(process);
  if (!process.console || process.consoleClosing) return null(env);
  require(activeProcesses(process) == 0, "Pseudoconsole clients have not settled", L"", ERROR_BUSY);
  // A private thread keeps terminal teardown independent from libuv workers
  // blocked on protocol input. No N-API object is touched by this thread.
  process.consoleClosing = true;
  try {
    process.consoleCloser = std::thread([&process, console = process.console] {
      consoleApi().close(console);
      process.consoleCloseFinished.store(true);
    });
  } catch (...) {
    process.consoleClosing = false;
    throw;
  }
  return null(env);
}
static COORD consoleSize(napi_env env, napi_value width, napi_value height) {
  const auto columns = numeric(env, width), rows = numeric(env, height);
  require(columns >= 1 && columns <= 32767 && columns == static_cast<SHORT>(columns) &&
          rows >= 1 && rows <= 32767 && rows == static_cast<SHORT>(rows),
          "Terminal dimensions must fit positive Win32 COORD values", L"", ERROR_INVALID_PARAMETER);
  return {static_cast<SHORT>(columns), static_cast<SHORT>(rows)};
}

napi_value processCall(napi_env env, const std::wstring& operation, const std::vector<napi_value>& args) {
  if (operation == L"process_debugger_spawn") {
    require(args.size() == 4, "Wrong native debugger launch argument count", L"", ERROR_INVALID_PARAMETER);
    std::vector<std::wstring> environment;
    for (const auto& entry : array(env, args[3])) environment.push_back(wide(env, entry));
    auto process = spawnProcess(wide(env, args[0]), wide(env, args[1]), wide(env, args[2]), environment,
        true, 0, nullptr, nullptr, true);
    auto result = object(env);
    set(env, result, "pid", number(env, process->pid));
    set(env, result, "jobAssigned", boolean(env, true));
    set(env, result, "killOnOwnerClose", boolean(env, false));
    set(env, result, "debuggerLeaderOnly", boolean(env, true));
    set(env, result, "handle", wrap(env, std::move(process)));
    return result;
  }
  if (operation == L"process_caller_token") {
    require(args.empty(), "Caller token observation takes no arguments", L"", ERROR_INVALID_PARAMETER);
    return callerToken(env);
  }
  if (operation == L"process_pty_spawn") {
    require(args.size() == 6, "Wrong native terminal launch argument count", L"", ERROR_INVALID_PARAMETER);
    auto size = consoleSize(env, args[4], args[5]);
    std::vector<std::wstring> environment;
    for (const auto& entry : array(env, args[3])) environment.push_back(wide(env, entry));
    auto process = spawnProcess(wide(env, args[0]), wide(env, args[1]), wide(env, args[2]), environment,
        true, 0, nullptr, &size);
    auto result = object(env);
    set(env, result, "pid", number(env, process->pid));
    set(env, result, "jobAssigned", boolean(env, true));
    set(env, result, "killOnOwnerClose", boolean(env, true));
    set(env, result, "conpty", boolean(env, true));
    set(env, result, "handle", wrap(env, std::move(process)));
    return result;
  }
  if (operation == L"process_pty_resize") {
    require(args.size() == 3, "Wrong terminal resize argument count", L"", ERROR_INVALID_PARAMETER);
    auto& process = static_cast<Process&>(resource(env, args[0], Kind::Process));
    require(process.console && !process.consoleClosing, "Pseudoconsole is closing or closed", L"", ERROR_INVALID_HANDLE);
    auto status = consoleApi().resize(process.console, consoleSize(env, args[1], args[2]));
    require(SUCCEEDED(status), "Resize pseudoconsole failed", L"", static_cast<DWORD>(status));
    return null(env);
  }
  if (operation == L"process_spawn") {
    require(args.size() >= 4 && args.size() <= 7, "Wrong native process launch argument count", L"", ERROR_INVALID_PARAMETER);
    bool protocolStdin = false;
    if (args.size() >= 5) check(napi_get_value_bool(env, args[4], &protocolStdin));
    const ULONGLONG memoryLimit = args.size() >= 6 ? jobMemoryLimit(env, args[5]) : 0;
    std::vector<std::wstring> environment;
    for (const auto& entry : array(env, args[3])) environment.push_back(wide(env, entry));
    std::shared_ptr<Sandbox> sandbox;
    if (args.size() == 7) {
      auto& runtime = static_cast<Runtime&>(resource(env, args[6], Kind::Runtime));
      admitSandboxLaunch(runtime, wide(env, args[0]), wide(env, args[2]));
      require(!protocolStdin, "AppContainer extraction does not accept a protocol input pipe", runtime.path, ERROR_INVALID_PARAMETER);
      sandbox = runtime.sandbox;
    }
    auto process = spawnProcess(wide(env, args[0]), wide(env, args[1]), wide(env, args[2]), environment, protocolStdin,
                                memoryLimit, sandbox);
    auto result = object(env);
    set(env, result, "pid", number(env, process->pid));
    set(env, result, "jobAssigned", boolean(env, true));
    set(env, result, "killOnOwnerClose", boolean(env, true));
    if (process->memoryLimit != 0)
      set(env, result, "jobMemoryLimitBytes", number(env, static_cast<double>(process->memoryLimit)));
    if (sandbox) set(env, result, "appContainer", boolean(env, true));
    set(env, result, "handle", wrap(env, std::move(process)));
    return result;
  }
  if (operation == L"process_stdin_write") {
    require(args.size() == 2, "Wrong native process input argument count", L"", ERROR_INVALID_PARAMETER);
    return inputWrite(env, args[0], static_cast<Process&>(resource(env, args[0], Kind::Process)), args[1]);
  }
  if (operation == L"process_sample") {
    require(args.size() == 2, "Wrong process sample argument count", L"", ERROR_INVALID_PARAMETER);
    return sampleProcesses(env, static_cast<Process&>(resource(env, args[0], Kind::Process)), args[1]);
  }
  require(args.size() == 1, "Wrong native process handle argument count", L"", ERROR_INVALID_PARAMETER);
  auto& process = static_cast<Process&>(resource(env, args[0], Kind::Process));
  if (operation == L"process_pty_close") return startConsoleClose(env, process);
  if (operation == L"process_stdin_close") {
    process.stdinWrite.reset();
    return null(env);
  }
  if (operation == L"process_poll") {
    settleConsoleClose(process);
    auto result = object(env);
    if (process.hasTerminal) set(env, result, "terminalClosed", boolean(env, !process.console));
    bool stdoutEnded = false, stderrEnded = false;
    set(env, result, "stdout", readOutput(env, process.stdoutRead, stdoutEnded));
    set(env, result, "stderr", readOutput(env, process.stderrRead, stderrEnded));
    set(env, result, "stdoutEnded", boolean(env, stdoutEnded));
    set(env, result, "stderrEnded", boolean(env, stderrEnded));
    observeNotifications(process);
    const auto exited = WaitForSingleObject(process.process.get(), 0);
    require(exited == WAIT_OBJECT_0 || exited == WAIT_TIMEOUT, "Observe owned process exit failed");
    DWORD code = 0;
    if (exited == WAIT_OBJECT_0) {
      // The child may have reached its limit and exited after the first drain.
      observeNotifications(process);
      require(GetExitCodeProcess(process.process.get(), &code), "Read owned process exit code failed");
    }
    set(env, result, "exitCode", exited == WAIT_OBJECT_0 ? number(env, code) : null(env));
    set(env, result, "activeProcesses", number(env, activeProcesses(process)));
    if (process.memoryLimit != 0) {
      set(env, result, "memoryLimitReached", boolean(env, process.memoryLimitReached));
      set(env, result, "peakJobMemoryBytes", number(env, static_cast<double>(peakJobMemory(process))));
    }
    return result;
  }
  if (operation == L"process_alive") return number(env, activeProcesses(process));
  if (operation == L"process_leader_alive") {
    const auto state = WaitForSingleObject(process.process.get(), 0);
    require(state == WAIT_OBJECT_0 || state == WAIT_TIMEOUT, "Read retained leader exit state failed");
    return number(env, state == WAIT_TIMEOUT ? 1 : 0);
  }
  if (operation == L"process_terminate_leader") {
    const auto state = WaitForSingleObject(process.process.get(), 0);
    require(state == WAIT_OBJECT_0 || state == WAIT_TIMEOUT, "Read retained leader exit state failed");
    if (state == WAIT_OBJECT_0) return boolean(env, false);
    if (!TerminateProcess(process.process.get(), 1)) {
      const auto failure = GetLastError();
      // Exit can begin between the liveness observation and TerminateProcess.
      // An already-terminating process reports ACCESS_DENIED; only settlement
      // of this same retained handle permits treating that race as success.
      if (failure == ERROR_ACCESS_DENIED && WaitForSingleObject(process.process.get(), 100) == WAIT_OBJECT_0)
        return boolean(env, false);
      throw Failure("Terminate retained process leader failed", L"", failure);
    }
    return boolean(env, true);
  }
  if (operation == L"process_terminate") {
    require(!process.debuggerLeaderOnly, "Debugger ownership does not authorize job termination", L"", ERROR_ACCESS_DENIED);
    const auto active = activeProcesses(process);
    if (active > 0) require(TerminateJobObject(process.job.get(), 1), "Terminate owned Job Object failed");
    return boolean(env, active > 0);
  }
  if (operation == L"process_close") {
    require(!process.debuggerLeaderOnly || WaitForSingleObject(process.process.get(), 0) == WAIT_OBJECT_0,
            "A live debugger owner cannot be released", L"", ERROR_BUSY);
    require(!process.console && !process.consoleClosing, "Pseudoconsole close must finish before releasing its owner", L"", ERROR_BUSY);
    // Closing the job is the crash-safe authority; no PID enumeration is used.
    if (process.sandbox && activeProcesses(process) != 0)
      require(TerminateJobObject(process.job.get(), 1), "Terminate closing AppContainer job failed");
    process.job.reset(); process.process.reset(); process.stdoutRead.reset(); process.stderrRead.reset(); process.stdinWrite.reset();
    process.notifications.reset();
    process.closed = true;
    return null(env);
  }
  throw Failure("Unknown native process operation", L"", ERROR_INVALID_PARAMETER);
}

napi_value inspect(napi_env env, std::unique_ptr<Runtime>& pending) {
  // Settle the previous owner before admitting another probe. Failed cleanup
  // retains its handles, including when identity construction itself failed.
  if (pending) { closeRuntime(*pending); pending.reset(); }
  wchar_t temp[32768];
  const auto length = GetTempPathW(32768, temp);
  require(length > 0 && length < 32768, "Read temporary directory coordinate failed");
  createRuntime(std::wstring(temp, length), L"rea-native-probe-", pending);
  napi_value filesystem;
  try {
    filesystem = identity(env, pending->directory.get(), pending->path);
  } catch (Failure& primary) {
    cleanupFailedRuntime(pending, primary);
    throw;
  } catch (const std::exception& error) {
    Failure primary(error.what(), pending ? pending->path : L"", ERROR_GEN_FAILURE);
    cleanupFailedRuntime(pending, primary);
    throw primary;
  }
  closeRuntime(*pending);
  pending.reset();
  auto job = createJob();
  Attributes attributes(1);
  HANDLE raw = job.get();
  attributes.add(PROC_THREAD_ATTRIBUTE_JOB_LIST, &raw, sizeof(raw));
  // Establish the commit-limit policy and its notification port on this host.
  auto limited = createJob(64ULL * 1024 * 1024);
  auto notifications = createNotifications(limited.get());
  auto result = object(env);
  set(env, result, "appContainer", boolean(env, true));
  set(env, result, "abiVersion", number(env, 1));
  set(env, result, "nodeApiVersion", number(env, 8));
  set(env, result, "architecture", string(env, std::string("x64")));
  set(env, result, "filesystem", filesystem);
  set(env, result, "privateDacl", boolean(env, true));
  set(env, result, "privateBridgeDescriptorAccess", boolean(env, true));
  set(env, result, "atomicJobAssignment", boolean(env, true));
  set(env, result, "killOnOwnerClose", boolean(env, true));
  set(env, result, "protocolStdin", boolean(env, true));
  set(env, result, "jobMemoryLimit", boolean(env, true));
  if (consoleApi().available()) set(env, result, "conpty", boolean(env, true));
  set(env, result, "debuggerLeaderOnly", boolean(env, true));
  return result;
}

} // namespace rea
