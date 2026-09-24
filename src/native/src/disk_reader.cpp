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
// Volumes locked for restore; held open until ReleaseLockedVolumes.
std::vector<HANDLE> DiskReader::s_lockedVolumes;

bool DiskReader::LockAndDismountVolume(const std::string& volumePath) {
    if (volumePath.empty()) {
        return false;
    }
    std::wstring wide(volumePath.begin(), volumePath.end());
    // Strip trailing backslash for CreateFile on volume GUID paths.
    if (!wide.empty() && wide.back() == L'\\') {
        wide.pop_back();
    }
    HANDLE hVolume = CreateFileW(
        wide.c_str(),
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
        nullptr
    );
    if (hVolume == INVALID_HANDLE_VALUE) {
        return false;
    }

    DWORD bytesReturned = 0;
    bool locked = false;
    for (int attempt = 0; attempt < 8; attempt++) {
        if (DeviceIoControl(hVolume, FSCTL_LOCK_VOLUME, nullptr, 0, nullptr, 0, &bytesReturned, nullptr)) {
            locked = true;
            break;
        }
        Sleep(150);
    }
    if (!locked) {
        CloseHandle(hVolume);
        return false;
    }

    if (!DeviceIoControl(hVolume, FSCTL_DISMOUNT_VOLUME, nullptr, 0, nullptr, 0, &bytesReturned, nullptr)) {
        DeviceIoControl(hVolume, FSCTL_UNLOCK_VOLUME, nullptr, 0, nullptr, 0, &bytesReturned, nullptr);
        CloseHandle(hVolume);
        return false;
    }

    // Hold the lock for the duration of the raw writes so the volume stays
    // dismounted and ntfs.sys cannot flush pre-restore cache over our data.
    s_lockedVolumes.push_back(hVolume);
    return true;
}

void DiskReader::ReleaseLockedVolumes() {
    DWORD bytesReturned = 0;
    for (HANDLE h : s_lockedVolumes) {
        if (h != INVALID_HANDLE_VALUE) {
            DeviceIoControl(h, FSCTL_UNLOCK_VOLUME, nullptr, 0, nullptr, 0, &bytesReturned, nullptr);
            CloseHandle(h);
        }
    }
    s_lockedVolumes.clear();
}

bool DiskReader::UpdateDiskProperties(const std::string& devicePath) {
    if (devicePath.empty()) {
        return false;
    }
    HANDLE hDevice = CreateFileW(
        std::wstring(devicePath.begin(), devicePath.end()).c_str(),
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr,
        OPEN_EXISTING,
        0,
        nullptr
    );
    if (hDevice == INVALID_HANDLE_VALUE) {
        return false;
    }
    DWORD bytesReturned = 0;
    const BOOL ok = DeviceIoControl(
        hDevice,
        IOCTL_DISK_UPDATE_PROPERTIES,
        nullptr,
        0,
        nullptr,
        0,
        &bytesReturned,
        nullptr
    );
    CloseHandle(hDevice);
    return ok == TRUE;
}

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
    ReleaseLockedVolumes();
    for (auto& [path, handle] : s_handleCache) {
        if (handle != INVALID_HANDLE_VALUE) {
            CloseHandle(handle);
            handle = INVALID_HANDLE_VALUE;
        }
    }
    s_handleCache.clear();
}

