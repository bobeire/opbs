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
#include <cstring>
#include <cwchar>
#include <windows.h>
#include <sddl.h>
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

static HMODULE LoadWinFspDll()
{
    HMODULE M = LoadLibraryW(L"winfsp-x64.dll");
    if (M)
        return M;

    // Fall back to the InstallDir recorded by the WinFsp MSI.
    WCHAR Path[MAX_PATH];
    DWORD Size = sizeof Path;
    LONG R = RegGetValueW(
        HKEY_LOCAL_MACHINE,
        L"Software\\WOW6432Node\\WinFsp",
        L"InstallDir",
        RRF_RT_REG_SZ,
        nullptr,
        Path,
        &Size);
    if (ERROR_SUCCESS == R)
    {
        wcscat_s(Path, L"bin\\winfsp-x64.dll");
        return LoadLibraryW(Path);
    }
    return nullptr;
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

// Build a self-relative security descriptor granting everyone broad access.
static PSECURITY_DESCRIPTOR BuildDefaultSecurity(SIZE_T *POutSize)
{
    PSECURITY_DESCRIPTOR SD = nullptr;
    ULONG Size = 0;
    if (ConvertStringSecurityDescriptorToSecurityDescriptorA(
            "D:P(A;;GA;;;WD)", SDDL_REVISION_1, &SD, &Size))
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
static int64_t CallJs(MountState *St, Bridge &B)
{
    B.Done = false;
    napi_status S = St->Tsf.BlockingCall(static_cast<void *>(&B));
    if (S != napi_ok)
        return STATUS_UNSUCCESSFUL;
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
                return STATUS_SUCCESS;
            }
            SIZE_T Size = St->SecurityDescriptorSize;
            if (*PSecurityDescriptorSize < Size)
            {
                *PSecurityDescriptorSize = Size;
                return STATUS_BUFFER_OVERFLOW;
            }
            memcpy(SecurityDescriptor, St->SecurityDescriptor, Size);
            *PSecurityDescriptorSize = Size;
        }
        else
        {
            if (EnsureSecurity(St))
                *PSecurityDescriptorSize = St->SecurityDescriptorSize;
        }
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

    std::wstring Path = FileName ? (std::wstring)FileName : std::wstring(L"\\");
    Bridge B;
    B.Op = "stat";
    B.Path = Path;
    int64_t Status = CallJs(St, B);
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

Napi::Value WinFspAvailable(const Napi::CallbackInfo &Info)
{
    return Napi::Boolean::New(Info.Env(), g_api.Module != nullptr);
}

Napi::Value WinFspMount(const Napi::CallbackInfo &Info)
{
    Napi::Env Env = Info.Env();
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
        MountPoint = Utf8ToWide(Letter);
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
        Napi::Error::New(Env, "FspFileSystemCreate failed: 0x" + std::to_string(Status))
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
        Napi::Error::New(Env, "FspFileSystemSetMountPoint failed: 0x" + std::to_string(Status))
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
        Napi::Error::New(Env, "FspFileSystemStartDispatcher failed: 0x" + std::to_string(Status))
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
    Result.Set("mountPoint", Napi::String::New(Env, WideToUtf8(Actual ? Actual : L"")));
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

    g_api.FspFileSystemStopDispatcher(St->Fs);
    g_api.FspFileSystemRemoveMountPoint(St->Fs);
    g_api.FspFileSystemDelete(St->Fs);
    if (St->Tsf)
        St->Tsf.Release();
    if (St->SecurityDescriptor)
        LocalFree(St->SecurityDescriptor);
    delete St;

    return Napi::Boolean::New(Env, true);
}

void Register(Napi::Env Env, Napi::Object Exports)
{
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
    Exports.Set("winfspMount", Napi::Function::New(Env, WinFspMount));
    Exports.Set("winfspUnmount", Napi::Function::New(Env, WinFspUnmount));
}

} // namespace opbs_winfsp

void RegisterWinFspMount(Napi::Env Env, Napi::Object Exports)
{
    opbs_winfsp::Register(Env, Exports);
}