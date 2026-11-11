// Read-only 7-Zip decoding bridge. No path-based writes, shell, or target execution.
#define NOMINMAX
#include <windows.h>
#include <atomic>
#include <memory>
#include <new>
#include <string>
#include <utility>
#include "CPP/Common/MyInitGuid.h"
#include "CPP/Common/MyCom.h"
#include "CPP/7zip/Archive/IArchive.h"

namespace {
constexpr UInt32 MaxItems = 10000;
constexpr UInt64 MaxOutput = 512ull * 1024 * 1024;

struct OwnedHandle {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~OwnedHandle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  HRESULT copy(HANDLE source, DWORD access) {
    return DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(),
                           &value, access, FALSE, 0) ? S_OK : HRESULT_FROM_WIN32(GetLastError());
  }
};

#define REFS(CLASS) \
  std::atomic<ULONG> refs{1}; \
  ULONG STDMETHODCALLTYPE AddRef() noexcept override { return ++refs; } \
  ULONG STDMETHODCALLTYPE Release() noexcept override { \
    const ULONG remaining = --refs; if (!remaining) delete static_cast<CLASS*>(this); return remaining; \
  }

class Input final : public IInStream {
public:
  OwnedHandle handle;
  REFS(Input)
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void **out) noexcept override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (id == IID_IUnknown || id == IID_ISequentialInStream || id == IID_IInStream) {
      *out = static_cast<IInStream*>(this); AddRef(); return S_OK;
    }
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE Read(void *data, UInt32 size, UInt32 *processed) noexcept override {
    DWORD read = 0;
    const BOOL ok = ReadFile(handle.value, data, size, &read, nullptr);
    if (processed) *processed = read;
    return ok ? S_OK : HRESULT_FROM_WIN32(GetLastError());
  }
  HRESULT STDMETHODCALLTYPE Seek(Int64 offset, UInt32 origin, UInt64 *position) noexcept override {
    if (origin > FILE_END) return STG_E_INVALIDFUNCTION;
    LARGE_INTEGER distance{}, result{}; distance.QuadPart = offset;
    if (!SetFilePointerEx(handle.value, distance, &result, origin)) return HRESULT_FROM_WIN32(GetLastError());
    if (position) *position = static_cast<UInt64>(result.QuadPart);
    return S_OK;
  }
};

struct WriteState {
  OwnedHandle handle;
  UInt64 limit = 0, written = 0;
  Int32 result = -1;
  bool supplied = false, overflow = false;
};

class Output final : public ISequentialOutStream {
public:
  std::shared_ptr<WriteState> state;
  explicit Output(std::shared_ptr<WriteState> value) : state(std::move(value)) {}
  REFS(Output)
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void **out) noexcept override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (id == IID_IUnknown || id == IID_ISequentialOutStream) {
      *out = static_cast<ISequentialOutStream*>(this); AddRef(); return S_OK;
    }
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE Write(const void *data, UInt32 size, UInt32 *processed) noexcept override {
    if (processed) *processed = 0;
    if (size > state->limit - state->written) { state->overflow = true; return STG_E_MEDIUMFULL; }
    DWORD wrote = 0;
    const BOOL ok = WriteFile(state->handle.value, data, size, &wrote, nullptr);
    state->written += wrote;
    if (processed) *processed = wrote;
    return ok ? S_OK : HRESULT_FROM_WIN32(GetLastError());
  }
};

class Extract final : public IArchiveExtractCallback {
public:
  std::shared_ptr<WriteState> state;
  UInt32 index;
  Extract(std::shared_ptr<WriteState> value, UInt32 item) : state(std::move(value)), index(item) {}
  REFS(Extract)
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void **out) noexcept override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (id == IID_IUnknown || id == IID_IProgress || id == IID_IArchiveExtractCallback) {
      *out = static_cast<IArchiveExtractCallback*>(this); AddRef(); return S_OK;
    }
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE SetTotal(UInt64) noexcept override { return S_OK; }
  HRESULT STDMETHODCALLTYPE SetCompleted(const UInt64 *) noexcept override { return S_OK; }
  HRESULT STDMETHODCALLTYPE GetStream(UInt32 item, ISequentialOutStream **out, Int32 mode) noexcept override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (mode != NArchive::NExtract::NAskMode::kExtract) return S_OK;
    if (item != index || state->supplied) return E_UNEXPECTED;
    auto stream = new (std::nothrow) Output(state);
    if (!stream) return E_OUTOFMEMORY;
    state->supplied = true;
    *out = stream;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE PrepareOperation(Int32) noexcept override { return S_OK; }
  HRESULT STDMETHODCALLTYPE SetOperationResult(Int32 result) noexcept override { state->result = result; return S_OK; }
};

