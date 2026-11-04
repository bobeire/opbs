#include "vss_manager.h"

#include <windows.h>
#include <vss.h>
#include <vswriter.h>
#include <vsbackup.h>

#include <stdexcept>
#include <sstream>
#include <iomanip>
#include <memory>
#include <vector>

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

// Wait for an async VSS operation to complete.
//
// Two things the previous version got wrong:
//   - `Wait()` defaults to INFINITE, so a hung VSS service stalled the helper
//     at "snapshotting" with no watchdog at all.
//   - `QueryStatus(NULL, NULL)` threw the operation's status away. Wait can
//     return S_OK while the underlying operation failed, so the result has to
//     be captured — the comment said "to ensure the operation didn't fail" and
//     the code could not have told.
HRESULT WaitForAsync(IVssAsync* pAsync, DWORD timeoutMs = 120000) {
    if (!pAsync) {
        return E_POINTER;
    }

    HRESULT hr = pAsync->Wait(timeoutMs);
    if (hr == E_ABORT) {
        pAsync->Release();
        return hr;
    }
    if (hr == HRESULT_FROM_WIN32(ERROR_TIMEOUT) || hr == WAIT_TIMEOUT) {
        // Leave the operation to finish or abort on its own, but never hang.
        pAsync->Release();
        return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    }

    if (SUCCEEDED(hr)) {
        // Capture the operation's own status: Wait succeeding is not the same
        // as the operation succeeding.
        HRESULT operationHr = S_OK;
        hr = pAsync->QueryStatus(&operationHr, NULL);
        if (SUCCEEDED(hr)) {
            hr = operationHr;
        }
    }

    pAsync->Release();
    return hr;
}

} // namespace

/**
 * Check writer state and report a name instead of a bare HRESULT.
 *
 * Two rules, both learned the hard way on 2026-11-04:
 *
 *   - Writer status is not available until `GatherWriterStatus` has run.
 *     Querying it earlier fails with VSS_E_BAD_STATE (0x80042301), and this
 *     check was doing exactly that — refusing every backup on the first
 *     machine that ran it.
 *   - A check must never break the thing it is checking. Any failure of the
 *     check itself means "no verdict" and is swallowed: an aborted backup is
 *     far worse than a missing warning.
 *
 * A writer that is genuinely in a failed state is still reported as an error,
 * because DoSnapshotSet would fail anyway and this names the culprit.
 */
void CheckWriterState(IVssBackupComponents* components, const wchar_t* phase) {
    // Gather the status first. Without this, GetWriterStatusCount returns
    // VSS_E_BAD_STATE and nothing below can run.
    IVssAsync* pStatusAsync = nullptr;
    HRESULT gatherHr = components->GatherWriterStatus(&pStatusAsync);
    if (FAILED(gatherHr)) {
        return; // no verdict — never a failure of the snapshot itself
    }
    if (pStatusAsync) {
        WaitForAsync(pStatusAsync); // releases the async
        pStatusAsync = nullptr;
    }

    UINT count = 0;
    if (FAILED(components->GetWriterStatusCount(&count))) {
        return; // no verdict
    }
    for (UINT i = 0; i < count; i++) {
        VSS_ID instanceId = GUID_NULL;
        VSS_ID writerId = GUID_NULL;
        BSTR writerName = nullptr;
        VSS_WRITER_STATE state = VSS_WS_UNKNOWN;
        HRESULT writerHr = S_OK;
        // Every out-parameter is a real variable. This SDK declares them
        // `_Out_` rather than `_Out_opt_`, and an implementation that
        // dereferences unconditionally would crash us mid-backup. The BSTR is
        // intentionally not freed: the documented free function is not
        // available in every SDK we build against, and one short string per
        // writer per snapshot is not worth getting wrong.
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

std::vector<VssSnapshotInfo> VssManager::CreateSnapshotSet(const std::vector<std::string>& volumePaths) {
    if (volumePaths.empty()) {
        VssError(L"CreateSnapshotSet (no volumes)");
    }
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
    
    // Every volume goes into the SAME snapshot set, so DoSnapshotSet freezes
    // them at one instant. Separate sets meant a multi-partition backup
    // captured each partition at a different moment. (Field report 2026-11-04.)
    std::vector<VSS_ID> snapshotIds(volumePaths.size(), GUID_NULL);
    for (size_t v = 0; v < volumePaths.size(); v++) {
        std::wstring volumeRoot = GetVolumeRoot(volumePaths[v]);
        VSS_PWSZ pwszVolume = const_cast<VSS_PWSZ>(volumeRoot.c_str());
        hr = components->AddToSnapshotSet(pwszVolume, GUID_NULL, &snapshotIds[v]);
        if (FAILED(hr)) {
            CoUninitialize();
            VssErrorWithHr(L"AddToSnapshotSet", hr);
        }
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
    
    // Collect the device path for every volume in the set.
    std::vector<VssSnapshotInfo> infos;
    infos.reserve(snapshotIds.size());
    for (size_t v = 0; v < snapshotIds.size(); v++) {
        VSS_SNAPSHOT_PROP prop = {};
        hr = components->GetSnapshotProperties(snapshotIds[v], &prop);
        if (FAILED(hr)) {
            CoUninitialize();
            VssErrorWithHr(L"GetSnapshotProperties", hr);
        }

        VssSnapshotInfo info;

        // Convert GUID to string
        GUID guid = snapshotIds[v];
        std::wstringstream guidStream;
        guidStream << std::uppercase << std::hex
                   << std::setfill(L'0') << std::setw(8) << guid.Data1 << L'-'
                   << std::setw(4) << guid.Data2 << L'-' << std::setw(4) << guid.Data3 << L'-';
        // GUID string form: 8-4-4-4-12, so the second dash comes after TWO
        // bytes of Data4 (4 hex digits), not four. The old code put it after
        // four and produced e.g. 6588A26E-59BA-47E6-B98778A8-346652A5, which
        // UuidFromStringA rejects — so the snapshot could be created but never
        // deleted. (Field report 2026-11-04.)
        for (int i = 0; i < 8; i++) {
            guidStream << std::setw(2) << static_cast<int>(guid.Data4[i]);
            if (i == 1) {
                guidStream << L'-';
            }
        }

        std::wstring guidString = guidStream.str();
        info.id = std::string(guidString.begin(), guidString.end());

        std::wstring devicePath(prop.m_pwszSnapshotDeviceObject);
        info.devicePath = std::string(devicePath.begin(), devicePath.end());

        ::VssFreeSnapshotProperties(&prop);
        infos.push_back(info);
    }

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
    return infos;
}

VssSnapshotInfo VssManager::CreateSnapshot(const std::string& volumePath) {
    std::vector<VssSnapshotInfo> infos = CreateSnapshotSet({ volumePath });
    return infos.at(0);
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
