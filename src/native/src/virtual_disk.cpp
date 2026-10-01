#include <napi.h>

#include <windows.h>
#include <initguid.h>
#include <virtdisk.h>

#include <stdexcept>
#include <string>
#include <vector>

// VHD/VHDX restore-target support via the Windows virtdisk API. These wrappers
// run inside the elevated helper process (create/attach/detach need admin) and
// are the only place OPBS talks to CreateVirtualDisk / AttachVirtualDisk.

namespace {

std::string Narrow(const std::wstring& w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    std::string s(n, 0);
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), &s[0], n, nullptr, nullptr);
    return s;
}

std::wstring Widen(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), &w[0], n);
    return w;
}

std::string Win32Message(DWORD code) {
    char buf[512] = {0};
    DWORD len = FormatMessageA(
        FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        buf, sizeof(buf) - 1, nullptr);
    while (len > 0 && (buf[len - 1] == '\r' || buf[len - 1] == '\n' || buf[len - 1] == ' ')) {
        buf[--len] = 0;
    }
    std::string msg = len > 0 ? std::string(buf) : "unknown error";
    return msg + " (code " + std::to_string(code) + ")";
}

void ThrowLast(Napi::Env env, const char* what, DWORD code) {
    Napi::Error::New(env, std::string(what) + " failed: " + Win32Message(code))
        .ThrowAsJavaScriptException();
}

VIRTUAL_STORAGE_TYPE DeviceTypeFor(const std::wstring& path) {
    VIRTUAL_STORAGE_TYPE t{};
    bool vhdx = false;
    if (path.size() >= 5) {
        vhdx = _wcsicmp(path.c_str() + (path.size() - 5), L".vhdx") == 0;
    }
    t.DeviceId = vhdx ? VIRTUAL_STORAGE_TYPE_DEVICE_VHDX : VIRTUAL_STORAGE_TYPE_DEVICE_VHD;
    t.VendorId = VIRTUAL_STORAGE_TYPE_VENDOR_MICROSOFT;
    return t;
}

// --- create ---------------------------------------------------------------

void CreateVirtualDiskImpl(const std::wstring& path, ULONGLONG sizeBytes, bool fixedDisk) {
    VIRTUAL_STORAGE_TYPE storage = DeviceTypeFor(path);

    CREATE_VIRTUAL_DISK_PARAMETERS params{};
    params.Version = CREATE_VIRTUAL_DISK_VERSION_2;
    params.Version2.UniqueId = GUID_NULL;
    params.Version2.MaximumSize = sizeBytes;
    params.Version2.BlockSizeInBytes = CREATE_VIRTUAL_DISK_PARAMETERS_DEFAULT_BLOCK_SIZE;
    params.Version2.SectorSizeInBytes = CREATE_VIRTUAL_DISK_PARAMETERS_DEFAULT_SECTOR_SIZE;
    params.Version2.PhysicalSectorSizeInBytes = 0;
    params.Version2.ParentPath = nullptr;
    params.Version2.SourcePath = nullptr;
    params.Version2.OpenFlags = OPEN_VIRTUAL_DISK_FLAG_NONE;
    params.Version2.ParentVirtualStorageType = VIRTUAL_STORAGE_TYPE{};
    params.Version2.SourceVirtualStorageType = VIRTUAL_STORAGE_TYPE{};
    params.Version2.ResiliencyGuid = GUID_NULL;

    CREATE_VIRTUAL_DISK_FLAG flags = fixedDisk
        ? CREATE_VIRTUAL_DISK_FLAG_FULL_PHYSICAL_ALLOCATION
        : CREATE_VIRTUAL_DISK_FLAG_NONE;

    HANDLE handle = INVALID_HANDLE_VALUE;
    // VIRTUAL_DISK_ACCESS_NONE is the documented mask for Win8+; older
    // providers reject it, so retry with ALL before giving up.
    DWORD err = CreateVirtualDisk(
        &storage, path.c_str(), VIRTUAL_DISK_ACCESS_NONE, nullptr,
        flags, 0, &params, nullptr, &handle);
    if (err != ERROR_SUCCESS && (err == ERROR_INVALID_PARAMETER || err == ERROR_ACCESS_DENIED)) {
        err = CreateVirtualDisk(
            &storage, path.c_str(), VIRTUAL_DISK_ACCESS_ALL, nullptr,
            flags, 0, &params, nullptr, &handle);
    }
    if (err != ERROR_SUCCESS) {
        throw std::runtime_error(Win32Message(err));
    }
    if (handle != nullptr && handle != INVALID_HANDLE_VALUE) {
        CloseHandle(handle);
    }
}