struct Variant {
  PROPVARIANT value{};
  ~Variant() { PropVariantClear(&value); }
};
struct Session {
  CMyComPtr<IInArchive> archive;
  UInt32 count = 0;
  ~Session() { if (archive) archive->Close(); }
};

bool admittedFormat(const wchar_t *name) {
  if (!name) return false;
  for (auto fixed : {L"Arj", L"CramFS", L"Dmg", L"Ext", L"FAT", L"NTFS", L"Compound", L"SquashFS"})
    if (wcscmp(name, fixed) == 0) return true;
  return false;
}

HRESULT property(Session *s, UInt32 index, PROPID id, Variant &v) {
  return s->archive->GetProperty(index, id, &v.value);
}
HRESULT flag(Session *s, UInt32 index, PROPID id, UInt32 bit, UInt32 &flags) {
  Variant v;
  HRESULT hr = property(s, index, id, v); if (hr != S_OK) return hr;
  if (v.value.vt == VT_EMPTY) return S_OK;
  if (v.value.vt != VT_BOOL) return E_UNEXPECTED;
  if (v.value.boolVal != VARIANT_FALSE) flags |= bit;
  return S_OK;
}
HRESULT linkFlag(Session *s, UInt32 index, PROPID id, UInt32 &flags) {
  Variant v;
  HRESULT hr = property(s, index, id, v); if (hr != S_OK) return hr;
  if (v.value.vt == VT_EMPTY) return S_OK;
  if (v.value.vt != VT_BSTR) return E_UNEXPECTED;
  if (SysStringLen(v.value.bstrVal)) flags |= 2;
  return S_OK;
}
}

#define EXPORT extern "C" __declspec(dllexport)
EXPORT UInt32 __cdecl rea7_abi() noexcept { return 1; }

EXPORT HRESULT __cdecl rea7_open(HMODULE module, HANDLE input, const wchar_t *format, Session **out) noexcept {
  if (!out) return E_POINTER;
  *out = nullptr;
  if (!module || !admittedFormat(format)) return E_INVALIDARG;
  try {
    using Count = HRESULT (WINAPI *)(UInt32 *);
    using Prop = HRESULT (WINAPI *)(UInt32, PROPID, PROPVARIANT *);
    using Create = HRESULT (WINAPI *)(const GUID *, const GUID *, void **);
    auto count = reinterpret_cast<Count>(GetProcAddress(module, "GetNumberOfFormats"));
    auto prop = reinterpret_cast<Prop>(GetProcAddress(module, "GetHandlerProperty2"));
    auto create = reinterpret_cast<Create>(GetProcAddress(module, "CreateObject"));
    if (!count || !prop || !create) return E_NOINTERFACE;
    UInt32 formats = 0; HRESULT hr = count(&formats);
    if (hr != S_OK) return hr;
    if (formats > 256) return E_UNEXPECTED;
    GUID clsid{}; bool found = false;
    for (UInt32 i = 0; i < formats; ++i) {
      Variant name;
      hr = prop(i, NArchive::NHandlerPropID::kName, &name.value); if (hr != S_OK) return hr;
      if (name.value.vt != VT_BSTR) return E_UNEXPECTED;
      if (SysStringLen(name.value.bstrVal) != wcslen(format) || wcscmp(name.value.bstrVal, format) != 0) continue;
      Variant id;
      hr = prop(i, NArchive::NHandlerPropID::kClassID, &id.value); if (hr != S_OK) return hr;
      if (id.value.vt != VT_BSTR || SysStringByteLen(id.value.bstrVal) != sizeof(GUID)) return E_UNEXPECTED;
      memcpy(&clsid, id.value.bstrVal, sizeof(clsid)); found = true; break;
    }
    if (!found) return HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED);
    auto session = std::make_unique<Session>();
    hr = create(&clsid, &IID_IInArchive, reinterpret_cast<void**>(&session->archive));
    if (hr != S_OK) return hr;
    CMyComPtr<IInStream> stream;
    auto object = new Input(); stream.Attach(object);
    hr = object->handle.copy(input, GENERIC_READ); if (hr != S_OK) return hr;
    UInt64 scan = 0;
    hr = session->archive->Open(stream, &scan, nullptr); if (hr != S_OK) return hr;
    hr = session->archive->GetNumberOfItems(&session->count); if (hr != S_OK) return hr;
    if (session->count > MaxItems) return HRESULT_FROM_WIN32(ERROR_FILE_TOO_LARGE);
    *out = session.release(); return S_OK;
  } catch (const std::bad_alloc &) { return E_OUTOFMEMORY; }
    catch (...) { return E_FAIL; }
}

