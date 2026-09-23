// winfsp_mount.cpp
//
// Read-only WinFsp file system backed by JS callbacks.
//
// The WinFsp driver/DLL (winfsp-x64.dll) is loaded at runtime; no import
// library is needed. Every file system operation is forwarded to a JS
// handler function on the Node main thread through a N-API ThreadSafeFunction,
// and the reply is used to complete the operation synchronously.
//
// WinFsp headers are GPLv3/commercial (c) Bill Zissimopoulos. OPBS is GPL-3.0,
// so vendoring these headers and creating derivative code is compatible.

#include <napi.h>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>
#include <cstdint>
#include <cstdarg>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <condition_variable>
#include <cwchar>
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <dbt.h>
#include <sddl.h>
#include <strsafe.h>
#include <dbghelp.h>
#include <winfsp/winfsp.h>

namespace opbs_winfsp
{

// ---------------------------------------------------------------------------
// Runtime resolution of the WinFsp DLL exports.
// ---------------------------------------------------------------------------

struct WinFspApi
{
    HMODULE Module = nullptr;

#define OPBS_WINFSP_IMPORT(Fn) decltype(Fn) * Fn = nullptr;

    OPBS_WINFSP_IMPORT(FspFileSystemCreate)
    OPBS_WINFSP_IMPORT(FspFileSystemDelete)
    OPBS_WINFSP_IMPORT(FspFileSystemSetMountPoint)
    OPBS_WINFSP_IMPORT(FspFileSystemRemoveMountPoint)
    OPBS_WINFSP_IMPORT(FspFileSystemStartDispatcher)
    OPBS_WINFSP_IMPORT(FspFileSystemStopDispatcher)
    OPBS_WINFSP_IMPORT(FspFileSystemAddDirInfo)
    OPBS_WINFSP_IMPORT(FspNtStatusFromWin32)
    OPBS_WINFSP_IMPORT(FspWin32FromNtStatus)
    OPBS_WINFSP_IMPORT(FspVersion)

#undef OPBS_WINFSP_IMPORT

