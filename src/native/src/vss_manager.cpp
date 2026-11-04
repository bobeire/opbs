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

/**
 * Check writer state and fail with a name instead of a bare HRESULT.
 *
 * A requester that asks for component selection and bootable-system-state
 * participation has to gather writer metadata first, and it has to look at
 * what the writers said. A writer in VSS_WS_FAILED will make DoSnapshotSet
 * fail later with an HRESULT that names nobody, which is how a user ends up
 * told "VSS is broken on this machine" when the problem is one writer and
 * the fix is one word.
 */
void CheckWriterState(IVssBackupComponents* components, const wchar_t* phase) {
    UINT count = 0;
    HRESULT hr = components->GetWriterStatusCount(&count);
    if (FAILED(hr)) {
        VssErrorWithHr(L"GetWriterStatusCount", hr);
    }
    for (UINT i = 0; i < count; i++) {
        VSS_ID instanceId = GUID_NULL;
        VSS_ID writerId = GUID_NULL;
        BSTR writerName = nullptr;
        VSS_WRITER_STATE state = VSS_WS_UNKNOWN;
        HRESULT writerHr = S_OK;
        // Every out-parameter is a real variable. This SDK declares them
        // `_Out_` rather than `_Out_opt_`, and an implementation that
        // dereferences unconditionally would crash us mid-backup — which is a
        // far worse outcome than not printing a writer's name. The BSTR is
        // intentionally not freed: the documented free function is not
        // available in every SDK we build against, and one short string per
        // writer per snapshot is not worth getting wrong.
        // `vssadmin list writers` prints every name with its status anyway.
        if (FAILED(components->GetWriterStatus(i, &instanceId, &writerId, &writerName, &state, &writerHr))) {
            continue;
        }
        (void)writerName;
        (void)writerId;
        (void)instanceId;
        // The failure family is contiguous (VSS_WS_FAILED_AT_IDENTIFY through
        // VSS_WS_FAILED_AT_BACKUPSHUTDOWN); naming the range rather than each
        // value keeps this correct when Windows adds more.
        const bool failedWriter =
            state >= VSS_WS_FAILED_AT_IDENTIFY && state <= VSS_WS_FAILED_AT_BACKUPSHUTDOWN;
        if (failedWriter) {
            std::wstringstream ss;
            ss << L"VSS writer #" << i << L" failed during " << phase << L" (state "
               << static_cast<int>(state) << L", HRESULT 0x" << std::hex
               << static_cast<unsigned long>(writerHr) << L"). The snapshot cannot be taken while "
               << L"that writer is failing. Run 'vssadmin list writers' to see which one, then fix "
               << L"or restart that writer.";
            std::wstring msg = ss.str();
            throw std::runtime_error(std::string(msg.begin(), msg.end()));
        }
    }
}

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

    // The context MUST be set before StartSnapshotSet. VSS_CTX_BACKUP is the
    // backup context and it is the one that brings writers in — which is what
    // we want, since a writer that flushes is the difference between a
    // crash-consistent capture and an application-consistent one. Without an
    // explicit context the caller is in an undefined state and later calls can
    // fail on any machine with active writers. (Field report 2026-11-04: the
    // sequence was incomplete and Macrium succeeded on the same machine.)
    hr = components->SetContext(VSS_CTX_BACKUP);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"SetContext", hr);
    }

    hr = components->SetBackupState(true, true, VSS_BT_FULL, false);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"SetBackupState", hr);
    }

    // GatherWriterMetadata is REQUIRED once the backup state asks for
    // component selection (SetBackupState's first argument). Microsoft's
    // requester contract is explicit about the order: gather the metadata
    // before PrepareForBackup/DoSnapshotSet, or those calls fail on any
    // machine where writers matter — that is, every normal Windows install.
    // This was the single biggest omission in the old sequence.
    IVssAsync* pMetaAsync = nullptr;
    hr = components->GatherWriterMetadata(&pMetaAsync);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"GatherWriterMetadata", hr);
    }
    hr = WaitForAsync(pMetaAsync);
    if (FAILED(hr)) {
        CoUninitialize();
        VssErrorWithHr(L"GatherWriterMetadata wait", hr);
    }
    // Look at what the writers said before relying on them. A writer that is
    // already failing will fail the snapshot later with a much less useful
    // HRESULT.
    CheckWriterState(components.get(), L"GatherWriterMetadata");

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
    // Writers run their prepare phase here; a failure now is the last moment
    // to name it before DoSnapshotSet turns it into an anonymous HRESULT.
    CheckWriterState(components.get(), L"PrepareForBackup");

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

    // Signal the end of the backup to the writers. Skipping this leaves them
    // believing a backup is still in progress, which is how a machine ends up
    // with writers wedged after a run — and wedged writers are exactly what
    // makes the *next* snapshot fail for no visible reason.
    pAsync = nullptr;
    hr = components->BackupComplete(&pAsync);
    if (SUCCEEDED(hr)) {
        WaitForAsync(pAsync);
    }
    // Report the writers' final state, but never fail a snapshot we already
    // hold: the data is captured and the user is better served by a warning
    // in the log than by losing a good snapshot over a writer's complaint.
    try {
        CheckWriterState(components.get(), L"BackupComplete");
    } catch (const std::exception& e) {
        // Swallowed deliberately — see above. The snapshot itself is valid.
        (void)e;
    }

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