// --- open helpers ---------------------------------------------------------

// Handles used for attach / detach / GetVirtualDiskPhysicalPath must carry
// real rights: opening with VIRTUAL_DISK_ACCESS_NONE succeeds but the later
// AttachVirtualDisk then fails with ERROR_ACCESS_DENIED (verified empirically
// on Win11 26100 — NONE handles attach/physical-path both return code 5).
// ALL covers every operation we need; NONE stays as a fallback for providers
// that reject the legacy mask.
HANDLE OpenForModify(const std::wstring& path, DWORD* errOut) {
    VIRTUAL_STORAGE_TYPE storage = DeviceTypeFor(path);
    HANDLE handle = INVALID_HANDLE_VALUE;
    DWORD err = OpenVirtualDisk(
        &storage, path.c_str(), VIRTUAL_DISK_ACCESS_ALL,
        OPEN_VIRTUAL_DISK_FLAG_NONE, nullptr, &handle);
    if (err != ERROR_SUCCESS) {
        err = OpenVirtualDisk(
            &storage, path.c_str(), VIRTUAL_DISK_ACCESS_NONE,
            OPEN_VIRTUAL_DISK_FLAG_NONE, nullptr, &handle);
    }
    *errOut = err;
    return handle;
}

HANDLE OpenForInfo(const std::wstring& path, DWORD* errOut) {
    VIRTUAL_STORAGE_TYPE storage = DeviceTypeFor(path);

    OPEN_VIRTUAL_DISK_PARAMETERS params{};
    params.Version = OPEN_VIRTUAL_DISK_VERSION_2;
    params.Version2.GetInfoOnly = TRUE;
    params.Version2.ReadOnly = TRUE;
    params.Version2.ResiliencyGuid = GUID_NULL;

    HANDLE handle = INVALID_HANDLE_VALUE;
    DWORD err = OpenVirtualDisk(
        &storage, path.c_str(), VIRTUAL_DISK_ACCESS_GET_INFO,
        OPEN_VIRTUAL_DISK_FLAG_NONE, &params, &handle);
    if (err != ERROR_SUCCESS) {
        err = OpenVirtualDisk(
            &storage, path.c_str(), VIRTUAL_DISK_ACCESS_GET_INFO,
            OPEN_VIRTUAL_DISK_FLAG_NONE, nullptr, &handle);
    }
    if (err != ERROR_SUCCESS) {
        err = OpenVirtualDisk(
            &storage, path.c_str(), VIRTUAL_DISK_ACCESS_NONE,
            OPEN_VIRTUAL_DISK_FLAG_NONE, nullptr, &handle);
    }
    *errOut = err;
    return handle;
}

// --- info -----------------------------------------------------------------

struct VhdInfo {
    ULONGLONG virtualSize = 0;
    ULONGLONG physicalSize = 0;
    ULONG blockSize = 0;
    ULONG sectorSize = 0;
    BOOL isLoaded = FALSE;
};

