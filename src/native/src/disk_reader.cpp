#include "disk_reader.h"

#include <windows.h>
#include <winioctl.h>
#include <setupapi.h>
#include <cfgmgr32.h>
#include <devguid.h>

#include <stdexcept>
#include <sstream>
#include <cstring>

// Format a Windows error code into a human-readable string.
static std::string FormatWinError(DWORD code) {
    char buf[512] = {};
    DWORD len = FormatMessageA(
        FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        buf, sizeof(buf), nullptr);
    // Trim trailing whitespace (FormatMessage appends \r\n).
    while (len > 0 && (buf[len - 1] == '\r' || buf[len - 1] == '\n' || buf[len - 1] == ' ')) {
        buf[--len] = '\0';
    }
    std::ostringstream ss;
    ss << buf << " (error " << code << " / 0x" << std::hex << code << ")";
    return ss.str();
}

// Static handle cache — avoids repeated CreateFileW/CloseHandle per 1MB block.
std::unordered_map<std::string, HANDLE> DiskReader::s_handleCache;

HANDLE DiskReader::GetCachedHandle(const std::string& devicePath, DWORD access) {
    // Return cached handle if it exists and has compatible access.
    auto it = s_handleCache.find(devicePath);
    if (it != s_handleCache.end() && it->second != INVALID_HANDLE_VALUE) {
        return it->second;
    }

    // Open with sequential-scan hint for backup/restore read-ahead optimization.
    // FILE_FLAG_SEQUENTIAL_SCAN tells Windows to aggressively prefetch forward.
    HANDLE hDevice = CreateFileW(
        std::wstring(devicePath.begin(), devicePath.end()).c_str(),
        access,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_SEQUENTIAL_SCAN,
        nullptr
    );

    if (hDevice == INVALID_HANDLE_VALUE) {
        throw std::runtime_error("Failed to open device " + devicePath + ": " + FormatWinError(GetLastError()));
    }

    s_handleCache[devicePath] = hDevice;
    return hDevice;
}

void DiskReader::CloseAllHandles() {
    for (auto& [path, handle] : s_handleCache) {
        if (handle != INVALID_HANDLE_VALUE) {
            CloseHandle(handle);
            handle = INVALID_HANDLE_VALUE;
        }
    }
    s_handleCache.clear();
}

