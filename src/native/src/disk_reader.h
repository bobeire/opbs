#pragma once

#include <string>
#include <vector>
#include <cstdint>
#include <unordered_map>

#ifdef _WIN32
#include <windows.h>
#endif

struct DiskInfo {
    int index;
    std::string model;
    uint64_t size;
    std::string serial;
};

struct PartitionInfo {
    int diskIndex;
    int partitionIndex;
    uint64_t offset;
    uint64_t size;
    uint8_t type;
};

struct UsnRecord {
    uint64_t usn;
    uint64_t fileReference;
    uint32_t reason;
    std::string fileName;
};

struct UsnJournalInfo {
    uint64_t firstUsn;
    uint64_t nextUsn;
    uint64_t lowestValidUsn;
};

class DiskReader {
public:
    static std::vector<DiskInfo> EnumerateDisks();
    static std::vector<PartitionInfo> EnumeratePartitions(int diskIndex);
    static std::string GetPhysicalDrivePath(int diskIndex);
    static std::vector<char> ReadBlocks(const std::string& devicePath, uint64_t offset, uint64_t length);
    static uint64_t WriteBlocks(const std::string& devicePath, uint64_t offset, const char* data, size_t length);
    static std::string GetVolumePathForOffset(int diskIndex, uint64_t partitionOffset);
    static std::vector<UsnRecord> QueryUsnJournal(const std::string& volumePath, uint64_t startUsn);
    static UsnJournalInfo GetUsnJournalInfo(const std::string& volumePath);
    static uint32_t Crc32(const uint8_t* data, size_t length, uint32_t seed = 0);

    // Lock + dismount a mounted volume and hold the lock handle so raw
    // physical-drive writes are not racing the filesystem cache.
    static bool LockAndDismountVolume(const std::string& volumePath);
    // Unlock/close every volume held by LockAndDismountVolume.
    static void ReleaseLockedVolumes();
    // Ask Windows to re-read the partition table after a raw restore.
    static bool UpdateDiskProperties(const std::string& devicePath);

    // Close all cached device handles. Call before process exit.
    static void CloseAllHandles();

private:
    static std::vector<PartitionInfo> EnumeratePartitionsViaVolumes(int diskIndex);

#ifdef _WIN32
    // Cached device handles keyed by device path. Avoids repeated
    // CreateFileW/CloseHandle per 1MB block during backup/restore.
    static HANDLE GetCachedHandle(const std::string& devicePath, DWORD access);
    static std::unordered_map<std::string, HANDLE> s_handleCache;
    static std::vector<HANDLE> s_lockedVolumes;
#endif
};
