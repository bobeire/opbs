#pragma once

#include <string>
#include <vector>

struct VssSnapshotInfo {
    std::string id;
    std::string devicePath;
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
     */
    static std::vector<VssSnapshotInfo> CreateSnapshotSet(const std::vector<std::string>& volumePaths);

    /** One volume. Thin wrapper over CreateSnapshotSet. */
    static VssSnapshotInfo CreateSnapshot(const std::string& volumePath);
    static void DeleteSnapshot(const std::string& snapshotId);
    static bool IsSupported();
};