    bool Resolve(HMODULE H)
    {
        Module = H;
#define OPBS_WINFSP_RESOLVE(Fn)                                                \
    Fn = reinterpret_cast<decltype(Fn)>(GetProcAddress(H, #Fn));               \
    if (!Fn)                                                                   \
        return false;

        OPBS_WINFSP_RESOLVE(FspFileSystemCreate)
        OPBS_WINFSP_RESOLVE(FspFileSystemDelete)
        OPBS_WINFSP_RESOLVE(FspFileSystemSetMountPoint)
        OPBS_WINFSP_RESOLVE(FspFileSystemRemoveMountPoint)
        OPBS_WINFSP_RESOLVE(FspFileSystemStartDispatcher)
        OPBS_WINFSP_RESOLVE(FspFileSystemStopDispatcher)
        OPBS_WINFSP_RESOLVE(FspFileSystemAddDirInfo)
        OPBS_WINFSP_RESOLVE(FspNtStatusFromWin32)
        OPBS_WINFSP_RESOLVE(FspWin32FromNtStatus)
        OPBS_WINFSP_RESOLVE(FspVersion)

#undef OPBS_WINFSP_RESOLVE
        return true;
    }
};

static WinFspApi g_api;

// Last load outcome, useful for user-facing diagnosis ("WinFsp not detected").
static std::wstring g_loadNote = L"not attempted";

static HMODULE LoadWinFspDll()
{
    // The WinFsp MSI records InstallDir in the 32-bit registry view
    // (WOW6432Node). Query it explicitly; also try the 64-bit view and a
    // best-effort default install location. Prefer these explicit paths over
    // a raw LoadLibraryW by name (which depends on PATH/cwd and is flaky
    // from code that runs before the app has set up its environment).
    for (const wchar_t *Key : {
             L"Software\\WOW6432Node\\WinFsp",
             L"Software\\WinFsp" })
    {
        WCHAR Dir[MAX_PATH];
        DWORD Size = sizeof Dir;
        LONG R = RegGetValueW(
            HKEY_LOCAL_MACHINE, Key, L"InstallDir",
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6432KEY,
            nullptr, Dir, &Size);
        if (ERROR_SUCCESS != R)
            R = RegGetValueW(
                HKEY_LOCAL_MACHINE, Key, L"InstallDir",
                RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
                nullptr, Dir, &Size);
        if (ERROR_SUCCESS != R)
        {
            g_loadNote = L"registry InstallDir lookup err " +
                         std::to_wstring(R) + L" @ " + Key;
            continue;
        }
        {
            // InstallDir usually ends with '\'; normalise to no trailing
            // separator so the append below is unambiguous.
            WCHAR *End = Dir + wcslen(Dir);
            while (End > Dir && (End[-1] == L'\\' || End[-1] == L'/'))
                *--End = L'\0';
            WCHAR Path[MAX_PATH];
            if (FAILED(StringCbCopyW(Path, sizeof Path, Dir)) ||
                FAILED(StringCbCatW(Path, sizeof Path, L"\\bin\\winfsp-x64.dll")))
                continue;
            HMODULE M = LoadLibraryW(Path);
            if (M) { g_loadNote = std::wstring(L"loaded via registry: ") + Path; return M; }
            if (GetFileAttributesW(Path) == INVALID_FILE_ATTRIBUTES)
                g_loadNote = std::wstring(L"registry path missing: ") + Path;
            else
                g_loadNote = std::wstring(L"registry path load err ") +
                    std::to_wstring(GetLastError()) + L" @ " + Path;
        }
    }

    WCHAR Fallback[] = L"C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x64.dll";
    if (GetFileAttributesW(Fallback) != INVALID_FILE_ATTRIBUTES)
    {
        HMODULE M = LoadLibraryW(Fallback);
        if (M) { g_loadNote = L"loaded via fallback path"; return M; }
        g_loadNote = L"fallback load err " + std::to_wstring(GetLastError());
    }
    else
    {
        g_loadNote = L"fallback path not found";
    }

    HMODULE M = LoadLibraryW(L"winfsp-x64.dll");
    if (M) { g_loadNote = L"loaded by name winfsp-x64.dll"; return M; }
    g_loadNote = L"plain LoadLibraryW err " + std::to_wstring(GetLastError());
    return nullptr;
}

// Ensure the WinFsp DLL is loaded and resolved; safely idempotent, and a
// no-op once g_api.Module is valid.
static void EnsureWinFsp()
{
    if (g_api.Module != nullptr)
        return;
    HMODULE M = LoadWinFspDll();
    if (M && !g_api.Resolve(M))
    {
        g_loadNote = L"dll loaded but required exports missing";
        FreeLibrary(M);
        M = nullptr;
    }
    g_api.Module = M;
}

// ---------------------------------------------------------------------------
// Request/reply bridge.
// ---------------------------------------------------------------------------

struct DirEntryReply
{
    std::wstring Name;
    uint32_t Attributes = 0;
    uint64_t Size = 0;
    uint64_t CreationTime = 0;
    uint64_t LastAccessTime = 0;
    uint64_t LastWriteTime = 0;
    uint64_t ChangeTime = 0;
    uint64_t IndexNumber = 0;
};

struct Bridge
{
    std::string Op;         // "stat" | "read" | "readDir"
    std::wstring Path;
    std::wstring Marker;  // readDir continuation marker (empty = start)
    uint64_t Offset = 0;
    uint32_t Length = 0;

    bool Done = false;
    int64_t Status = 0;     // NTSTATUS

    // stat replies
    uint32_t Attributes = 0;
    uint64_t Size = 0;
    uint64_t AllocationSize = 0;
    uint64_t CreationTime = 0;
    uint64_t LastAccessTime = 0;
    uint64_t LastWriteTime = 0;
    uint64_t ChangeTime = 0;
    uint64_t IndexNumber = 0;

    // read replies
    std::vector<uint8_t> Data;

    // readDir replies
    std::vector<DirEntryReply> Entries;
};

static uint32_t g_base64Value(uint8_t C)
{
    if (C >= 'A' && C <= 'Z') return C - 'A';
    if (C >= 'a' && C <= 'z') return C - 'a' + 26;
    if (C >= '0' && C <= '9') return C - '0' + 52;
    if (C == '+' ) return 62;
    if (C == '/') return 63;
    return 0xFF;
}

static std::vector<uint8_t> Base64Decode(const std::string &S)
{
    std::vector<uint8_t> Out;
    Out.reserve(S.size() * 3 / 4);
    uint32_t Acc = 0;
    int Bits = -8;
    for (char C : S)
    {
        if (C == '=' || C == '\n' || C == '\r')
            continue;
        uint32_t V = g_base64Value(static_cast<uint8_t>(C));
        if (V == 0xFF)
            continue;
        Acc = (Acc << 6) | V;
        Bits += 6;
        if (Bits >= 0)
        {
            Out.push_back(static_cast<uint8_t>((Acc >> Bits) & 0xFF));
            Bits -= 8;
        }
    }
    return Out;
}

static std::wstring Utf8ToWide(const std::string &In)
{
    if (In.empty())
        return std::wstring();
    int N = MultiByteToWideChar(CP_UTF8, 0, In.data(), (int)In.size(), nullptr, 0);
    std::wstring Out(N, 0);
    MultiByteToWideChar(CP_UTF8, 0, In.data(), (int)In.size(), (LPWSTR)Out.data(), N);
    return Out;
}

static std::string WideToUtf8(const std::wstring &In)
{
    if (In.empty())
        return std::string();
    int N = WideCharToMultiByte(CP_UTF8, 0, (LPCWCH)In.data(), (int)In.size(), nullptr, 0, nullptr, nullptr);
    std::string Out(N, 0);
    WideCharToMultiByte(CP_UTF8, 0, (LPCWCH)In.data(), (int)In.size(), Out.data(), N, nullptr, nullptr);
    return Out;
}

static std::wstring Utf16ToString(const std::u16string &In)
{
    const wchar_t *P = reinterpret_cast<const wchar_t *>(In.data());
    return std::wstring(P, P + In.size());
}

// Mount Manager form (`\\.\X:`) creates a GLOBAL drive. Plain `X:` uses
// DefineDosDevice, which is scoped to the caller's LUID — the elevated
// helper's drive is invisible to non-elevated Explorer (WinFsp #194/#526).
static std::wstring NormalizeDriveMountPoint(std::wstring Letter)
{
    // Accept "Z", "Z:", "\\.\Z:", "Z:\\" → "\\.\Z:"
    while (!Letter.empty() && (Letter.back() == L'\\' || Letter.back() == L'/'))
        Letter.pop_back();
    if (Letter.rfind(L"\\\\.\\", 0) == 0)
        Letter = Letter.substr(4);
    while (!Letter.empty() && (Letter.back() == L'\\' || Letter.back() == L'/'))
        Letter.pop_back();
    if (Letter.size() == 1)
        Letter += L':';
    if (Letter.size() != 2 || Letter[1] != L':' ||
        !((Letter[0] >= L'A' && Letter[0] <= L'Z') ||
          (Letter[0] >= L'a' && Letter[0] <= L'z')))
        return std::wstring();
    if (Letter[0] >= L'a' && Letter[0] <= L'z')
        Letter[0] = static_cast<wchar_t>(Letter[0] - L'a' + L'A');
    return L"\\\\.\\" + Letter;
}

// First free drive letter counting down from Z: (same order WinFsp uses).
// Always returns the Mount Manager form so the drive is globally visible.
static std::wstring PickGlobalDriveMountPoint()
{
    DWORD Drives = GetLogicalDrives();
    for (wchar_t Drive = L'Z'; Drive >= L'D'; --Drive)
    {
        if (0 == (Drives & (1u << (Drive - L'A'))))
            return std::wstring(L"\\\\.\\") + Drive + L":";
    }
    return std::wstring(L"\\\\.\\Z:");
}

// Display form for the UI/logs: "\\.\Z:" → "Z:".
static std::wstring DisplayMountPoint(const std::wstring &Raw)
{
    if (Raw.rfind(L"\\\\.\\", 0) == 0 && Raw.size() >= 6)
        return Raw.substr(4);
    return Raw;
}

// Tell Explorer a drive letter appeared/disappeared. Mount Manager creates the
// letter globally, but Explorer only repaints "This PC" on SHChangeNotify /
// WM_DEVICECHANGE — without this the letter is invisible until F5.
static void NotifyShellDriveChange(const std::wstring &RawMountPoint, bool Arrived)
{
    std::wstring Display = DisplayMountPoint(RawMountPoint);
    if (Display.size() < 2 || Display[1] != L':')
        return;
    wchar_t Letter = Display[0];
    if (Letter >= L'a' && Letter <= L'z')
        Letter = static_cast<wchar_t>(Letter - L'a' + L'A');
    if (Letter < L'A' || Letter > L'Z')
        return;

    wchar_t Path[4] = {Letter, L':', L'\\', L'\0'};
    SHChangeNotify(Arrived ? SHCNE_DRIVEADD : SHCNE_DRIVEREMOVED,
                   SHCNF_PATHW, Path, nullptr);

    DEV_BROADCAST_VOLUME Volume;
    memset(&Volume, 0, sizeof Volume);
    Volume.dbcv_size = sizeof Volume;
    Volume.dbcv_devicetype = DBT_DEVTYP_VOLUME;
    Volume.dbcv_unitmask = 1u << (Letter - L'A');
    DWORD_PTR Result = 0;
    SendMessageTimeoutW(HWND_BROADCAST, WM_DEVICECHANGE,
                        Arrived ? DBT_DEVICEARRIVAL : DBT_DEVICEREMOVECOMPLETE,
                        reinterpret_cast<LPARAM>(&Volume),
                        SMTO_ABORTIFHUNG, 2000, &Result);
}

// Read a UINT64 into a bridge field from a JS reply, allowing either a Number
// (safe via double, < 2^53) or a decimal string (exact).
static uint64_t ReadU64(const Napi::Object &Obj, const char *Key, uint64_t Fallback = 0)
{
    Napi::Value V = Obj.Get(Key);
    if (V.IsUndefined() || V.IsNull())
        return Fallback;
    if (V.IsNumber())
        return static_cast<uint64_t>(V.As<Napi::Number>().Int64Value());
    if (V.IsBigInt())
    {
        bool Lossless = false;
        return V.As<Napi::BigInt>().Uint64Value(&Lossless);
    }
    if (V.IsString())
    {
        std::u16string S16 = V.As<Napi::String>().Utf16Value();
        return _wcstoui64(reinterpret_cast<const wchar_t *>(S16.c_str()),
                          nullptr, 10);
    }
    return Fallback;
}

// The TSF callback. Runs on the Node main thread.
static void BridgeCallback(Napi::Env Env, Napi::Function JsHandler, void *RawContext)
{
    Bridge *B = static_cast<Bridge *>(RawContext);
    Napi::Object Req = Napi::Object::New(Env);
    Req.Set("op", Napi::String::New(Env, B->Op));
    Req.Set("path", Napi::String::New(Env, WideToUtf8(B->Path)));
    if (B->Op == "read")
    {
        Req.Set("offset", Napi::Number::New(Env, static_cast<double>(B->Offset)));
        Req.Set("length", Napi::Number::New(Env, static_cast<double>(B->Length)));
    }
    if (B->Op == "readDir" && !B->Marker.empty())
        Req.Set("marker", Napi::String::New(Env, WideToUtf8(B->Marker)));

    Napi::Value Reply;
    try
    {
        Reply = JsHandler.Call({Req});
    }
    catch (const Napi::Error &)
    {
        B->Status = STATUS_UNSUCCESSFUL;
        B->Done = true;
        return;
    }
    catch (...)
    {
        B->Status = STATUS_UNSUCCESSFUL;
        B->Done = true;
        return;
    }

    if (!Reply.IsObject())
    {
        B->Status = STATUS_UNSUCCESSFUL;
        B->Done = true;
        return;
    }

    Napi::Object R = Reply.As<Napi::Object>();
    B->Status = static_cast<int64_t>(ReadU64(R, "status", 0));

    if (B->Op == "stat")
    {
        B->Attributes = static_cast<uint32_t>(ReadU64(R, "attributes"));
        B->Size = ReadU64(R, "size");
        B->AllocationSize = ReadU64(R, "allocationSize", B->Size);
        B->CreationTime = ReadU64(R, "creationTime");
        B->LastAccessTime = ReadU64(R, "lastAccessTime");
        B->LastWriteTime = ReadU64(R, "lastWriteTime");
        B->ChangeTime = ReadU64(R, "changeTime");
        B->IndexNumber = ReadU64(R, "indexNumber");
    }
    else if (B->Op == "read")
    {
        if (R.Has("data") && R.Get("data").IsString())
            B->Data = Base64Decode(R.Get("data").As<Napi::String>().Utf8Value());
    }
    else if (B->Op == "readDir")
    {
        Napi::Value Entries = R.Get("entries");
        if (Entries.IsArray())
        {
            Napi::Array A = Entries.As<Napi::Array>();
            for (uint32_t I = 0; I < A.Length(); I++)
            {
                Napi::Value Item = A.Get(I);
                if (!Item.IsObject())
                    continue;
                Napi::Object O = Item.As<Napi::Object>();
                DirEntryReply E;
                E.Name = Utf16ToString(O.Get("name").As<Napi::String>().Utf16Value());
                E.Attributes = static_cast<uint32_t>(ReadU64(O, "attributes"));
                E.Size = ReadU64(O, "size");
                E.CreationTime = ReadU64(O, "creationTime");
                E.LastAccessTime = ReadU64(O, "lastAccessTime");
                E.LastWriteTime = ReadU64(O, "lastWriteTime");
                E.ChangeTime = ReadU64(O, "changeTime");
                E.IndexNumber = ReadU64(O, "indexNumber");
                B->Entries.push_back(E);
            }
        }
    }

    B->Done = true;
}

// ---------------------------------------------------------------------------
// Per-mount state.
// ---------------------------------------------------------------------------

struct MountState
{
    uint32_t Id = 0;
    FSP_FILE_SYSTEM *Fs = nullptr;
    std::wstring Label;
    uint64_t TotalSize = 0;
    Napi::ThreadSafeFunction Tsf;
    PSECURITY_DESCRIPTOR SecurityDescriptor = nullptr;
    SIZE_T SecurityDescriptorSize = 0;
    bool SecurityReady = false;
};

static std::mutex g_mountsMutex;
static std::map<FSP_FILE_SYSTEM *, MountState *> g_mounts;
static std::map<uint32_t, MountState *> g_mountsById;
static uint32_t g_nextId = 1;

// ---------------------------------------------------------------------------
// Crash logger: writes the faulting address plus a symbolized stack to a file.
// Mostly a diagnostic aid; kept minimal and side-effect safe.
// ---------------------------------------------------------------------------

static HANDLE g_crashFile = INVALID_HANDLE_VALUE;

static void CrashFileOpen()
{
    WCHAR Dir[MAX_PATH];
    if (!GetTempPathW(MAX_PATH, Dir) || !Dir[0])
        return;
    WCHAR Full[MAX_PATH];
    if (FAILED(StringCbCopyW(Full, sizeof Full, Dir)) ||
        FAILED(StringCbCatW(Full, sizeof Full, L"opbs-crash.log")))
        return;
    g_crashFile = CreateFileW(Full, GENERIC_WRITE, FILE_SHARE_READ,
                              nullptr, CREATE_ALWAYS, 0, nullptr);
}

static void CrashLog(const char *Fmt, ...)
{
    if (g_crashFile == INVALID_HANDLE_VALUE)
        return;
    char Buf[1024];
    va_list Ap;
    va_start(Ap, Fmt);
    int N = vsprintf_s(Buf, Fmt, Ap);
    va_end(Ap);
    if (N < 0)
        return;
    DWORD W = 0;
    WriteFile(g_crashFile, Buf, (DWORD)N, &W, nullptr);
}

static LONG WINAPI OpbsExceptionFilter(PEXCEPTION_POINTERS P)
{
    if (g_crashFile == INVALID_HANDLE_VALUE)
        CrashFileOpen();
    CrashLog("code=0x%08lX addr=0x%p threadId=%lu\r\n",
             P ? P->ExceptionRecord->ExceptionCode : 0,
             P ? P->ExceptionRecord->ExceptionAddress : nullptr,
             GetCurrentThreadId());
    if (P && P->ContextRecord)
    {
        CrashLog("regs rip=0x%IX rsp=0x%IX rax=0x%IX rcx=0x%IX rdx=0x%IX rbx=0x%IX rbp=0x%IX rsi=0x%IX rdi=0x%IX\r\n",
                 P->ContextRecord->Rip, P->ContextRecord->Rsp,
                 P->ContextRecord->Rax, P->ContextRecord->Rcx,
                 P->ContextRecord->Rdx, P->ContextRecord->Rbx,
                 P->ContextRecord->Rbp, P->ContextRecord->Rsi,
                 P->ContextRecord->Rdi);
    }
    SymInitializeW(GetCurrentProcess(), nullptr, TRUE);
    PVOID Frames[48];
    USHORT Cnt = CaptureStackBackTrace(0, 48, Frames, nullptr);
    for (USHORT I = 0; I < Cnt; I++)
    {
        DWORD64 Addr = reinterpret_cast<DWORD64>(Frames[I]);
        alignas(SYMBOL_INFO) char SymBuf[sizeof(SYMBOL_INFO) + 512];
        auto *S = new (SymBuf) SYMBOL_INFO();
        S->MaxNameLen = 512;
        S->SizeOfStruct = sizeof(SYMBOL_INFO);
        DWORD64 Disp = 0;
        if (SymFromAddr(GetCurrentProcess(), Addr, &Disp, S))
        {
            DWORD Line = 0;
            DWORD LineDisp = 0;
            IMAGEHLP_LINE64 Hl = {};
            Hl.SizeOfStruct = sizeof Hl;
            BOOL HaveLine = SymGetLineFromAddr64(GetCurrentProcess(), Addr, &LineDisp, &Hl);
            CrashLog("fn[%u]=0x%IX %hs+0x%IX [%hs:%d]\r\n", I, Addr, S->Name, Disp,
                     HaveLine && Hl.FileName ? Hl.FileName : "?",
                     HaveLine ? (int)Hl.LineNumber : 0);
        }
        else
        {
            CrashLog("fn[%u]=0x%IX (no symbol)\r\n", I, Addr);
        }
    }
    FlushFileBuffers(g_crashFile);
    CloseHandle(g_crashFile);
    g_crashFile = INVALID_HANDLE_VALUE;
    return EXCEPTION_CONTINUE_SEARCH;
}

static MountState *Lookup(FSP_FILE_SYSTEM *Fs)
{
    std::lock_guard<std::mutex> Lock(g_mountsMutex);
    auto It = g_mounts.find(Fs);
    return It == g_mounts.end() ? nullptr : It->second;
}

// File context: the opened path, so read/getFileInfo can re-resolve.
struct FileContext
{
    std::wstring Path;
};

// Build a self-relative security descriptor. WinFsp's kernel access check
// needs specific (not generic) FILE_* rights in the DACL plus explicit owner
// and group; follow the memfs sample's layout.
static PSECURITY_DESCRIPTOR BuildDefaultSecurity(SIZE_T *POutSize)
{
    PSECURITY_DESCRIPTOR SD = nullptr;
    ULONG Size = 0;
    if (ConvertStringSecurityDescriptorToSecurityDescriptorA(
            "O:BAG:BAD:P(A;;FA;;;WD)", SDDL_REVISION_1, &SD, &Size))
    {
        *POutSize = Size;
        return SD;
    }
    return nullptr;
}

static bool EnsureSecurity(MountState *St)
{
    if (St->SecurityReady)
        return St->SecurityDescriptor != nullptr;
    St->SecurityDescriptor = BuildDefaultSecurity(&St->SecurityDescriptorSize);
    St->SecurityReady = true;
    return St->SecurityDescriptor != nullptr;
}

static std::wstring ToNtPath(const std::wstring &Rel)
{
    if (Rel.empty())
        return std::wstring(L"\\");
    return L"\\" + Rel;
}

static std::wstring CombinePath(const std::wstring &NtPath, const std::wstring &Name)
{
    std::wstring Out = NtPath;
    if (Out.size() > 1 && Out.back() != L'\\')
        Out.push_back(L'\\');
    Out += Name;
    return Out;
}

// ---------------------------------------------------------------------------
// Operation dispatchers.
// ---------------------------------------------------------------------------

// Call JS with op/path and wait for the reply. Runs on a WinFsp worker thread.
// The ThreadSafeFunction is the callback-based (untyped) kind: its CallJS
// invokes the std::function we hand to BlockingCall, funneling the Bridge
// pointer into BridgeCallback on the Node main thread. napi_call_threadsafe_
// function is asynchronous, so we wait on the condition variable until
// BridgeCallback has stored the reply into B.
static std::mutex g_cvMutex;
static std::condition_variable g_cv;

// Optional FS trace to the user's temp dir (enabled via OPBS_TRACE_FS=1).
static FILE *TraceFile()
{
    static FILE *f = nullptr;
    if (f == nullptr)
    {
        if (getenv("OPBS_TRACE_FS"))
        {
            WCHAR Dir[MAX_PATH];
            if (GetTempPathW(MAX_PATH, Dir) && Dir[0])
            {
                WCHAR Full[MAX_PATH];
                if (SUCCEEDED(StringCbCopyW(Full, sizeof Full, Dir)) &&
                    SUCCEEDED(StringCbCatW(Full, sizeof Full, L"opbs-fs-trace.log")))
                    f = _wfopen(Full, L"w");
            }
        }
    }
    return f;
}

static void Trace(ULONG TId, const char *Fmt, ...)
{
    FILE *f = TraceFile();
    if (!f)
        return;
    va_list Ap;
    va_start(Ap, Fmt);
    fwprintf(f, L"t=%lu ", TId);
    vfprintf(f, Fmt, Ap);
    fputc(L'\n', f);
    fflush(f);
    va_end(Ap);
}

static int64_t CallJs(MountState *St, Bridge &B)
{
    Trace(GetCurrentThreadId(), "CallJs op=%s path=%S", B.Op.c_str(), B.Path.c_str());
    std::unique_lock<std::mutex> Lock(g_cvMutex);
    B.Done = false;
    napi_status S = St->Tsf.BlockingCall(
        [&B](Napi::Env Env, Napi::Function JsHandler) {
            BridgeCallback(Env, JsHandler, &B);
            g_cv.notify_all();
        });
    if (S != napi_ok)
    {
        Trace(GetCurrentThreadId(), "CallJs %s -> napi %d", B.Op.c_str(), (int)S);
        return STATUS_UNSUCCESSFUL;
    }
    g_cv.wait(Lock, [&B] { return B.Done; });
    Trace(GetCurrentThreadId(), "CallJs %s -> status 0x%llX done", B.Op.c_str(), (unsigned long long)B.Status);
    return B.Status;
}

static NTSTATUS OpStat(MountState *St, const std::wstring &Path, Bridge *Out)
{
    Bridge B;
    B.Op = "stat";
    B.Path = ToNtPath(Path);
    int64_t Status = CallJs(St, B);
    if (NT_SUCCESS((NTSTATUS)Status) && Out)
        *Out = B;
    return (NTSTATUS)Status;
}

static void FillFileInfo(FSP_FSCTL_FILE_INFO *Info, const Bridge &B)
{
    memset(Info, 0, sizeof *Info);
    Info->FileAttributes = B.Attributes;
    Info->AllocationSize = B.AllocationSize != 0 ? B.AllocationSize : B.Size;
    Info->FileSize = B.Size;
    Info->CreationTime = B.CreationTime;
    Info->LastAccessTime = B.LastAccessTime;
    Info->LastWriteTime = B.LastWriteTime;
    Info->ChangeTime = B.ChangeTime;
    Info->IndexNumber = B.IndexNumber;
}

// -- GetVolumeInfo ----------------------------------------------------------

static NTSTATUS OpGetVolumeInfo(FSP_FILE_SYSTEM *Fs, FSP_FSCTL_VOLUME_INFO *VolumeInfo)
{
    MountState *St = Lookup(Fs);
    if (!St)
        return STATUS_INVALID_DEVICE_REQUEST;
    Trace(GetCurrentThreadId(), "GetVolumeInfo");
    memset(VolumeInfo, 0, sizeof *VolumeInfo);
    VolumeInfo->TotalSize = St->TotalSize;
    VolumeInfo->FreeSize = 0;
    VolumeInfo->VolumeLabelLength = (UINT16)(St->Label.size() * sizeof(WCHAR));
    if (VolumeInfo->VolumeLabelLength > sizeof VolumeInfo->VolumeLabel)
        VolumeInfo->VolumeLabelLength = (UINT16)sizeof VolumeInfo->VolumeLabel;
    memcpy(VolumeInfo->VolumeLabel, St->Label.data(), VolumeInfo->VolumeLabelLength);
    return STATUS_SUCCESS;
}

// -- GetSecurityByName ------------------------------------------------------

static NTSTATUS OpGetSecurityByName(
    FSP_FILE_SYSTEM *Fs, PWSTR FileName, PUINT32 PFileAttributes,
    PSECURITY_DESCRIPTOR SecurityDescriptor, SIZE_T *PSecurityDescriptorSize)
{
    MountState *St = Lookup(Fs);
    if (!St)
        return STATUS_INVALID_DEVICE_REQUEST;
    Trace(GetCurrentThreadId(), "GetSecurityByName %S", FileName ? FileName : L"<null>");

    Bridge B;
    B.Op = "stat";
    B.Path = FileName ? FileName : L"\\";
    int64_t Status = CallJs(St, B);
    if (!NT_SUCCESS((NTSTATUS)Status))
        return (NTSTATUS)Status;

    if (PFileAttributes)
        *PFileAttributes = B.Attributes;

    if (PSecurityDescriptorSize)
    {
        if (SecurityDescriptor)
        {
            if (!EnsureSecurity(St))
            {
                *PSecurityDescriptorSize = 0;
                Trace(GetCurrentThreadId(), "GetSecurityByName %S -> no SD", FileName ? FileName : L"<null>");
                return STATUS_SUCCESS;
            }
            SIZE_T Size = St->SecurityDescriptorSize;
            if (*PSecurityDescriptorSize < Size)
            {
                *PSecurityDescriptorSize = Size;
                Trace(GetCurrentThreadId(), "GetSecurityByName %S -> BUFFER_OVERFLOW need=%zu", FileName ? FileName : L"<null>", Size);
                return STATUS_BUFFER_OVERFLOW;
            }
            memcpy(SecurityDescriptor, St->SecurityDescriptor, Size);
            *PSecurityDescriptorSize = Size;
            Trace(GetCurrentThreadId(), "GetSecurityByName %S -> SD ok(%zu)", FileName ? FileName : L"<null>", Size);
        }
        else
        {
            if (EnsureSecurity(St))
                *PSecurityDescriptorSize = St->SecurityDescriptorSize;
            Trace(GetCurrentThreadId(), "GetSecurityByName %S -> size query %zu", FileName ? FileName : L"<null>",
                  EnsureSecurity(St) ? St->SecurityDescriptorSize : (SIZE_T)0);
        }
    }
    else
    {
        Trace(GetCurrentThreadId(), "GetSecurityByName %S -> no size ptr", FileName ? FileName : L"<null>");
    }
    return STATUS_SUCCESS;
}

// -- Open / Create ----------------------------------------------------------

static bool FileTypeMatches(uint32_t Attributes, uint32_t CreateOptions)
{
    bool IsDir = (Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    bool WantDir = (CreateOptions & FILE_DIRECTORY_FILE) != 0;
    if (WantDir && !IsDir)
        return true; // caller resolves mismatch below
    if (!WantDir && IsDir)
        return true;
    return true;
}

static NTSTATUS OpOpenOrCreate(
    FSP_FILE_SYSTEM *Fs, PWSTR FileName, UINT32 CreateOptions, bool Creating,
    PVOID *PFileContext, FSP_FSCTL_FILE_INFO *FileInfo)
{
    MountState *St = Lookup(Fs);
    if (!St)
        return STATUS_INVALID_DEVICE_REQUEST;
    Trace(GetCurrentThreadId(), "OpenOrCreate %S creating=%d options=0x%X", FileName ? FileName : L"<null>", (int)Creating, CreateOptions);

    std::wstring Path = FileName ? (std::wstring)FileName : std::wstring(L"\\");
    Bridge B;
    B.Op = "stat";
    B.Path = Path;
    int64_t Status = CallJs(St, B);
    if (!NT_SUCCESS((NTSTATUS)Status))
        return (NTSTATUS)Status;
    Trace(GetCurrentThreadId(), "OpenOrCreate %S creating=%d options=0x%X -> 0x%llX",
          FileName ? FileName : L"<null>", (int)Creating, CreateOptions, (unsigned long long)Status);

    if (NT_SUCCESS((NTSTATUS)Status))
    {
        bool IsDir = (B.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        bool WantDir = (CreateOptions & FILE_DIRECTORY_FILE) != 0;
        if (WantDir && !IsDir)
            return (NTSTATUS)STATUS_NOT_A_DIRECTORY;
        if (!WantDir && IsDir)
            return (NTSTATUS)STATUS_FILE_IS_A_DIRECTORY;
        auto *Ctx = new FileContext();
        Ctx->Path = Path;
        *PFileContext = Ctx;
        if (FileInfo)
            FillFileInfo(FileInfo, B);
        return STATUS_SUCCESS;
    }
    if (Status == STATUS_OBJECT_NAME_NOT_FOUND && Creating)
    {
        // Read-only volume: refuse to create new objects.
        return (NTSTATUS)STATUS_MEDIA_WRITE_PROTECTED;
    }
    return (NTSTATUS)Status;
}

static NTSTATUS OpCreate(
    FSP_FILE_SYSTEM *Fs, PWSTR FileName, UINT32 CreateOptions, UINT32 GrantedAccess,
    UINT32 FileAttributes, PSECURITY_DESCRIPTOR SecurityDescriptor, UINT64 AllocationSize,
    PVOID *PFileContext, FSP_FSCTL_FILE_INFO *FileInfo)
{
    (void)GrantedAccess; (void)FileAttributes; (void)SecurityDescriptor; (void)AllocationSize;
    return OpOpenOrCreate(Fs, FileName, CreateOptions, true, PFileContext, FileInfo);
}

static NTSTATUS OpOpen(
    FSP_FILE_SYSTEM *Fs, PWSTR FileName, UINT32 CreateOptions, UINT32 GrantedAccess,
    PVOID *PFileContext, FSP_FSCTL_FILE_INFO *FileInfo)
{
    (void)GrantedAccess;
    return OpOpenOrCreate(Fs, FileName, CreateOptions, false, PFileContext, FileInfo);
}

// -- Overwrite / mutating ---------------------------------------------------

static NTSTATUS OpDenyWrite(FSP_FILE_SYSTEM *Fs, PVOID FCtx)
{
    (void)Fs; (void)FCtx;
    return (NTSTATUS)STATUS_MEDIA_WRITE_PROTECTED;
}

// -- Cleanup / Close --------------------------------------------------------

static void OpCleanup(FSP_FILE_SYSTEM *Fs, PVOID FCtx, PWSTR FileName, ULONG Flags)
{
    (void)Fs; (void)FileName; (void)Flags;
    (void)FCtx;
}

static void OpClose(FSP_FILE_SYSTEM *Fs, PVOID FCtx)
{
    (void)Fs;
    delete static_cast<FileContext *>(FCtx);
}

// -- Read -------------------------------------------------------------------

static NTSTATUS OpRead(
    FSP_FILE_SYSTEM *Fs, PVOID FCtx, PVOID Buffer, UINT64 Offset, ULONG Length,
    PULONG PBytesTransferred)
{
    MountState *St = Lookup(Fs);
    auto *Ctx = static_cast<FileContext *>(FCtx);
    if (!St || !Ctx)
        return STATUS_INVALID_DEVICE_REQUEST;

    Bridge B;
    B.Op = "read";
    B.Path = Ctx->Path;
    B.Offset = Offset;
    B.Length = Length;
    int64_t Status = CallJs(St, B);
    if (!NT_SUCCESS((NTSTATUS)Status))
        return (NTSTATUS)Status;

    ULONG N = (ULONG)(B.Data.size() < Length ? B.Data.size() : Length);
    if (N > 0)
        memcpy(Buffer, B.Data.data(), N);
    *PBytesTransferred = N;
    return STATUS_SUCCESS;
}

// -- Flush ------------------------------------------------------------------

static NTSTATUS OpFlush(FSP_FILE_SYSTEM *Fs, PVOID FCtx, FSP_FSCTL_FILE_INFO *FileInfo)
{
    (void)Fs; (void)FCtx; (void)FileInfo;
    return STATUS_SUCCESS;
}

// -- GetFileInfo ------------------------------------------------------------

static NTSTATUS OpGetFileInfo(FSP_FILE_SYSTEM *Fs, PVOID FCtx, FSP_FSCTL_FILE_INFO *FileInfo)
{
MountState *St = Lookup(Fs);
    auto *Ctx = static_cast<FileContext *>(FCtx);
    if (!St || !Ctx)
        return STATUS_INVALID_DEVICE_REQUEST;
    Trace(GetCurrentThreadId(), "GetFileInfo %S", Ctx->Path.c_str());

    Bridge B;
    B.Op = "stat";
    B.Path = Ctx->Path;
    int64_t Status = CallJs(St, B);
    if (!NT_SUCCESS((NTSTATUS)Status))
        return (NTSTATUS)Status;
    FillFileInfo(FileInfo, B);
    return STATUS_SUCCESS;
}

// -- GetSecurity ------------------------------------------------------------

static NTSTATUS OpGetSecurity(
    FSP_FILE_SYSTEM *Fs, PVOID FCtx,
    PSECURITY_DESCRIPTOR SecurityDescriptor, SIZE_T *PSecurityDescriptorSize)
{
    (void)FCtx;
    MountState *St = Lookup(Fs);
    if (!St)
        return STATUS_INVALID_DEVICE_REQUEST;
    if (!EnsureSecurity(St))
        return STATUS_UNSUCCESSFUL;
    if (SecurityDescriptor && *PSecurityDescriptorSize >= St->SecurityDescriptorSize)
    {
        memcpy(SecurityDescriptor, St->SecurityDescriptor, St->SecurityDescriptorSize);
    }
    *PSecurityDescriptorSize = St->SecurityDescriptorSize;
    return STATUS_SUCCESS;
}

// -- ReadDirectory ----------------------------------------------------------

static NTSTATUS OpReadDirectory(
    FSP_FILE_SYSTEM *Fs, PVOID FCtx, PWSTR Pattern, PWSTR Marker,
    PVOID Buffer, ULONG Length, PULONG PBytesTransferred)
{
    (void)Pattern;
    MountState *St = Lookup(Fs);
    auto *Ctx = static_cast<FileContext *>(FCtx);
    if (!St || !Ctx)
        return STATUS_INVALID_DEVICE_REQUEST;
    Trace(GetCurrentThreadId(), "ReadDirectory %S pattern=%S marker=%S", Ctx->Path.c_str(),
          Pattern ? Pattern : L"<null>", Marker ? Marker : L"<null>");

    Bridge B;
    B.Op = "readDir";
    B.Path = Ctx->Path;
    if (Marker)
        B.Marker = std::wstring(Marker);

    int64_t Status = CallJs(St, B);
    if (!NT_SUCCESS((NTSTATUS)Status))
        return (NTSTATUS)Status;

    ULONG Bytes = 0;
    bool PastMarker = B.Marker.empty();
    for (const DirEntryReply &E : B.Entries)
    {
        if (!PastMarker)
        {
            if (E.Name == B.Marker)
                PastMarker = true;
            continue;
        }
        size_t NameBytes = E.Name.size() * sizeof(WCHAR);
        size_t Total = sizeof(FSP_FSCTL_DIR_INFO) + NameBytes;
        std::vector<uint8_t> Mem(Total, 0);
        auto *Info = reinterpret_cast<FSP_FSCTL_DIR_INFO *>(Mem.data());
        Info->Size = (UINT16)Total;
        Info->FileInfo.FileAttributes = E.Attributes;
        Info->FileInfo.AllocationSize = E.Size;
        Info->FileInfo.FileSize = E.Size;
        Info->FileInfo.CreationTime = E.CreationTime;
        Info->FileInfo.LastAccessTime = E.LastAccessTime;
        Info->FileInfo.LastWriteTime = E.LastWriteTime;
        Info->FileInfo.ChangeTime = E.ChangeTime;
        Info->FileInfo.IndexNumber = E.IndexNumber;
        // FSP_FSCTL_DIR_INFO.FileName[] points at the name.
        memcpy(Info->FileNameBuf, E.Name.data(), NameBytes);
        if (!g_api.FspFileSystemAddDirInfo(Info, Buffer, Length, &Bytes))
        {
            // Buffer full: stop. Windows re-queries with a Marker set to the
            // last returned name (its offset-based continuation is handled by
            // the FSD internally since DirectoryMarkerAsNextOffset is 0).
            break;
        }
    }
    // EOF marker.
    g_api.FspFileSystemAddDirInfo(nullptr, Buffer, Length, &Bytes);
    *PBytesTransferred = Bytes;
    Trace(GetCurrentThreadId(), "ReadDirectory %S -> bytes=%lu status 0x0", Ctx->Path.c_str(), (unsigned long)Bytes);
    return STATUS_SUCCESS;
}

// -- GetDirInfoByName -------------------------------------------------------

static NTSTATUS OpGetDirInfoByName(
    FSP_FILE_SYSTEM *Fs, PVOID FCtx, PWSTR FileName, FSP_FSCTL_DIR_INFO *DirInfo)
{
    MountState *St = Lookup(Fs);
    auto *Ctx = static_cast<FileContext *>(FCtx);
    if (!St || !Ctx)
        return STATUS_INVALID_DEVICE_REQUEST;
    Trace(GetCurrentThreadId(), "GetDirInfoByName %S name=%S", Ctx->Path.c_str(), FileName ? FileName : L"<null>");

    Bridge B;
    B.Op = "stat";
    B.Path = CombinePath(Ctx->Path, FileName ? FileName : L"");
    int64_t Status = CallJs(St, B);
    if (!NT_SUCCESS((NTSTATUS)Status))
        return (NTSTATUS)Status;

    size_t NameBytes = wcslen(FileName) * sizeof(WCHAR);
    DirInfo->Size = (UINT16)(sizeof(FSP_FSCTL_DIR_INFO) + NameBytes);
    FillFileInfo(&DirInfo->FileInfo, B);
    memcpy(DirInfo->FileNameBuf, FileName, NameBytes);
    return STATUS_SUCCESS;
}

// -- GetStreamInfo ----------------------------------------------------------

static NTSTATUS OpGetStreamInfo(
    FSP_FILE_SYSTEM *Fs, PVOID FCtx, PVOID Buffer, ULONG Length,
    PULONG PBytesTransferred)
{
    (void)Fs; (void)FCtx; (void)Buffer; (void)Length;
    // No named streams: report the default stream only.
    *PBytesTransferred = 0;
    return STATUS_SUCCESS;
}

// -- Reparse points / control ----------------------------------------------

static NTSTATUS OpResolveReparsePoints(
    FSP_FILE_SYSTEM *Fs, PWSTR FileName, UINT32 ReparsePointIndex,
    BOOLEAN ResolveLastPathComponent, PIO_STATUS_BLOCK PIoStatus, PVOID Buffer,
    PSIZE_T PSize)
{
    (void)Fs; (void)FileName; (void)ReparsePointIndex; (void)ResolveLastPathComponent;
    (void)PIoStatus; (void)Buffer; (void)PSize;
    return (NTSTATUS)STATUS_NOT_A_REPARSE_POINT;
}

static void OpDispatcherStopped(FSP_FILE_SYSTEM *Fs, BOOLEAN Normally)
{
    (void)Fs; (void)Normally;
}

// ---------------------------------------------------------------------------
// The operation interface. Zero-initialized then filled in.
// ---------------------------------------------------------------------------

static FSP_FILE_SYSTEM_INTERFACE g_interface;

static void BuildInterface()
{
    memset(&g_interface, 0, sizeof g_interface);
    g_interface.GetVolumeInfo = OpGetVolumeInfo;
    g_interface.SetVolumeLabel = [](FSP_FILE_SYSTEM *Fs, PWSTR V, FSP_FSCTL_VOLUME_INFO *I) -> NTSTATUS
    { (void)Fs; (void)V; (void)I; return (NTSTATUS)STATUS_MEDIA_WRITE_PROTECTED; };
    g_interface.GetSecurityByName = OpGetSecurityByName;
    g_interface.Create = OpCreate;
    g_interface.Open = OpOpen;
    g_interface.Overwrite = [](FSP_FILE_SYSTEM *Fs, PVOID C, UINT32, BOOLEAN, UINT64, FSP_FSCTL_FILE_INFO *I) -> NTSTATUS
    { (void)I; return OpDenyWrite(Fs, C); };
    g_interface.OverwriteEx = [](FSP_FILE_SYSTEM *Fs, PVOID C, UINT32, BOOLEAN, UINT64, PFILE_FULL_EA_INFORMATION, ULONG, FSP_FSCTL_FILE_INFO *I) -> NTSTATUS
    { (void)I; return OpDenyWrite(Fs, C); };
    g_interface.Cleanup = OpCleanup;
    g_interface.Close = OpClose;
    g_interface.Read = OpRead;
    g_interface.Write = [](FSP_FILE_SYSTEM *Fs, PVOID C, PVOID, UINT64, ULONG,
                          BOOLEAN, BOOLEAN, PULONG, FSP_FSCTL_FILE_INFO *) -> NTSTATUS
    { return OpDenyWrite(Fs, C); };
    g_interface.Flush = OpFlush;
    g_interface.GetFileInfo = OpGetFileInfo;
    g_interface.SetBasicInfo = [](FSP_FILE_SYSTEM *Fs, PVOID C, UINT32, UINT64, UINT64, UINT64, UINT64, FSP_FSCTL_FILE_INFO *I) -> NTSTATUS
    { (void)I; return OpDenyWrite(Fs, C); };
    g_interface.SetFileSize = [](FSP_FILE_SYSTEM *Fs, PVOID C, UINT64, BOOLEAN, FSP_FSCTL_FILE_INFO *I) -> NTSTATUS
    { (void)I; return OpDenyWrite(Fs, C); };
    g_interface.CanDelete = [](FSP_FILE_SYSTEM *Fs, PVOID C, PWSTR) -> NTSTATUS
    { return OpDenyWrite(Fs, C); };
    g_interface.Rename = [](FSP_FILE_SYSTEM *Fs, PVOID C, PWSTR, PWSTR, BOOLEAN) -> NTSTATUS
    { return OpDenyWrite(Fs, C); };
    g_interface.GetSecurity = OpGetSecurity;
    g_interface.SetSecurity = [](FSP_FILE_SYSTEM *Fs, PVOID C,
                                 SECURITY_INFORMATION, PSECURITY_DESCRIPTOR) -> NTSTATUS
    { return OpDenyWrite(Fs, C); };
    g_interface.ReadDirectory = OpReadDirectory;
    g_interface.ResolveReparsePoints = OpResolveReparsePoints;
    g_interface.GetReparsePoint = [](FSP_FILE_SYSTEM *Fs, PVOID C, PWSTR, PVOID, PSIZE_T) -> NTSTATUS
    { (void)Fs; (void)C; return (NTSTATUS)STATUS_NOT_A_REPARSE_POINT; };
    g_interface.SetReparsePoint = [](FSP_FILE_SYSTEM *Fs, PVOID C, PWSTR, PVOID, SIZE_T) -> NTSTATUS
    { return OpDenyWrite(Fs, C); };
    g_interface.DeleteReparsePoint = [](FSP_FILE_SYSTEM *Fs, PVOID C, PWSTR, PVOID, SIZE_T) -> NTSTATUS
    { return OpDenyWrite(Fs, C); };
    g_interface.GetStreamInfo = OpGetStreamInfo;
    g_interface.GetDirInfoByName = OpGetDirInfoByName;
    g_interface.Control = [](FSP_FILE_SYSTEM *Fs, PVOID C, UINT32, PVOID, ULONG,
                             PVOID, ULONG, PULONG) -> NTSTATUS
    { (void)C; (void)Fs; return STATUS_NOT_SUPPORTED; };
    g_interface.SetDelete = [](FSP_FILE_SYSTEM *Fs, PVOID C, PWSTR, BOOLEAN) -> NTSTATUS
    { return OpDenyWrite(Fs, C); };
    g_interface.DispatcherStopped = OpDispatcherStopped;
}

// ---------------------------------------------------------------------------
// N-API exports.
// ---------------------------------------------------------------------------

static std::string NtStatusHex(NTSTATUS Status)
{
    char Buf[16];
    snprintf(Buf, sizeof Buf, "0x%08X", static_cast<unsigned>(Status));
    return Buf;
}

Napi::Value WinFspAvailable(const Napi::CallbackInfo &Info)
{
    EnsureWinFsp();
    return Napi::Boolean::New(Info.Env(), g_api.Module != nullptr);
}

// Human-readable note on the last detection attempt ("WinFsp not detected" etc.)
Napi::Value WinFspLoadNote(const Napi::CallbackInfo &Info)
{
    return Napi::String::New(Info.Env(),
        reinterpret_cast<const char16_t *>(g_loadNote.c_str()), g_loadNote.size());
}

Napi::Value WinFspMount(const Napi::CallbackInfo &Info)
{
    Napi::Env Env = Info.Env();
    EnsureWinFsp();
    if (g_api.Module == nullptr)
    {
        Napi::Error::New(Env, "WinFsp is not installed").ThrowAsJavaScriptException();
        return Env.Null();
    }

    Napi::Object Config = Info[0].As<Napi::Object>();
    Napi::Function Handler = Info[1].As<Napi::Function>();
    std::string Label = Config.Get("label").As<Napi::String>().Utf8Value();
    double TotalSize = Config.Get("totalSize").As<Napi::Number>().DoubleValue();
    bool HasLetter = Config.Has("driveLetter") && Config.Get("driveLetter").IsString();
    std::wstring MountPoint;
    if (HasLetter)
    {
        std::string Letter = Config.Get("driveLetter").As<Napi::String>().Utf8Value();
        MountPoint = NormalizeDriveMountPoint(Utf8ToWide(Letter));
        if (MountPoint.empty())
        {
            Napi::Error::New(Env, "Invalid drive letter (expected e.g. \"Z:\")")
                .ThrowAsJavaScriptException();
            return Env.Null();
        }
    }
    else
    {
        // No letter requested: still use Mount Manager form, not DefineDosDevice.
        MountPoint = PickGlobalDriveMountPoint();
    }

    auto *St = new MountState();
    St->Id = g_nextId++;
    St->Label = Utf8ToWide(Label);
    St->TotalSize = static_cast<uint64_t>(TotalSize);

    FSP_FSCTL_VOLUME_PARAMS Params;
    memset(&Params, 0, sizeof Params);
    Params.Version = sizeof Params;
    Params.SectorSize = 512;
    Params.SectorsPerAllocationUnit = 1;
    Params.MaxComponentLength = 255;
    Params.VolumeCreationTime = 0;
    Params.VolumeSerialNumber = 0x4F505342u ^ static_cast<uint32_t>(St->Id);
    Params.IrpCapacity = 100;
    Params.CaseSensitiveSearch = 0;
    Params.CasePreservedNames = 1;
    Params.UnicodeOnDisk = 1;
    Params.PersistentAcls = 0;
    Params.ReparsePoints = 0;
    Params.ReparsePointsAccessCheck = 0;
    Params.NamedStreams = 0;
    Params.HardLinks = 0;
    Params.ExtendedAttributes = 0;
    Params.ReadOnlyVolume = 1;
    Params.PostCleanupWhenModifiedOnly = 0;
    Params.PassQueryDirectoryPattern = 1;
    Params.DirInfoTimeoutValid = 1;
    Params.DirInfoTimeout = 30000;
    wcsncpy_s(Params.FileSystemName, L"NTFS", FSP_FSCTL_VOLUME_FSNAME_SIZE / sizeof(WCHAR));

    wchar_t DevicePath[] = L"WinFsp.Disk";
    NTSTATUS Status = g_api.FspFileSystemCreate(
        DevicePath, &Params, &g_interface, &St->Fs);
    if (!NT_SUCCESS(Status))
    {
        delete St;
        Napi::Error::New(Env, "FspFileSystemCreate failed: " + NtStatusHex(Status))
            .ThrowAsJavaScriptException();
        return Env.Null();
    }

    {
        std::lock_guard<std::mutex> Lock(g_mountsMutex);
        g_mounts[St->Fs] = St;
        g_mountsById[St->Id] = St;
    }

    St->Tsf = Napi::ThreadSafeFunction::New(Env, Handler, "winfspMount", 0, 1);

    PWSTR Mount = MountPoint.empty() ? nullptr : (PWSTR)MountPoint.data();
    Status = g_api.FspFileSystemSetMountPoint(St->Fs, Mount);
    if (!NT_SUCCESS(Status))
    {
        Napi::Error::New(Env, "FspFileSystemSetMountPoint failed: " + NtStatusHex(Status))
            .ThrowAsJavaScriptException();
        St->Tsf.Release();
        {
            std::lock_guard<std::mutex> Lock(g_mountsMutex);
            g_mounts.erase(St->Fs);
            g_mountsById.erase(St->Id);
        }
        g_api.FspFileSystemDelete(St->Fs);
        delete St;
        return Env.Null();
    }

    Status = g_api.FspFileSystemStartDispatcher(St->Fs, 0);
    if (!NT_SUCCESS(Status))
    {
        Napi::Error::New(Env, "FspFileSystemStartDispatcher failed: " + NtStatusHex(Status))
            .ThrowAsJavaScriptException();
        g_api.FspFileSystemRemoveMountPoint(St->Fs);
        St->Tsf.Release();
        {
            std::lock_guard<std::mutex> Lock(g_mountsMutex);
            g_mounts.erase(St->Fs);
            g_mountsById.erase(St->Id);
        }
        g_api.FspFileSystemDelete(St->Fs);
        delete St;
        return Env.Null();
    }

    Napi::Object Result = Napi::Object::New(Env);
    Result.Set("id", Napi::Number::New(Env, St->Id));
    PWSTR Actual = St->Fs->MountPoint;
    std::wstring Shown = DisplayMountPoint(Actual ? Actual : MountPoint);
    NotifyShellDriveChange(Actual ? Actual : MountPoint, true);
    Result.Set("mountPoint", Napi::String::New(Env, WideToUtf8(Shown)));
    return Result;
}

Napi::Value WinFspUnmount(const Napi::CallbackInfo &Info)
{
    Napi::Env Env = Info.Env();
    uint32_t Id = static_cast<uint32_t>(Info[0].As<Napi::Number>().Int32Value());

    MountState *St = nullptr;
    {
        std::lock_guard<std::mutex> Lock(g_mountsMutex);
        auto It = g_mountsById.find(Id);
        if (It != g_mountsById.end())
        {
            St = It->second;
            g_mountsById.erase(It);
        }
    }
    if (!St)
        return Napi::Boolean::New(Env, false);

    {
        std::lock_guard<std::mutex> Lock(g_mountsMutex);
        g_mounts.erase(St->Fs);
    }

    std::wstring MountBeforeRemove =
        St->Fs->MountPoint ? St->Fs->MountPoint : std::wstring();
    g_api.FspFileSystemStopDispatcher(St->Fs);
    g_api.FspFileSystemRemoveMountPoint(St->Fs);
    g_api.FspFileSystemDelete(St->Fs);
    if (St->Tsf)
        St->Tsf.Release();
    if (St->SecurityDescriptor)
        LocalFree(St->SecurityDescriptor);
    delete St;
    if (!MountBeforeRemove.empty())
        NotifyShellDriveChange(MountBeforeRemove, false);

    return Napi::Boolean::New(Env, true);
}

void Register(Napi::Env Env, Napi::Object Exports)
{
    SetUnhandledExceptionFilter(OpbsExceptionFilter);
    BuildInterface();
    if (LoadWinFspDll())
    {
        if (!g_api.Resolve(g_api.Module) && g_api.Module)
        {
            FreeLibrary(g_api.Module);
            g_api.Module = nullptr;
        }
    }
    Exports.Set("winfspAvailable", Napi::Function::New(Env, WinFspAvailable));
    Exports.Set("winfspLoadNote", Napi::Function::New(Env, WinFspLoadNote));
    Exports.Set("winfspMount", Napi::Function::New(Env, WinFspMount));
    Exports.Set("winfspUnmount", Napi::Function::New(Env, WinFspUnmount));
}

} // namespace opbs_winfsp

void RegisterWinFspMount(Napi::Env Env, Napi::Object Exports)
{
    opbs_winfsp::Register(Env, Exports);
}