#include "vss_manager.h"

#include <windows.h>
#include <vss.h>
#include <vswriter.h>
#include <vsbackup.h>

#include <stdexcept>
#include <sstream>
#include <iomanip>
#include <memory>
#include <mutex>
#include <vector>
#include <unordered_map>
#include <fstream>
#include <cstdlib>

#ifdef _MSC_VER
#pragma comment(lib, "vssapi.lib")
#endif

namespace {

/**
 * Convert wide text to UTF-8. The old code used
 * `std::string(msg.begin(), msg.end())`, which narrows each wchar_t to one
 * byte. That is fine for ASCII and silently corrupts anything else; Node then
 * reports a replacement character and the real failure disappears.
 */
std::string Narrow(const std::wstring& text) {
    if (text.empty()) return {};
    const int size = WideCharToMultiByte(
        CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0) return {};
    std::string out(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(
        CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), size, nullptr, nullptr);
    return out;
}

/**
 * Opt-in trace for field debugging: set OPBS_VSS_TRACE to a file path and every
 * VSS step, HRESULT and cleanup call is appended there. Never throws, never
 * changes behaviour when unset.
 */
void VssTrace(const std::string& text) {
    const char* path = std::getenv("OPBS_VSS_TRACE");
    if (path == nullptr || *path == '\0') return;
    std::ofstream out(path, std::ios::app);
    if (!out) return;
    SYSTEMTIME st;
    GetLocalTime(&st);
    out << '[' << std::setfill('0')
        << std::setw(2) << st.wHour << ':' << std::setw(2) << st.wMinute << ':'
        << std::setw(2) << st.wSecond << '.' << std::setw(3) << st.wMilliseconds << "] "
        << text << '\n';
}

void VssTrace(const std::wstring& text) { VssTrace(Narrow(text)); }

std::string HexHr(HRESULT hr) {
    std::ostringstream ss;
    ss << "0x" << std::hex << static_cast<unsigned long>(hr);
    return ss.str();
}

void VssError(const wchar_t* operation) {
    std::wstring msg = L"VSS operation failed during: " + std::wstring(operation);
    VssTrace(msg);
    throw std::runtime_error(Narrow(msg));
}

void VssErrorWithHr(const wchar_t* operation, HRESULT hr) {
    std::wstringstream ss;
    ss << L"VSS operation '" << operation << L"' failed with HRESULT 0x" 
       << std::hex << static_cast<unsigned long>(hr);
    std::wstring msg = ss.str();
    VssTrace(msg);
    throw std::runtime_error(Narrow(msg));
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

/**
 * Joins the COM multithreaded apartment, once per thread.
 *
 * COM is per-thread, and uninitializing a thread that still holds a live VSS
 * object is undefined behaviour. Every failure path used to call
 * CoUninitialize() *before* releasing the components object — the same class of
 * ordering mistake that abandoned snapshot sets. The addon lives as long as
 * the process, so the apartment is left joined rather than torn down under a
 * snapshot that is still in use.
 */
void EnsureComInitialized() {
    constexpr HRESULT kNotYet = 0x7FFFFFFF; // never returned by CoInitializeEx
    thread_local HRESULT initHr = kNotYet;
    if (initHr == kNotYet) {
        initHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    }
    // RPC_E_CHANGED_MODE means the host already initialized COM in another
    // apartment. We did not add a reference, so this is not an error — and it
    // must never be balanced with CoUninitialize.
    if (FAILED(initHr) && initHr != RPC_E_CHANGED_MODE) {
        HRESULT failure = initHr;
        // Do not cache a transient failure: the next call should retry rather
        // than proceed with COM uninitialized.
        initHr = kNotYet;
        VssErrorWithHr(L"CoInitializeEx", failure);
    }
}

/**
 * A shadow copy only survives while the object that created it survives.
 *
 * This is the whole reason snapshots never worked. VSS_CTX_BACKUP creates a
 * NON-PERSISTENT shadow copy, and the DeleteSnapshots documentation is explicit:
 * "During a backup, shadow copies are automatically released as soon as the
 * IVssBackupComponents instance is released."
 *
 * The old code created the snapshot, returned its device path, and let the
 * IVssBackupComponents object die at the end of that call. The device object
 * lingered in the namespace, so CreateFile succeeded — but the shadow copy
 * behind it was gone, and ReadFile returned ERROR_NOT_READY (21). Every OPBS
 * backup then fell back to reading the live disk, which is exactly the silent
 * inconsistency this project has been chasing.
 *
 * Keeping the requester object alive for as long as the snapshot is in use is
 * what other requesters do (wimlib keeps IVssBackupComponents in its snapshot
 * handle for the same reason). DeleteSnapshot releases it, which also releases
 * the shadow copy.
 */
struct LiveSnapshot {
    std::shared_ptr<IVssBackupComponents> components;
    VSS_ID snapshotId{ GUID_NULL };
};

std::mutex g_liveSnapshotsMutex;
std::unordered_map<std::string, LiveSnapshot> g_liveSnapshots;

/**
 * Guarantees a snapshot set is never left unusable after a failure.
 *
 * There is no AbortSnapshotSet in the VSS API, and the two documents that
 * describe the cleanup only look contradictory until you separate "notify the
 * writers" from "destroy the shadow copies":
 *
 *   - AbortBackup's reference page says it "must be called if a backup
 *     operation terminates after the creation of a shadow copy set with
 *     StartSnapshotSet and before DoSnapshotSet returns", and that it is
 *     ignored when nothing is underway.
 *   - "Aborting VSS Operations" says a requester only needs to generate the
 *     Abort event after PrepareForBackup, and may simply release the object
 *     if PrepareForBackup was never reached or failed.
 *
 * So: call AbortBackup whenever a started set will not be committed (cheap,
 * safe, and it is the only way to unwedge writers after PrepareForBackup), and
 * *also* delete the set explicitly. Releasing the requester is not immediate
 * enough to be a cleanup strategy on its own — the 2026-11-05 field report had
 * AddToSnapshotSet fail with 0x8004230c, the set survive, and the next attempt
 * 66 seconds later fail at StartSnapshotSet with 0x80042316, while Macrium had
 * not started yet (its log begins at 09:06:31).
 *
 * This guard exists because the shipped code called CoUninitialize() *inside*
 * each failure branch, before the components object was released. Tearing down
 * the COM apartment while a live VSS requester object still holds an in-progress
 * snapshot set is undefined behaviour, and it left the set behind: the retry
 * then failed with VSS_E_SNAPSHOT_SET_IN_PROGRESS (0x80042316). One FAT32
 * volume turned into "VSS is busy" on every subsequent attempt.
 * (Field report 2026-11-04.)
 */
class SnapshotSetGuard {
public:
    SnapshotSetGuard(IVssBackupComponents* components, VSS_ID snapshotSetId)
        : components_(components), snapshotSetId_(snapshotSetId) {}

    // PrepareForBackup succeeded: from now on, a failure definitely owes the
    // writers an AbortBackup.
    void Prepared() { prepared_ = true; }

    // DoSnapshotSet succeeded: cleanup now means deleting the snapshots.
    void Committed(const std::vector<VSS_ID>& snapshotIds) {
        committed_ = true;
        snapshotIds_ = snapshotIds;
    }

    void Disarm() { armed_ = false; }

    ~SnapshotSetGuard() {
        // Never let cleanup throw: this runs during unwinding, where a second
        // exception terminates the process.
        if (!armed_ || components_ == nullptr) return;

        VssTrace(std::string("guard cleanup: prepared=") + (prepared_ ? "1" : "0") +
                 " committed=" + (committed_ ? "1" : "0"));

        if (!committed_) {
            // Tell VSS and the writers this backup is over. Ignored if nothing
            // is underway; required once PrepareForBackup has run, and the
            // documented requirement after StartSnapshotSet.
            HRESULT abortHr = components_->AbortBackup(); // best effort; writers come first
            VssTrace("guard AbortBackup hr=" + HexHr(abortHr));
        }

        if (!prepared_ && !committed_) {
            // The set was started but never prepared. Delete it explicitly as
            // well: AbortBackup does not guarantee the set is gone before the
            // requester object is released, and a set that lingers blocks the
            // next attempt with VSS_E_SNAPSHOT_SET_IN_PROGRESS.
            LONG deleted = 0;
            VSS_ID notDeleted = GUID_NULL;
            HRESULT deleteHr = components_->DeleteSnapshots(
                snapshotSetId_, VSS_OBJECT_SNAPSHOT_SET, TRUE, &deleted, &notDeleted);
            VssTrace("guard DeleteSnapshots(set) hr=" + HexHr(deleteHr) +
                     " deleted=" + std::to_string(deleted));
            return;
        }

        if (prepared_ || committed_) {
            // Any snapshot that was actually committed must go, whether or not
            // we got as far as collecting its properties.
            for (const VSS_ID& id : snapshotIds_) {
                if (id == GUID_NULL) continue;
                LONG deleted = 0;
                VSS_ID notDeleted = GUID_NULL;
                HRESULT deleteHr = components_->DeleteSnapshots(
                    id, VSS_OBJECT_SNAPSHOT, TRUE, &deleted, &notDeleted);
                VssTrace("guard DeleteSnapshots(committed) hr=" + HexHr(deleteHr) +
                         " deleted=" + std::to_string(deleted));
            }
        }
    }

    SnapshotSetGuard(const SnapshotSetGuard&) = delete;
    SnapshotSetGuard& operator=(const SnapshotSetGuard&) = delete;

private:
    IVssBackupComponents* components_;
    VSS_ID snapshotSetId_ = GUID_NULL;
    std::vector<VSS_ID> snapshotIds_;
    bool prepared_ = false;
    bool committed_ = false;
    bool armed_ = true;
};

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
            VssTrace(msg);
            throw std::runtime_error(Narrow(msg));
        }
    }
}