std::vector<DiskInfo> DiskReader::EnumerateDisks() {
    std::vector<DiskInfo> disks;
    
    HDEVINFO deviceInfoSet = SetupDiGetClassDevsW(
        &GUID_DEVCLASS_DISKDRIVE,
        nullptr,
        nullptr,
        DIGCF_PRESENT
    );
    
    if (deviceInfoSet == INVALID_HANDLE_VALUE) {
        return disks;
    }
    
    DWORD deviceIndex = 0;
    while (true) {
        SP_DEVINFO_DATA deviceInfoData = {};
        deviceInfoData.cbSize = sizeof(SP_DEVINFO_DATA);
        
        if (!SetupDiEnumDeviceInfo(deviceInfoSet, deviceIndex, &deviceInfoData)) {
            break;
        }
        
        WCHAR buffer[512];
        DWORD bufferSize = 0;
        
        // Get device description
        if (SetupDiGetDeviceRegistryPropertyW(
            deviceInfoSet,
            &deviceInfoData,
            SPDRP_FRIENDLYNAME,
            nullptr,
            (PBYTE)buffer,
            sizeof(buffer),
            &bufferSize
        )) {
            DiskInfo disk;
            disk.index = static_cast<int>(deviceIndex);
            disk.model = std::string(buffer, buffer + wcslen(buffer));
            
            // Extract the actual disk number from the device instance ID
            WCHAR instanceId[512];
            if (SetupDiGetDeviceInstanceIdW(
                deviceInfoSet,
                &deviceInfoData,
                instanceId,
                sizeof(instanceId) / sizeof(WCHAR),
                &bufferSize
            )) {
                // Parse the instance ID for the disk number
                std::wstring instId(instanceId);
                size_t pos = instId.find(L"Disk");
                if (pos != std::wstring::npos) {
                    size_t numStart = pos + 4;  // Skip "Disk"
                    std::wstring numStr;
                    while (numStart < instId.length() && iswdigit(instId[numStart])) {
                        numStr += instId[numStart];
                        numStart++;
                    }
                    if (!numStr.empty()) {
                        disk.index = static_cast<int>(std::stoi(numStr));
                    }
                }
            }
            
            // Try to open the drive to get size
            std::string path = GetPhysicalDrivePath(disk.index);
            if (!path.empty()) {
                HANDLE hDrive = CreateFileW(
                    std::wstring(path.begin(), path.end()).c_str(),
                    FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    nullptr,
                    OPEN_EXISTING,
                    0,
                    nullptr
                );
                
                if (hDrive != INVALID_HANDLE_VALUE) {
                    DISK_GEOMETRY_EX geometry = {};
                    DWORD bytesReturned = 0;
                    
                    if (DeviceIoControl(
                        hDrive,
                        IOCTL_DISK_GET_DRIVE_GEOMETRY_EX,
                        nullptr,
                        0,
                        &geometry,
                        sizeof(geometry),
                        &bytesReturned,
                        nullptr
                    )) {
                        disk.size = geometry.DiskSize.QuadPart;
                    }
                    
                    // Get serial number
                    STORAGE_PROPERTY_QUERY query = {};
                    query.PropertyId = StorageDeviceProperty;
                    query.QueryType = PropertyStandardQuery;
                    
                    STORAGE_DEVICE_DESCRIPTOR descriptor = {};
                    BYTE descriptorBuffer[4096];
                    
                    if (DeviceIoControl(
                        hDrive,
                        IOCTL_STORAGE_QUERY_PROPERTY,
                        &query,
                        sizeof(query),
                        descriptorBuffer,
                        sizeof(descriptorBuffer),
                        &bytesReturned,
                        nullptr
                    )) {
                        STORAGE_DEVICE_DESCRIPTOR* desc = (STORAGE_DEVICE_DESCRIPTOR*)descriptorBuffer;
                        if (desc->SerialNumberOffset > 0) {
                            const char* serial = (const char*)desc + desc->SerialNumberOffset;
                            disk.serial = std::string(serial);
                        }
                    }
                    
                    CloseHandle(hDrive);
                }
            }
            
            disks.push_back(disk);
        }
        
        deviceIndex++;
    }
    
    SetupDiDestroyDeviceInfoList(deviceInfoSet);
    return disks;
}

