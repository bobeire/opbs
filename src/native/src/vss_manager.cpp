#include "vss_manager.h"

#include <windows.h>
#include <vss.h>
#include <vswriter.h>
#include <vsbackup.h>

#include <stdexcept>
#include <sstream>
#include <iomanip>
#include <memory>

#ifdef _MSC_VER
#pragma comment(lib, "vssapi.lib")
#endif

namespace {

void VssError(const wchar_t* operation) {
    throw std::runtime_error("VSS operation failed during: " + 
        std::string(operation, operation + wcslen(operation)));
}

void VssErrorWithHr(const wchar_t* operation, HRESULT hr) {
    std::wstringstream ss;
    ss << L"VSS operation '" << operation << L"' failed with HRESULT 0x" 
       << std::hex << static_cast<unsigned long>(hr);
    std::wstring msg = ss.str();
    throw std::runtime_error(std::string(msg.begin(), msg.end()));
}

std::wstring GetVolumeRoot(const std::string& volumePath) {
    // Normalize path like "C:" or "C:\" to "C:\"
    std::string volume = volumePath;
    if (volume.length() == 2 && volume[1] == ':') {
        volume += "\\";
    }
    
    std::wstring result(volume.begin(), volume.end());
    
    // Ensure trailing backslash
    if (!result.empty() && result.back() != L'\\') {
        result += L'\\';
    }
    
    return result;
}

// Wait for an async VSS operation to complete
HRESULT WaitForAsync(IVssAsync* pAsync) {
    if (!pAsync) {
        return E_POINTER;
    }
    
    HRESULT hr = S_OK;
    hr = pAsync->Wait();
    
    if (hr == E_ABORT) {
        // The operation was aborted
        pAsync->Release();
        return hr;
    }
    
    if (SUCCEEDED(hr)) {
        // Query the status to ensure the operation didn't fail
        hr = pAsync->QueryStatus(NULL, NULL);
    }
    
    pAsync->Release();
    return hr;
}

} // namespace

VssSnapshotInfo VssManager::CreateSnapshot(const std::string& volumePath) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        VssErrorWithHr(L"CoInitializeEx", hr);
    }
    
    IVssBackupComponents* backupComponents = nullptr;
    hr = CreateVssBackupComponents(&backupComponents);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"CreateVssBackupComponents", hr);
    }
    
    std::unique_ptr<IVssBackupComponents, void(*)(IVssBackupComponents*)> 
        components(backupComponents, [](IVssBackupComponents* bc) {
            if (bc) bc->Release();
        });
    
    hr = components->InitializeForBackup();
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"InitializeForBackup", hr);
    }
    
    hr = components->SetBackupState(true, true, VSS_BT_FULL, false);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"SetBackupState", hr);
    }
    
    VSS_ID snapshotSetId = GUID_NULL;
    hr = components->StartSnapshotSet(&snapshotSetId);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"StartSnapshotSet", hr);
    }
    
    std::wstring volumeRoot = GetVolumeRoot(volumePath);
    VSS_PWSZ pwszVolume = const_cast<VSS_PWSZ>(volumeRoot.c_str());
    VSS_ID snapshotId = GUID_NULL;
    
    hr = components->AddToSnapshotSet(pwszVolume, GUID_NULL, &snapshotId);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"AddToSnapshotSet", hr);
    }
    
    IVssAsync* pAsync = nullptr;
    hr = components->PrepareForBackup(&pAsync);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"PrepareForBackup", hr);
    }
    
    hr = WaitForAsync(pAsync);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"PrepareForBackup wait", hr);
    }
    
    pAsync = nullptr;
    hr = components->DoSnapshotSet(&pAsync);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"DoSnapshotSet", hr);
    }
    
    hr = WaitForAsync(pAsync);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"DoSnapshotSet wait", hr);
    }
    
    // Get snapshot properties to obtain the device path
    VSS_SNAPSHOT_PROP prop = {};
    hr = components->GetSnapshotProperties(snapshotId, &prop);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"GetSnapshotProperties", hr);
    }
    
    VssSnapshotInfo info;
    
    // Convert GUID to string
    GUID guid = snapshotId;
    std::wstringstream guidStream;
    guidStream << std::uppercase << std::hex
               << std::setfill(L'0') << std::setw(8) << guid.Data1 << L'-'
               << std::setw(4) << guid.Data2 << L'-' << std::setw(4) << guid.Data3 << L'-';
    for (int i = 0; i < 8; i++) {
        guidStream << std::setw(2) << static_cast<int>(guid.Data4[i]);
        if (i == 3) {
            guidStream << L'-';
        }
    }
    
    std::wstring guidString = guidStream.str();
    info.id = std::string(guidString.begin(), guidString.end());
    
    std::wstring devicePath(prop.m_pwszSnapshotDeviceObject);
    info.devicePath = std::string(devicePath.begin(), devicePath.end());
    
    ::VssFreeSnapshotProperties(&prop);
    
    CoUninitialize();
    return info;
}

void VssManager::DeleteSnapshot(const std::string& snapshotId) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        VssErrorWithHr(L"CoInitializeEx", hr);
    }
    
    // Parse the GUID string back
    GUID guid;
    if (UuidFromStringA((RPC_CSTR)snapshotId.c_str(), &guid) != RPC_S_OK) {
        CoUninitialize();
        VssError(L"UuidFromString");
    }
    
    IVssBackupComponents* backupComponents = nullptr;
    hr = CreateVssBackupComponents(&backupComponents);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"CreateVssBackupComponents", hr);
    }
    
    std::unique_ptr<IVssBackupComponents, void(*)(IVssBackupComponents*)> 
        components(backupComponents, [](IVssBackupComponents* bc) {
            if (bc) bc->Release();
        });
    
    hr = components->InitializeForRestore(nullptr);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"InitializeForRestore", hr);
    }
    
    LONG deletedCount = 0;
    VSS_ID nonDeletedId = GUID_NULL;
    hr = components->DeleteSnapshots(guid, VSS_OBJECT_SNAPSHOT, TRUE, &deletedCount, &nonDeletedId);
    
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"DeleteSnapshots", hr);
    }
    
    CoUninitialize();
}

bool VssManager::IsSupported() {
    // VSS is always available on Windows XP and later
    return true;
}