std::vector<DiskInfo> DiskReader::EnumerateDisks() {
    // Enumerate \\.\PhysicalDriveN directly. The previous SetupDi-based path
    // derived the drive number from the device instance ID, which is absent on
    // USB devices ("USBSTOR\DISK&VEN_..." contains no number) — it then fell
    // back to the enumeration index and reported the WRONG disk (wrong size and
    // partitions, e.g. a 231 GB USB key shown as 931 GB).
    std::vector<DiskInfo> disks;

    for (int i = 0; i < 64; i++) {
        std::string path = GetPhysicalDrivePath(i);
        HANDLE hDrive = CreateFileW(
            std::wstring(path.begin(), path.end()).c_str(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr,
            OPEN_EXISTING,
            0,
            nullptr
        );
        if (hDrive == INVALID_HANDLE_VALUE) {
            continue; // no such physical drive
        }

        DISK_GEOMETRY_EX geometry = {};
        DWORD bytesReturned = 0;
        if (!DeviceIoControl(
            hDrive,
            IOCTL_DISK_GET_DRIVE_GEOMETRY_EX,
            nullptr,
            0,
            &geometry,
            sizeof(geometry),
            &bytesReturned,
            nullptr
        )) {
            CloseHandle(hDrive);
            continue;
        }

        DiskInfo disk;
        disk.index = i;
        disk.size = geometry.DiskSize.QuadPart;

        STORAGE_PROPERTY_QUERY query = {};
        query.PropertyId = StorageDeviceProperty;
        query.QueryType = PropertyStandardQuery;

        std::vector<BYTE> descriptorBuffer(4096);
        if (DeviceIoControl(
            hDrive,
            IOCTL_STORAGE_QUERY_PROPERTY,
            &query,
            sizeof(query),
            descriptorBuffer.data(),
            static_cast<DWORD>(descriptorBuffer.size()),
            &bytesReturned,
            nullptr
        )) {
            STORAGE_DEVICE_DESCRIPTOR* desc = (STORAGE_DEVICE_DESCRIPTOR*)descriptorBuffer.data();
            auto readString = [&](DWORD offset) -> std::string {
                if (offset == 0 || offset >= descriptorBuffer.size()) return std::string();
                std::string s((const char*)descriptorBuffer.data() + offset);
                while (!s.empty() && (s.back() == ' ' || s.back() == '\0')) s.pop_back();
                return s;
            };
            disk.model = readString(desc->ProductIdOffset);
            disk.serial = readString(desc->SerialNumberOffset);
        }
        if (disk.model.empty()) {
            disk.model = "Disk " + std::to_string(i);
        }

        disks.push_back(disk);
        CloseHandle(hDrive);
    }

    return disks;
}

// Map a GPT partition type GUID to the equivalent MBR type byte so the VSS
// gate (which keys off MBR type codes) treats GPT partitions consistently.
static uint8_t GptTypeToMbr(const GUID& type) {
    struct GuidMap { GUID guid; uint8_t mbr; };
    static const GuidMap kMap[] = {
        { {0xC12A7328, 0xF81F, 0x11D2, {0xBA, 0x4B, 0x00, 0xA0, 0xC9, 0x3E, 0xC9, 0x3B}}, 0xEF }, // EFI System
        { {0xE3C9E316, 0x0B5C, 0x4DB8, {0x81, 0x7D, 0xF9, 0x2D, 0xF0, 0x02, 0x15, 0xAE}}, 0x27 }, // MSR
        { {0xDE94BBA4, 0x06D1, 0x4D40, {0xA1, 0x6A, 0xBF, 0xD5, 0x01, 0x79, 0xD6, 0xAC}}, 0x27 }, // Recovery
        { {0x0FC63DAF, 0x8483, 0x4772, {0x8E, 0x79, 0x3D, 0x69, 0xD8, 0x47, 0x7D, 0xE4}}, 0x83 }, // Linux
        { {0xEBD0A0A2, 0xB9E5, 0x4433, {0x87, 0xC0, 0x68, 0xB6, 0xB7, 0x26, 0x99, 0xC7}}, 0x07 }, // Basic Data
    };
    for (const auto& e : kMap) {
        if (e.guid.Data1 == type.Data1 && e.guid.Data2 == type.Data2 && e.guid.Data3 == type.Data3 &&
            memcmp(e.guid.Data4, type.Data4, 8) == 0) {
            return e.mbr;
        }
    }
    return 0xEE; // unknown GPT partition
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
        // Try IOCTL_DISK_GET_DRIVE_LAYOUT_EX - may work without raw read permission.
        // Size the buffer for up to 128 partitions; the old 4-entry buffer made
        // the IOCTL fail with ERROR_INSUFFICIENT_BUFFER on disks with more
        // partitions (or GPT disks with many entries), silently yielding none.
        constexpr DWORD kMaxPartitions = 128;
        std::vector<BYTE> layoutBuffer(
            sizeof(DRIVE_LAYOUT_INFORMATION_EX) + kMaxPartitions * sizeof(PARTITION_INFORMATION_EX));
        DWORD bytesReturned = 0;

        if (DeviceIoControl(
            hDrive,
            IOCTL_DISK_GET_DRIVE_LAYOUT_EX,
            nullptr,
            0,
            layoutBuffer.data(),
            static_cast<DWORD>(layoutBuffer.size()),
            &bytesReturned,
            nullptr
        )) {
            DRIVE_LAYOUT_INFORMATION_EX* layout = (DRIVE_LAYOUT_INFORMATION_EX*)layoutBuffer.data();

            if (layout->PartitionStyle == PARTITION_STYLE_GPT) {
                // GPT layout
                for (DWORD i = 0; i < layout->PartitionCount && i < kMaxPartitions; i++) {
                    PARTITION_INFORMATION_EX* part = &layout->PartitionEntry[i];
                    if (part->PartitionLength.QuadPart == 0) continue;

                    PartitionInfo partition;
                    partition.diskIndex = diskIndex;
                    partition.partitionIndex = static_cast<int>(part->PartitionNumber - 1);
                    partition.offset = part->StartingOffset.QuadPart;
                    partition.size = part->PartitionLength.QuadPart;
                    partition.type = GptTypeToMbr(part->Gpt.PartitionType);
                    partitions.push_back(partition);
                }
            } else if (layout->PartitionStyle == PARTITION_STYLE_MBR) {
                // MBR layout
                for (DWORD i = 0; i < layout->PartitionCount && i < 4; i++) {
                    PARTITION_INFORMATION_EX* part = &layout->PartitionEntry[i];
                    if (part->PartitionLength.QuadPart == 0) continue;

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

    // Raw disk/volume devices only accept sector-aligned offsets and lengths.
    // Align the offset down and round the length up, then trim the result so
    // callers still receive exactly the requested range. Filesystem metadata
    // reads (e.g. the NTFS $Bitmap) are not sector-multiple sized.
    const uint64_t sector = 512;
    const uint64_t alignedOffset = offset - (offset % sector);
    const uint64_t lead = offset - alignedOffset;
    const uint64_t alignedLength = ((lead + length + sector - 1) / sector) * sector;

    std::vector<char> data(alignedLength);
    LARGE_INTEGER fileOffset;
    fileOffset.QuadPart = static_cast<LONGLONG>(alignedOffset);

    SetFilePointerEx(hDevice, fileOffset, nullptr, FILE_BEGIN);

    DWORD totalRead = 0;
    const DWORD chunkSize = 1024 * 1024;  // 1MB chunks

    while (totalRead < alignedLength) {
        DWORD toRead = static_cast<DWORD>(std::min<uint64_t>(chunkSize, alignedLength - totalRead));
        DWORD bytesRead = 0;

        if (!ReadFile(hDevice, data.data() + totalRead, toRead, &bytesRead, nullptr)) {
            // Invalidate the cached handle on error.
            s_handleCache.erase(devicePath);
            CloseHandle(hDevice);
            std::ostringstream ss;
            ss << "ReadFile failed on " << devicePath
               << " at offset " << alignedOffset + totalRead << " (" << toRead << " bytes): "
               << FormatWinError(GetLastError());
            throw std::runtime_error(ss.str());
        }

        totalRead += bytesRead;

        if (bytesRead == 0) {
            break;
        }
    }

    data.resize(totalRead);

    // Common case (already sector-aligned): return as-is, no extra copy.
    if (lead == 0 && data.size() == length) {
        return data;
    }

    // Trim back to the caller's requested window.
    if (lead >= data.size()) {
        return {};
    }
    const uint64_t take = std::min<uint64_t>(length, data.size() - lead);
    return std::vector<char>(data.begin() + lead, data.begin() + lead + take);
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