std::vector<PartitionInfo> DiskReader::EnumeratePartitions(int diskIndex) {
    std::vector<PartitionInfo> partitions;
    
    // Open the physical drive with attributes-only access (works without elevation)
    std::string path = GetPhysicalDrivePath(diskIndex);
    
    HANDLE hDrive = CreateFileW(
        std::wstring(path.begin(), path.end()).c_str(),
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr,
        OPEN_EXISTING,
        0,
        nullptr
    );
    
    if (hDrive != INVALID_HANDLE_VALUE) {
        // Try IOCTL_DISK_GET_DRIVE_LAYOUT_EX - may work without raw read permission
        STORAGE_PROPERTY_QUERY query = {};
        query.PropertyId = StorageDeviceProperty;
        query.QueryType = PropertyStandardQuery;
        
        BYTE layoutBuffer[sizeof(DRIVE_LAYOUT_INFORMATION_EX) + 4 * sizeof(PARTITION_INFORMATION_EX)];
        DWORD bytesReturned = 0;
        
        if (DeviceIoControl(
            hDrive,
            IOCTL_DISK_GET_DRIVE_LAYOUT_EX,
            nullptr,
            0,
            layoutBuffer,
            sizeof(layoutBuffer),
            &bytesReturned,
            nullptr
        )) {
            DRIVE_LAYOUT_INFORMATION_EX* layout = (DRIVE_LAYOUT_INFORMATION_EX*)layoutBuffer;
            
            if (layout->PartitionStyle == PARTITION_STYLE_GPT) {
                // GPT layout
                for (DWORD i = 0; i < layout->PartitionCount && i < 128; i++) {
                    PARTITION_INFORMATION_EX* part = &layout->PartitionEntry[i];
                    
                    PartitionInfo partition;
                    partition.diskIndex = diskIndex;
                    partition.partitionIndex = static_cast<int>(part->PartitionNumber - 1);
                    partition.offset = part->StartingOffset.QuadPart;
                    partition.size = part->PartitionLength.QuadPart;
                    partition.type = 0xEE;  // GPT marker
                    partitions.push_back(partition);
                }
            } else if (layout->PartitionStyle == PARTITION_STYLE_MBR) {
                // MBR layout
                for (DWORD i = 0; i < layout->PartitionCount && i < 4; i++) {
                    PARTITION_INFORMATION_EX* part = &layout->PartitionEntry[i];
                    
                    PartitionInfo partition;
                    partition.diskIndex = diskIndex;
                    partition.partitionIndex = static_cast<int>(part->PartitionNumber - 1);
                    partition.offset = part->StartingOffset.QuadPart;
                    partition.size = part->PartitionLength.QuadPart;
                    partition.type = part->Mbr.PartitionType;
                    partitions.push_back(partition);
                }
            }
        }
        
        CloseHandle(hDrive);
    }
    
    // If IOCTL failed (no permission), fall back to volume-based enumeration
    if (partitions.empty()) {
        partitions = EnumeratePartitionsViaVolumes(diskIndex);
    }
    
    return partitions;
}