bool QueryInfo(const std::wstring& path, VhdInfo* out, DWORD* errOut) {
    DWORD err = ERROR_SUCCESS;
    HANDLE handle = OpenForInfo(path, &err);
    if (handle == INVALID_HANDLE_VALUE) {
        *errOut = err;
        return false;
    }

    GET_VIRTUAL_DISK_INFO info{};
    info.Version = GET_VIRTUAL_DISK_INFO_SIZE;
    ULONG size = sizeof(info);
    ULONG used = 0;
    err = GetVirtualDiskInformation(handle, &size, &info, &used);
    if (err == ERROR_SUCCESS) {
        out->virtualSize = info.Size.VirtualSize;
        out->physicalSize = info.Size.PhysicalSize;
        out->blockSize = info.Size.BlockSize;
        out->sectorSize = info.Size.SectorSize;
    }

    if (err == ERROR_SUCCESS) {
        GET_VIRTUAL_DISK_INFO loaded{};
        loaded.Version = GET_VIRTUAL_DISK_INFO_IS_LOADED;
        ULONG lsize = sizeof(loaded);
        ULONG lused = 0;
        if (GetVirtualDiskInformation(handle, &lsize, &loaded, &lused) == ERROR_SUCCESS) {
            out->isLoaded = loaded.IsLoaded;
        }
    }

    CloseHandle(handle);
    *errOut = err;
    return err == ERROR_SUCCESS;
}

// --- Napi exports ---------------------------------------------------------

