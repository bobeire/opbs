#include "backup_format.h"

#include <windows.h>
#include <bcrypt.h>

#include <stdexcept>
#include <unordered_map>
#include <memory>

namespace {

struct FileHandle {
    HANDLE handle;
    bool writing;
};

std::unordered_map<uint64_t, std::shared_ptr<FileHandle>> g_openFiles;
uint64_t g_nextHandle = 1;

uint64_t WriteFileOPBS(HANDLE handle, const void* buffer, DWORD size) {
    DWORD bytesWritten = 0;
    if (!WriteFile(handle, buffer, size, &bytesWritten, nullptr)) {
        throw std::runtime_error("Failed to write to file");
    }
    return bytesWritten;
}

uint32_t ComputeCrc32(const void* data, size_t size) {
    // Simple CRC32 implementation (could be replaced with zstd's built-in)
    const unsigned char* bytes = static_cast<const unsigned char*>(data);
    uint32_t crc = 0xFFFFFFFF;
    
    for (size_t i = 0; i < size; i++) {
        crc ^= bytes[i];
        for (int j = 0; j < 8; j++) {
            crc = (crc >> 1) ^ (0xEDB88320 & (0U - (crc & 1)));
        }
    }
    
    return ~crc;
}

} // namespace

uint64_t BackupFormat::OpenForWrite(const std::string& path) {
    std::wstring widePath(path.begin(), path.end());
    
    HANDLE handle = CreateFileW(
        widePath.c_str(),
        GENERIC_WRITE,
        0,
        nullptr,
        CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        nullptr
    );
    
    if (handle == INVALID_HANDLE_VALUE) {
        throw std::runtime_error("Failed to create file: " + path);
    }
    
    auto file = std::make_shared<FileHandle>();
    file->handle = handle;
    file->writing = true;
    
    uint64_t id = g_nextHandle++;
    g_openFiles[id] = file;
    
    return id;
}

void BackupFormat::WriteHeader(uint64_t handle, const OPBSHeader& header) {
    auto it = g_openFiles.find(handle);
    if (it == g_openFiles.end()) {
        throw std::runtime_error("Invalid file handle");
    }
    
    WriteFileOPBS(it->second->handle, &header, sizeof(OPBSHeader));
}

void BackupFormat::WritePartitionEntry(uint64_t handle, const OPBSPartitionEntry& entry) {
    auto it = g_openFiles.find(handle);
    if (it == g_openFiles.end()) {
        throw std::runtime_error("Invalid file handle");
    }
    
    WriteFileOPBS(it->second->handle, &entry, sizeof(OPBSPartitionEntry));
}

uint64_t BackupFormat::WriteBlock(uint64_t handle, const OPBSBlockEntry& entry) {
    auto it = g_openFiles.find(handle);
    if (it == g_openFiles.end()) {
        throw std::runtime_error("Invalid file handle");
    }
    
    WriteFileOPBS(it->second->handle, &entry, sizeof(OPBSBlockEntry));
    
    // Get current file position for the actual data offset
    LARGE_INTEGER pos = {};
    pos.QuadPart = 0;
    SetFilePointerEx(it->second->handle, pos, &pos, FILE_CURRENT);
    
    return pos.QuadPart;
}

void BackupFormat::Close(uint64_t handle) {
    auto it = g_openFiles.find(handle);
    if (it == g_openFiles.end()) {
        return;
    }
    
    CloseHandle(it->second->handle);
    g_openFiles.erase(it);
}

int64_t BackupFormat::GetFileSize(const std::string& path) {
    std::wstring widePath(path.begin(), path.end());
    
    WIN32_FILE_ATTRIBUTE_DATA data = {};
    if (GetFileAttributesExW(widePath.c_str(), GetFileExInfoStandard, &data)) {
        LARGE_INTEGER size;
        size.QuadPart = data.nFileSizeLow | 
            ((LONGLONG)data.nFileSizeHigh << 32);
        return size.QuadPart;
    }
    
    return -1;
}
