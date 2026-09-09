#pragma once

#include <string>
#include <vector>
#include <cstdint>

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

private:
    static std::vector<PartitionInfo> EnumeratePartitionsViaVolumes(int diskIndex);
};
