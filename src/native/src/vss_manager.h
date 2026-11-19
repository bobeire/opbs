#pragma once

#include <string>
#include <vector>

struct VssSnapshotInfo {
    std::string id;
    std::string devicePath;
};

/** Options for CreateSnapshotSet / CreateSnapshot. */
struct SnapshotOptions {
    /**
     * true  (default): application-consistent — GatherWriterMetadata + writers.
     * false: crash-consistent volume snapshot — skip writer metadata/prepare
     *        path. Much faster; databases may need recovery on restore.
     */
    bool applicationConsistent = true;

    /**
     * When applicationConsistent is false, request VSS_CTX_FILE_SHARE_BACKUP
     * instead of VSS_CTX_BACKUP for snapshot-set creation. Experimental/opt-in;
     * behavior and support vary by system/writers. Ignored for
     * application-consistent snapshots.
     */
    bool crashUseFileShareContext = false;
};

class VssManager {
public:
    /**
     * Snapshot several volumes as ONE snapshot set, so they share a single
     * point in time.
     *
     * Per-volume snapshot sets meant a multi-partition backup captured each
     * partition at a different moment — no consistent instant across them.
     * For data spanning volumes that is a real inconsistency, and for the
     * rest it is at least a lie about what the image is. (Field report
     * 2026-11-04.)
     *
     * When options.applicationConsistent is false, writers are not engaged (no
     * GatherWriterMetadata/PrepareForBackup/BackupComplete/writer status
     * checks). This is faster and avoids writer stalls, but the snapshot is
     * crash-consistent rather than application-consistent.
     */
    static std::vector<VssSnapshotInfo> CreateSnapshotSet(
        const std::vector<std::string>& volumePaths,
        const SnapshotOptions& options = {}
    );

    /** One volume. Thin wrapper over CreateSnapshotSet. */
    static VssSnapshotInfo CreateSnapshot(
        const std::string& volumePath,
        const SnapshotOptions& options = {}
    );

    static void DeleteSnapshot(const std::string& snapshotId);
    static bool IsSupported();
};