EXPORT HRESULT __cdecl rea7_count(Session *s, UInt32 *count, UInt32 *errors, UInt32 *warnings) noexcept {
  if (!s || !count || !errors || !warnings) return E_POINTER;
  *count = s->count; *errors = 0; *warnings = 0;
  for (auto pair : {std::pair<PROPID, UInt32*>{kpidErrorFlags, errors}, {kpidWarningFlags, warnings}}) {
    Variant v; HRESULT hr = s->archive->GetArchiveProperty(pair.first, &v.value); if (hr != S_OK) return hr;
    if (v.value.vt == VT_UI4) *pair.second = v.value.ulVal;
    else if (v.value.vt != VT_EMPTY) return E_UNEXPECTED;
  }
  return S_OK;
}

EXPORT HRESULT __cdecl rea7_item(Session *s, UInt32 index, wchar_t *path, UInt32 capacity,
    UInt32 *length, UInt32 *flags, UInt64 *size, UInt32 *known) noexcept {
  if (!s || !path || !length || !flags || !size || !known) return E_POINTER;
  if (index >= s->count) return E_INVALIDARG;
  *length = 0; *flags = 0; *size = 0; *known = 0;
  Variant name; HRESULT hr = property(s, index, kpidPath, name); if (hr != S_OK) return hr;
  if (name.value.vt != VT_BSTR) return E_UNEXPECTED;
  *length = SysStringLen(name.value.bstrVal);
  if (*length >= capacity) return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
  memcpy(path, name.value.bstrVal, *length * sizeof(wchar_t)); path[*length] = 0;
  for (auto pair : {std::pair<PROPID, UInt32>{kpidIsDir, 1}, {kpidEncrypted, 8}, {kpidIsDeleted, 16}, {kpidIsAltStream, 32}}) {
    hr = flag(s, index, pair.first, pair.second, *flags); if (hr != S_OK) return hr;
  }
  for (auto id : {kpidSymLink, kpidHardLink}) { hr = linkFlag(s, index, id, *flags); if (hr != S_OK) return hr; }
  Variant mode; hr = property(s, index, kpidPosixAttrib, mode); if (hr != S_OK) return hr;
  if (mode.value.vt == VT_UI4) {
    const UInt32 kind = mode.value.ulVal & 0170000;
    if (kind && kind != 0100000 && kind != 0040000) *flags |= 4;
  } else if (mode.value.vt != VT_EMPTY) return E_UNEXPECTED;
  Variant attrs; hr = property(s, index, kpidAttrib, attrs); if (hr != S_OK) return hr;
  if (attrs.value.vt == VT_UI4) { if (attrs.value.ulVal & FILE_ATTRIBUTE_REPARSE_POINT) *flags |= 64; }
  else if (attrs.value.vt != VT_EMPTY) return E_UNEXPECTED;
  Variant bytes; hr = property(s, index, kpidSize, bytes); if (hr != S_OK) return hr;
  if (bytes.value.vt == VT_UI8) { *size = bytes.value.uhVal.QuadPart; *known = 1; }
  else if (bytes.value.vt == VT_UI4) { *size = bytes.value.ulVal; *known = 1; }
  else if (bytes.value.vt != VT_EMPTY) return E_UNEXPECTED;
  return S_OK;
}

EXPORT HRESULT __cdecl rea7_extract(Session *s, UInt32 index, HANDLE output, UInt64 limit,
    UInt64 *written, Int32 *result, UInt32 *overflow) noexcept {
  if (!s || !written || !result || !overflow) return E_POINTER;
  *written = 0; *result = -1; *overflow = 0;
  if (index >= s->count || limit > MaxOutput) return E_INVALIDARG;
  try {
    auto state = std::make_shared<WriteState>(); state->limit = limit;
    HRESULT hr = state->handle.copy(output, GENERIC_WRITE); if (hr != S_OK) return hr;
    CMyComPtr<IArchiveExtractCallback> callback; callback.Attach(new Extract(state, index));
    hr = s->archive->Extract(&index, 1, 0, callback);
    *written = state->written; *result = state->result; *overflow = state->overflow ? 1 : 0;
    return hr;
  } catch (const std::bad_alloc &) { return E_OUTOFMEMORY; }
    catch (...) { return E_FAIL; }
}

EXPORT HRESULT __cdecl rea7_close(Session *s) noexcept {
  if (!s) return E_POINTER;
  const HRESULT hr = s->archive->Close();
  s->archive.Release(); delete s; return hr;
}