std::vector<PartitionInfo> DiskReader::EnumeratePartitionsViaVolumes(int diskIndex) {
    std::vector<PartitionInfo> partitions;
    
    // Enumerate all volumes (Volume{GUID} device paths)
    WCHAR szVolumePath[MAX_PATH];
    HANDLE findHandle = FindFirstVolumeW(szVolumePath, MAX_PATH);
    
    if (findHandle == INVALID_HANDLE_VALUE) {
        return partitions;
    }
    
    do {
        // Open the volume
        std::wstring volumePath = szVolumePath;
        // Strip trailing backslash for CreateFile
        std::wstring volumeDevice = volumePath;
        if (!volumeDevice.empty() && volumeDevice.back() == L'\\') {
            volumeDevice.pop_back();
        }
        
        HANDLE hVolume = CreateFileW(
            volumeDevice.c_str(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr,
            OPEN_EXISTING,
            0,
            nullptr
        );
        
        if (hVolume != INVALID_HANDLE_VALUE) {
            // Get disk extents to map volume to physical disk+partition
            BYTE extentsBuffer[sizeof(VOLUME_DISK_EXTENTS) + sizeof(DISK_EXTENT) * 32];
            DWORD bytesReturned = 0;
            
            if (DeviceIoControl(
                hVolume,
                IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS,
                nullptr,
                0,
                extentsBuffer,
                sizeof(extentsBuffer),
                &bytesReturned,
                nullptr
            )) {
                VOLUME_DISK_EXTENTS* extents = (VOLUME_DISK_EXTENTS*)extentsBuffer;
                
                if (extents->NumberOfDiskExtents > 0) {
                    DISK_EXTENT* extent = &extents->Extents[0];
                    
                    // Check if this volume belongs to the requested disk
                    if (static_cast<int>(extent->DiskNumber) == diskIndex) {
                        PartitionInfo partition;
                        partition.diskIndex = diskIndex;
                        partition.partitionIndex = 0;
                        partition.offset = extent->StartingOffset.QuadPart;
                        partition.size = extent->ExtentLength.QuadPart;
                        partition.type = 0xEE;  // Unknown from volume API
                        partitions.push_back(partition);
                    }
                }
            }
            
            CloseHandle(hVolume);
        }
        
    } while (FindNextVolumeW(findHandle, szVolumePath, MAX_PATH));
    
    FindVolumeClose(findHandle);
    return partitions;
}

std::string DiskReader::GetVolumePathForOffset(int diskIndex, uint64_t partitionOffset) {
    // Enumerate all volumes and find the one whose first extent on the
    // requested disk starts at the given partition offset.
    WCHAR szVolumePath[MAX_PATH];
    HANDLE findHandle = FindFirstVolumeW(szVolumePath, MAX_PATH);

    if (findHandle == INVALID_HANDLE_VALUE) {
        return "";
    }

    std::string result;

    do {
        std::wstring volumePath = szVolumePath;
        std::wstring volumeDevice = volumePath;
        if (!volumeDevice.empty() && volumeDevice.back() == L'\\') {
            volumeDevice.pop_back();
        }

        HANDLE hVolume = CreateFileW(
            volumeDevice.c_str(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr,
            OPEN_EXISTING,
            0,
            nullptr
        );

        if (hVolume != INVALID_HANDLE_VALUE) {
            BYTE extentsBuffer[sizeof(VOLUME_DISK_EXTENTS) + sizeof(DISK_EXTENT) * 32];
            DWORD bytesReturned = 0;

            if (DeviceIoControl(
                hVolume,
                IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS,
                nullptr,
                0,
                extentsBuffer,
                sizeof(extentsBuffer),
                &bytesReturned,
                nullptr
            )) {
                VOLUME_DISK_EXTENTS* extents = (VOLUME_DISK_EXTENTS*)extentsBuffer;

                for (DWORD i = 0; i < extents->NumberOfDiskExtents; i++) {
                    DISK_EXTENT* extent = &extents->Extents[i];

                    if (static_cast<int>(extent->DiskNumber) == diskIndex &&
                        static_cast<uint64_t>(extent->StartingOffset.QuadPart) == partitionOffset) {
                        result = std::string(volumePath.begin(), volumePath.end());
                        CloseHandle(hVolume);
                        FindVolumeClose(findHandle);
                        return result;
                    }
                }
            }

            CloseHandle(hVolume);
        }

    } while (FindNextVolumeW(findHandle, szVolumePath, MAX_PATH));

    FindVolumeClose(findHandle);
    return result;
}

std::string DiskReader::GetPhysicalDrivePath(int diskIndex) {
    std::stringstream ss;
    ss << "\\\\.\\PhysicalDrive" << diskIndex;
    return ss.str();
}

std::vector<char> DiskReader::ReadBlocks(const std::string& devicePath, uint64_t offset, uint64_t length) {
    HANDLE hDevice = GetCachedHandle(devicePath, GENERIC_READ);
    
    std::vector<char> data(length);
    LARGE_INTEGER fileOffset;
    fileOffset.QuadPart = static_cast<LONGLONG>(offset);
    
    SetFilePointerEx(hDevice, fileOffset, nullptr, FILE_BEGIN);
    
    DWORD totalRead = 0;
    const DWORD chunkSize = 1024 * 1024;  // 1MB chunks
    
    while (totalRead < length) {
        DWORD toRead = static_cast<DWORD>(std::min<uint64_t>(chunkSize, length - totalRead));
        DWORD bytesRead = 0;
        
        if (!ReadFile(hDevice, data.data() + totalRead, toRead, &bytesRead, nullptr)) {
            // Invalidate the cached handle on error.
            s_handleCache.erase(devicePath);
            CloseHandle(hDevice);
            std::ostringstream ss;
            ss << "ReadFile failed on " << devicePath
               << " at offset " << offset + totalRead << " (" << toRead << " bytes): "
               << FormatWinError(GetLastError());
            throw std::runtime_error(ss.str());
        }
        
        totalRead += bytesRead;
        
        if (bytesRead == 0) {
            break;
        }
    }
    
    data.resize(totalRead);
    return data;
}

uint64_t DiskReader::WriteBlocks(const std::string& devicePath, uint64_t offset, const char* data, size_t length) {
    HANDLE hDevice = GetCachedHandle(devicePath, GENERIC_READ | GENERIC_WRITE);
    
    LARGE_INTEGER fileOffset;
    fileOffset.QuadPart = static_cast<LONGLONG>(offset);
    
    if (!SetFilePointerEx(hDevice, fileOffset, nullptr, FILE_BEGIN)) {
        s_handleCache.erase(devicePath);
        CloseHandle(hDevice);
        std::ostringstream ss;
        ss << "SetFilePointerEx failed on " << devicePath << " at offset " << offset
           << ": " << FormatWinError(GetLastError());
        throw std::runtime_error(ss.str());
    }
    
    uint64_t totalWritten = 0;
    const DWORD chunkSize = 1024 * 1024;  // 1MB chunks
    
    while (totalWritten < length) {
        DWORD toWrite = static_cast<DWORD>(std::min<uint64_t>(chunkSize, length - totalWritten));
        DWORD bytesWritten = 0;
        
        if (!WriteFile(hDevice, data + totalWritten, toWrite, &bytesWritten, nullptr)) {
            s_handleCache.erase(devicePath);
            CloseHandle(hDevice);
            std::ostringstream ss;
            ss << "WriteFile failed on " << devicePath
               << " at offset " << offset + totalWritten << " (" << toWrite << " bytes): "
               << FormatWinError(GetLastError());
            throw std::runtime_error(ss.str());
        }
        
        totalWritten += bytesWritten;
        
        if (bytesWritten == 0) {
            break;
        }
    }
    
    if (totalWritten != length) {
        throw std::runtime_error("Incomplete write to device");
    }
    
    return totalWritten;
}

static std::string Utf16ToUtf8(const std::wstring& w) {
    if (w.empty()) return std::string();
    int len = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string out(len, 0);
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &out[0], len, nullptr, nullptr);
    return out;
}

std::vector<UsnRecord> DiskReader::QueryUsnJournal(const std::string& volumePath, uint64_t startUsn) {
    HANDLE hVolume = CreateFileW(
        std::wstring(volumePath.begin(), volumePath.end()).c_str(),
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
        nullptr
    );
    if (hVolume == INVALID_HANDLE_VALUE) {
        throw std::runtime_error("Failed to open volume: " + volumePath);
    }

    USN_JOURNAL_DATA_V0 journal = {};
    DWORD bytesReturned = 0;
    if (!DeviceIoControl(hVolume, FSCTL_QUERY_USN_JOURNAL, nullptr, 0, &journal, sizeof(journal), &bytesReturned, nullptr)) {
        CloseHandle(hVolume);
        throw std::runtime_error("FSCTL_QUERY_USN_JOURNAL failed (USN journal may be disabled or requires elevation)");
    }

    READ_USN_JOURNAL_DATA_V0 readData = {};
    readData.StartUsn = startUsn ? startUsn : journal.FirstUsn;
    readData.ReasonMask = 0xFFFFFFFF;
    readData.ReturnOnlyOnClose = 0;
    readData.Timeout = 0;
    readData.BytesToWaitFor = 0;
    readData.UsnJournalID = journal.UsnJournalID;

    std::vector<UsnRecord> records;
    const DWORD bufferSize = 64 * 1024;
    std::vector<char> buffer(bufferSize);

    bool firstRead = true;
    // No hard cap — read until the journal is exhausted.  The caller
    // (computeChangedBlockIndices) handles large result sets; the risk of
    // missing changed files from a silent truncation is worse than the
    // memory cost of a complete enumeration.
    while (true) {
        if (!DeviceIoControl(hVolume, FSCTL_READ_USN_JOURNAL, &readData, sizeof(readData), buffer.data(), bufferSize, &bytesReturned, nullptr)) {
            if (firstRead) {
                CloseHandle(hVolume);
                throw std::runtime_error("FSCTL_READ_USN_JOURNAL failed (reading the USN journal requires elevation)");
            }
            break;
        }
        firstRead = false;
        // Output layout: first 8 bytes = next USN, then USN records.
        if (bytesReturned <= sizeof(uint64_t)) {
            break;
        }
        readData.StartUsn = *reinterpret_cast<uint64_t*>(buffer.data());

        char* p = buffer.data() + sizeof(uint64_t);
        char* end = buffer.data() + bytesReturned;
        while (p + sizeof(USN_RECORD_V2) <= end) {
            USN_RECORD_V2* rec = reinterpret_cast<USN_RECORD_V2*>(p);
            if (rec->RecordLength == 0) break;
            std::wstring wname(rec->FileName, rec->FileNameLength / sizeof(WCHAR));
            records.push_back({ static_cast<uint64_t>(rec->Usn), static_cast<uint64_t>(rec->FileReferenceNumber), static_cast<uint32_t>(rec->Reason), Utf16ToUtf8(wname) });
            p += rec->RecordLength;
        }
    }

    CloseHandle(hVolume);
    return records;
}

uint32_t DiskReader::Crc32(const uint8_t* data, size_t length, uint32_t seed) {
    // Slice-by-8 CRC32: same polynomial (0xEDB88320, reflected CRC-32/ISO-HDLC)
    // and same output as the standard byte-at-a-time table, but processes 8
    // bytes per iteration using 8 precomputed lookup tables. ~8x fewer loop
    // iterations for large buffers (1MB blocks).
    static uint32_t table[8][256];
    static bool init = false;
    if (!init) {
        // Table 0: standard byte-at-a-time CRC table.
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
            }
            table[0][i] = c;
        }
        // Tables 1-7: derived from table 0 by feeding zero bytes.
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = table[0][i];
            for (int t = 1; t < 8; t++) {
                c = table[0][(c & 0xFF)] ^ (c >> 8);
                table[t][i] = c;
            }
        }
        init = true;
    }

    uint32_t crc = seed ^ 0xFFFFFFFFu;

    // Process 8 bytes at a time.
    const uint8_t* p = data;
    while (length >= 8) {
        uint32_t one, two;
        std::memcpy(&one, p, 4);
        std::memcpy(&two, p + 4, 4);
        one ^= crc;
        crc = table[0][(two >> 24) & 0xFF]
            ^ table[1][(two >> 16) & 0xFF]
            ^ table[2][(two >> 8) & 0xFF]
            ^ table[3][two & 0xFF]
            ^ table[4][(one >> 24) & 0xFF]
            ^ table[5][(one >> 16) & 0xFF]
            ^ table[6][(one >> 8) & 0xFF]
            ^ table[7][one & 0xFF];
        p += 8;
        length -= 8;
    }

    // Remaining bytes (0-7): standard byte-at-a-time.
    while (length > 0) {
        crc = table[0][(crc ^ *p) & 0xFF] ^ (crc >> 8);
        p++;
        length--;
    }

    return crc ^ 0xFFFFFFFFu;
}

UsnJournalInfo DiskReader::GetUsnJournalInfo(const std::string& volumePath) {
    HANDLE hVolume = CreateFileW(
        std::wstring(volumePath.begin(), volumePath.end()).c_str(),
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
        nullptr
    );
    if (hVolume == INVALID_HANDLE_VALUE) {
        throw std::runtime_error("Failed to open volume: " + volumePath);
    }
    USN_JOURNAL_DATA_V0 journal = {};
    DWORD bytesReturned = 0;
    if (!DeviceIoControl(hVolume, FSCTL_QUERY_USN_JOURNAL, nullptr, 0, &journal, sizeof(journal), &bytesReturned, nullptr)) {
        CloseHandle(hVolume);
        throw std::runtime_error("FSCTL_QUERY_USN_JOURNAL failed (USN journal may be disabled or requires elevation)");
    }
    CloseHandle(hVolume);
    UsnJournalInfo info;
    info.firstUsn = journal.FirstUsn;
    info.nextUsn = journal.NextUsn;
    info.lowestValidUsn = journal.LowestValidUsn;
    return info;
}
