#pragma once

#include <string>

struct VssSnapshotInfo {
    std::string id;
    std::string devicePath;
};

class VssManager {
public:
    static VssSnapshotInfo CreateSnapshot(const std::string& volumePath);
    static void DeleteSnapshot(const std::string& snapshotId);
    static bool IsSupported();
};