Napi::Value CreateVirtualDiskJs(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString()) {
        Napi::TypeError::New(env, "createVirtualDisk expects (path, sizeBytes, format?, fixed?)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::wstring path = Widen(info[0].As<Napi::String>().Utf8Value());

    ULONGLONG sizeBytes = 0;
    if (info[1].IsBigInt()) {
        bool lossless = false;
        sizeBytes = info[1].As<Napi::BigInt>().Uint64Value(&lossless);
    } else {
        double v = info[1].As<Napi::Number>().DoubleValue();
        if (v < 0) v = 0;
        sizeBytes = static_cast<ULONGLONG>(v);
    }
    if (sizeBytes == 0) {
        Napi::TypeError::New(env, "createVirtualDisk: sizeBytes must be > 0").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    bool fixedDisk = info.Length() > 3 && info[3].ToBoolean().Value();

    try {
        CreateVirtualDiskImpl(path, sizeBytes, fixedDisk);
    } catch (const std::exception& e) {
        Napi::Error::New(env, std::string("createVirtualDisk: ") + e.what())
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return env.Undefined();
}

Napi::Value AttachVirtualDiskJs(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "attachVirtualDisk expects (path)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::wstring path = Widen(info[0].As<Napi::String>().Utf8Value());

    DWORD err = ERROR_SUCCESS;
    HANDLE handle = OpenForModify(path, &err);
    if (handle == INVALID_HANDLE_VALUE) {
        ThrowLast(env, "attachVirtualDisk(open)", err);
        return env.Undefined();
    }

    ATTACH_VIRTUAL_DISK_PARAMETERS params{};
    params.Version = ATTACH_VIRTUAL_DISK_VERSION_1;
    params.Version1.Reserved = 0;

    // PERMANENT_LIFETIME is required: this handle is closed right after the
    // call and without the flag Windows detaches the disk again on the last
    // handle close (verified: probe after close returns err 55). A retry with
    // plain NO_DRIVE_LETTER would attach-then-instantly-detach, so any failure
    // surfaces as-is instead of being masked.
    err = AttachVirtualDisk(
        handle, nullptr,
        ATTACH_VIRTUAL_DISK_FLAG_NO_DRIVE_LETTER | ATTACH_VIRTUAL_DISK_FLAG_PERMANENT_LIFETIME,
        0, &params, nullptr);
    CloseHandle(handle);

    if (err != ERROR_SUCCESS) {
        ThrowLast(env, "attachVirtualDisk", err);
        return env.Undefined();
    }
    return Napi::Boolean::New(env, true);
}

Napi::Value DetachVirtualDiskJs(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "detachVirtualDisk expects (path)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::wstring path = Widen(info[0].As<Napi::String>().Utf8Value());

    DWORD err = ERROR_SUCCESS;
    HANDLE handle = OpenForModify(path, &err);
    if (handle == INVALID_HANDLE_VALUE) {
        ThrowLast(env, "detachVirtualDisk(open)", err);
        return env.Undefined();
    }
    err = DetachVirtualDisk(handle, DETACH_VIRTUAL_DISK_FLAG_NONE, 0);
    CloseHandle(handle);

    if (err != ERROR_SUCCESS) {
        ThrowLast(env, "detachVirtualDisk", err);
        return env.Undefined();
    }
    return Napi::Boolean::New(env, true);
}

Napi::Value GetVirtualDiskInfoJs(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "getVirtualDiskInfo expects (path)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::wstring path = Widen(info[0].As<Napi::String>().Utf8Value());

    VhdInfo v{};
    DWORD err = ERROR_SUCCESS;
    if (!QueryInfo(path, &v, &err)) {
        ThrowLast(env, "getVirtualDiskInfo", err);
        return env.Undefined();
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("virtualSize", Napi::Number::New(env, static_cast<double>(v.virtualSize)));
    result.Set("physicalSize", Napi::Number::New(env, static_cast<double>(v.physicalSize)));
    result.Set("blockSize", Napi::Number::New(env, v.blockSize));
    result.Set("sectorSize", Napi::Number::New(env, v.sectorSize));
    result.Set("isLoaded", Napi::Boolean::New(env, v.isLoaded != FALSE));
    return result;
}

// Returns "\\\\.\\PhysicalDriveN" for the attached virtual disk — the exact
// device the VHD/VHDX maps to, so the helper never has to guess by size.
Napi::Value GetVirtualDiskPhysicalPathJs(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "getVirtualDiskPhysicalPath expects (path)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::wstring path = Widen(info[0].As<Napi::String>().Utf8Value());

    DWORD err = ERROR_SUCCESS;
    HANDLE handle = OpenForModify(path, &err);
    if (handle == INVALID_HANDLE_VALUE) {
        ThrowLast(env, "getVirtualDiskPhysicalPath(open)", err);
        return env.Undefined();
    }

    ULONG bufBytes = 0;
    err = GetVirtualDiskPhysicalPath(handle, &bufBytes, nullptr);
    if (err == ERROR_SUCCESS || err == ERROR_MORE_DATA || err == ERROR_INSUFFICIENT_BUFFER) {
        if (bufBytes < 64) bufBytes = 64;
        std::vector<wchar_t> buf(bufBytes / sizeof(wchar_t) + 2, L'\0');
        ULONG bufSize = static_cast<ULONG>(buf.size() * sizeof(wchar_t));
        err = GetVirtualDiskPhysicalPath(handle, &bufSize, buf.data());
        if (err == ERROR_SUCCESS) {
            std::string narrow = Narrow(std::wstring(buf.data()));
            CloseHandle(handle);
            return Napi::String::New(env, narrow);
        }
    }
    CloseHandle(handle);
    ThrowLast(env, "getVirtualDiskPhysicalPath", err);
    return env.Undefined();
}

}  // namespace

void RegisterVirtualDisk(Napi::Env env, Napi::Object exports) {
    exports.Set("createVirtualDisk", Napi::Function::New(env, CreateVirtualDiskJs));
    exports.Set("attachVirtualDisk", Napi::Function::New(env, AttachVirtualDiskJs));
    exports.Set("detachVirtualDisk", Napi::Function::New(env, DetachVirtualDiskJs));
    exports.Set("getVirtualDiskInfo", Napi::Function::New(env, GetVirtualDiskInfoJs));
    exports.Set("getVirtualDiskPhysicalPath", Napi::Function::New(env, GetVirtualDiskPhysicalPathJs));
}
