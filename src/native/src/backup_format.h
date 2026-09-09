#pragma once

#include <cstdint>
#include <string>
#include <vector>

// .opbs image format constants
constexpr uint32_t OPBS_MAGIC = 0x5342504F;  // "OPBS"
constexpr uint32_t OPBS_VERSION = 1;
constexpr uint32_t OPBS_BLOCK_SIZE = 1024 * 1024;  // 1MB blocks

struct OPBSHeader {
    uint32_t magic;
    uint32_t version;
    uint64_t timestamp;
    uint64_t totalSize;
    uint32_t partitionCount;
    uint32_t compressionLevel;
    uint64_t checksum;
};

struct OPBSPartitionEntry {
    uint32_t diskIndex;
    uint32_t partitionIndex;
    uint64_t offset;
    uint64_t size;
    uint32_t blockCount;
    uint64_t blockIndexOffset;
};

struct OPBSBlockEntry {
    uint64_t offsetInImage;
    uint64_t uncompressedSize;
    uint64_t compressedSize;
    uint32_t checksum;
};

class BackupFormat {
public:
    static uint64_t OpenForWrite(const std::string& path);
    static void WriteHeader(uint64_t handle, const OPBSHeader& header);
    static void WritePartitionEntry(uint64_t handle, const OPBSPartitionEntry& entry);
    static uint64_t WriteBlock(uint64_t handle, const OPBSBlockEntry& entry);
    static void Close(uint64_t handle);
    
private:
    static int64_t GetFileSize(const std::string& path);
};