std::vector<VssSnapshotInfo> VssManager::CreateSnapshotSet(const std::vector<std::string>& volumePaths) {
    if (volumePaths.empty()) {
        VssError(L"CreateSnapshotSet (no volumes)");
    }
    EnsureComInitialized();

    IVssBackupComponents* backupComponents = nullptr;
    HRESULT hr = CreateVssBackupComponents(&backupComponents);
    if (FAILED(hr)) {
        VssErrorWithHr(L"CreateVssBackupComponents", hr);
    }
    
    // Shared, because the object must outlive this call: releasing it releases
    // the shadow copy (see LiveSnapshot).
    std::shared_ptr<IVssBackupComponents> components(
        backupComponents, [](IVssBackupComponents* bc) {
            if (bc) bc->Release();
        });
    
    hr = components->InitializeForBackup();
    if (FAILED(hr)) {
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
        VssErrorWithHr(L"SetContext", hr);
    }

    hr = components->SetBackupState(true, true, VSS_BT_FULL, false);
    if (FAILED(hr)) {
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
        VssErrorWithHr(L"GatherWriterMetadata", hr);
    }
    hr = WaitForAsync(pMetaAsync);
    if (FAILED(hr)) {
        VssErrorWithHr(L"GatherWriterMetadata wait", hr);
    }
    // Look at what the writers said before relying on them. A writer that is
    // already failing will fail the snapshot later with a much less useful
    // HRESULT.
    CheckWriterState(components.get(), L"GatherWriterMetadata");

    VSS_ID snapshotSetId = GUID_NULL;
    hr = components->StartSnapshotSet(&snapshotSetId);
    VssTrace("StartSnapshotSet hr=" + HexHr(hr));
    if (FAILED(hr)) {
        VssErrorWithHr(L"StartSnapshotSet", hr);
    }
    // From here on, a failure owes cleanup — see SnapshotSetGuard.
    SnapshotSetGuard setGuard(components.get(), snapshotSetId);
    
    // Every volume goes into the SAME snapshot set, so DoSnapshotSet freezes
    // them at one instant. Separate sets meant a multi-partition backup
    // captured each partition at a different moment. (Field report 2026-11-04.)
    std::vector<VSS_ID> snapshotIds(volumePaths.size(), GUID_NULL);
    for (size_t v = 0; v < volumePaths.size(); v++) {
        std::wstring volumeRoot = GetVolumeRoot(volumePaths[v]);
        VSS_PWSZ pwszVolume = const_cast<VSS_PWSZ>(volumeRoot.c_str());
        hr = components->AddToSnapshotSet(pwszVolume, GUID_NULL, &snapshotIds[v]);
        VssTrace("AddToSnapshotSet " + Narrow(volumeRoot) + " hr=" + HexHr(hr));
        if (FAILED(hr)) {
            VssErrorWithHr(L"AddToSnapshotSet", hr);
        }
    }
    
    IVssAsync* pAsync = nullptr;
    hr = components->PrepareForBackup(&pAsync);
    VssTrace("PrepareForBackup hr=" + HexHr(hr));
    if (FAILED(hr)) {
        VssErrorWithHr(L"PrepareForBackup", hr);
    }
    // Writers have been told to prepare. From here on, any failure — including
    // the async wait — must tell them to abort, or they sit in a prepared
    // state and the next snapshot fails for no visible reason.
    setGuard.Prepared();
    
    hr = WaitForAsync(pAsync);
    VssTrace("PrepareForBackup wait hr=" + HexHr(hr));
    if (FAILED(hr)) {
        VssErrorWithHr(L"PrepareForBackup wait", hr);
    }
    // Writers run their prepare phase here; a failure now is the last moment
    // to name it before DoSnapshotSet turns it into an anonymous HRESULT.
    CheckWriterState(components.get(), L"PrepareForBackup");

    pAsync = nullptr;
    hr = components->DoSnapshotSet(&pAsync);
    VssTrace("DoSnapshotSet hr=" + HexHr(hr));
    if (FAILED(hr)) {
        VssErrorWithHr(L"DoSnapshotSet", hr);
    }
    
    hr = WaitForAsync(pAsync);
    VssTrace("DoSnapshotSet wait hr=" + HexHr(hr));
    if (FAILED(hr)) {
        VssErrorWithHr(L"DoSnapshotSet wait", hr);
    }

    // The set is committed. If anything below fails, cleanup means deleting
    // the snapshots rather than aborting a set that no longer exists.
    setGuard.Committed(snapshotIds);
    
    // Collect the device path for every volume in the set.
    std::vector<VssSnapshotInfo> infos;
    infos.reserve(snapshotIds.size());
    for (size_t v = 0; v < snapshotIds.size(); v++) {
        VSS_SNAPSHOT_PROP prop = {};
        hr = components->GetSnapshotProperties(snapshotIds[v], &prop);
        if (FAILED(hr)) {
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

    // Keep the requester object alive for as long as the snapshots are in use.
    // Releasing it releases the shadow copies, so this must happen before the
    // function returns and the local shared_ptr goes out of scope. DeleteSnapshot
    // consumes the entry and drops the last reference once the data is read.
    {
        std::lock_guard<std::mutex> lock(g_liveSnapshotsMutex);
        for (size_t v = 0; v < infos.size(); v++) {
            if (infos[v].id.empty() || snapshotIds[v] == GUID_NULL) continue;
            g_liveSnapshots[infos[v].id] = LiveSnapshot{ components, snapshotIds[v] };
        }
    }

    setGuard.Disarm();
    return infos;
}

VssSnapshotInfo VssManager::CreateSnapshot(const std::string& volumePath) {
    std::vector<VssSnapshotInfo> infos = CreateSnapshotSet({ volumePath });
    return infos.at(0);
}

void VssManager::DeleteSnapshot(const std::string& snapshotId) {
    EnsureComInitialized();

    // Normal path: this process created the snapshot, so the requester object
    // that keeps it alive is still in the registry. Deleting through it both
    // removes the shadow copy and lets the last reference go, which is what
    // releases it for good.
    LiveSnapshot live;
    bool found = false;
    {
        std::lock_guard<std::mutex> lock(g_liveSnapshotsMutex);
        auto it = g_liveSnapshots.find(snapshotId);
        if (it != g_liveSnapshots.end()) {
            live = it->second;
            g_liveSnapshots.erase(it);
            found = true;
        }
    }
    if (found) {
        LONG deletedCount = 0;
        VSS_ID nonDeletedId = GUID_NULL;
        HRESULT deleteHr = live.components->DeleteSnapshots(
            live.snapshotId, VSS_OBJECT_SNAPSHOT, TRUE, &deletedCount, &nonDeletedId);
        if (FAILED(deleteHr)) {
            VssErrorWithHr(L"DeleteSnapshots", deleteHr);
        }
        return; // `live` drops the reference and releases the requester here
    }

    // Unknown id — a snapshot created by an older native build, or by another
    // process. There is no live requester to route through, so use a fresh one
    // in restore mode, which can delete a persistent snapshot by id.
    // Parse the GUID string back
    GUID guid;
    if (UuidFromStringA((RPC_CSTR)snapshotId.c_str(), &guid) != RPC_S_OK) {
        VssError(L"UuidFromString");
    }
    
    IVssBackupComponents* backupComponents = nullptr;
    HRESULT hr = CreateVssBackupComponents(&backupComponents);
    if (FAILED(hr)) {
        VssErrorWithHr(L"CreateVssBackupComponents", hr);
    }
    
    std::unique_ptr<IVssBackupComponents, void(*)(IVssBackupComponents*)> 
        components(backupComponents, [](IVssBackupComponents* bc) {
            if (bc) bc->Release();
        });
    
    hr = components->InitializeForRestore(nullptr);
    if (FAILED(hr)) {
        VssErrorWithHr(L"InitializeForRestore", hr);
    }
    
    LONG deletedCount = 0;
    VSS_ID nonDeletedId = GUID_NULL;
    hr = components->DeleteSnapshots(guid, VSS_OBJECT_SNAPSHOT, TRUE, &deletedCount, &nonDeletedId);
    
    if (FAILED(hr)) {
        VssErrorWithHr(L"DeleteSnapshots", hr);
    }
}

bool VssManager::IsSupported() {
    // VSS is always available on Windows XP and later
    return true;
}
