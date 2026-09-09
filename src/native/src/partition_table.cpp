#include "partition_table.h"

#include <napi.h>
#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr uint32_t kLbaSize = 512;
constexpr uint32_t kLbaGptHeader = 1;         // LBA1: primary GPT header
constexpr uint32_t kLbaGptEntries = 2;        // LBA2..LBA33: partition entries (32 sectors)
constexpr uint32_t kSectorsGptEntries = 32;
constexpr uint32_t kGptFirstUsable = kLbaGptEntries + kSectorsGptEntries;  // LBA34
constexpr uint32_t kGptEntryCount = 128;
constexpr uint32_t kGptEntrySize = 128;
constexpr uint32_t kGptMaxPartitions = 128;
constexpr uint32_t kMbrMaxPartitions = 4;

struct TableEntry {
    uint64_t offset;
    uint64_t size;
    uint8_t typeGuid[16];
    std::u16string name;
    bool bootable;
};

uint32_t Crc32Table[256];

void InitCrc32Table() {
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int j = 0; j < 8; j++) {
            c = (c >> 1) ^ (0xEDB88320u & (0U - (c & 1)));
        }
        Crc32Table[i] = c;
    }
}

uint32_t ComputeCrc(const void* data, size_t size) {
    static bool init = []() {
        InitCrc32Table();
        return true;
    }();
    (void)init;
    const unsigned char* bytes = static_cast<const unsigned char*>(data);
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < size; i++) {
        crc = (crc >> 8) ^ Crc32Table[(crc ^ bytes[i]) & 0xFFu];
    }
    return ~crc;
}

void PutU16(uint8_t* dst, uint16_t v) {
    dst[0] = static_cast<uint8_t>(v & 0xFF);
    dst[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
}

void PutU32(uint8_t* dst, uint32_t v) {
    for (int i = 0; i < 4; i++) {
        dst[i] = static_cast<uint8_t>((v >> (8 * i)) & 0xFF);
    }
}

void PutU64(uint8_t* dst, uint64_t v) {
    for (int i = 0; i < 8; i++) {
        dst[i] = static_cast<uint8_t>((v >> (8 * i)) & 0xFF);
    }
}

// Parse "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" into 16 raw bytes.
bool ParseGuid(const std::string& text, uint8_t out[16]) {
    if (text.size() != 36) {
        return false;
    }
    int byteIndex = 0;
    for (size_t i = 0; i < 36;) {
        if (text[i] == '-') {
            i++;
            continue;
        }
        if (byteIndex >= 16) {
            return false;
        }
        auto hexVal = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        int hi = hexVal(text[i]);
        int lo = i + 1 < text.size() ? hexVal(text[i + 1]) : -1;
        if (hi < 0 || lo < 0) {
            return false;
        }
        out[byteIndex++] = static_cast<uint8_t>((hi << 4) | lo);
        i += 2;
    }
    return byteIndex == 16;
}

void FormatGuid(const uint8_t guid[16], std::string& out) {
    static const char* hex = "0123456789abcdef";
    char buf[37];
    int p = 0;
    for (int i = 0; i < 16; i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10) {
            buf[p++] = '-';
        }
        buf[p++] = hex[guid[i] >> 4];
        buf[p++] = hex[guid[i] & 0xF];
    }
    buf[p] = '\0';
    out.assign(buf);
}

void CrcLayoutHash(const std::vector<TableEntry>& entries, uint64_t lbaCount, uint32_t& crc) {
    std::vector<uint8_t> buf;
    buf.reserve(entries.size() * 20);
    for (const auto& e : entries) {
        for (int i = 0; i < 8; i++) buf.push_back(static_cast<uint8_t>((e.offset >> (8 * i)) & 0xFF));
        for (int i = 0; i < 8; i++) buf.push_back(static_cast<uint8_t>((e.size >> (8 * i)) & 0xFF));
    }
    for (int i = 0; i < 8; i++) buf.push_back(static_cast<uint8_t>((lbaCount >> (8 * i)) & 0xFF));
    crc = ComputeCrc(buf.data(), buf.size());
}

void DefaultDiskGuid(const std::vector<TableEntry>& entries, uint64_t lbaCount, uint8_t out[16]) {
    out[0] = 'O';
    out[1] = 'P';
    out[2] = 'B';
    out[3] = 'S';
    for (int i = 0; i < 8; i++) out[4 + i] = static_cast<uint8_t>((lbaCount >> (8 * i)) & 0xFF);
    uint32_t crc = 0;
    CrcLayoutHash(entries, lbaCount, crc);
    for (int i = 0; i < 4; i++) out[12 + i] = static_cast<uint8_t>((crc >> (8 * i)) & 0xFF);
}

void BuildProtectiveMbr(uint64_t lbaCount, std::vector<uint8_t>& sector) {
    sector.assign(kLbaSize, 0);
    uint8_t* entry = sector.data() + 0x1BE;
    entry[0] = 0x00;              // status: inactive
    entry[1] = 0x00;
    entry[2] = 0x02;
    entry[3] = 0x00;
    entry[4] = 0xEE;              // GPT protective type
    entry[5] = 0xFF;
    entry[6] = 0xFF;
    entry[7] = 0xFF;
    PutU32(entry + 8, 1);         // start LBA = 1 (relative to start)
    uint64_t sizeLba = lbaCount - 1;
    PutU32(entry + 12, sizeLba > 0xFFFFFFFFu ? 0xFFFFFFFFu : static_cast<uint32_t>(sizeLba));
    sector[510] = 0x55;
    sector[511] = 0xAA;
}

void BuildGptHeader(uint8_t* hdr, uint64_t currentLba, uint64_t backupLba, uint64_t firstUsable,
                    uint64_t lastUsable, const uint8_t diskGuid[16], uint64_t entriesLba,
                    uint32_t entriesCrc) {
    std::memset(hdr, 0, kLbaSize);
    std::memcpy(hdr, "EFI PART", 8);
    PutU32(hdr + 8, 0x00010000);     // revision 1.0
    PutU32(hdr + 12, 92);            // header size
    PutU32(hdr + 16, 0);             // CRC (filled later)
    PutU32(hdr + 20, 0);             // reserved
    PutU64(hdr + 24, currentLba);
    PutU64(hdr + 32, backupLba);
    PutU64(hdr + 40, firstUsable);
    PutU64(hdr + 48, lastUsable);
    std::memcpy(hdr + 56, diskGuid, 16);
    PutU64(hdr + 72, entriesLba);
    PutU32(hdr + 80, kGptEntryCount);
    PutU32(hdr + 84, kGptEntrySize);
    PutU32(hdr + 88, entriesCrc);
    uint32_t crc = ComputeCrc(hdr, 92);
    PutU32(hdr + 16, crc);
}

void WriteGptEntry(uint8_t* entry, const TableEntry& e, const uint8_t diskGuid[16], uint32_t index) {
    std::memset(entry, 0, kGptEntrySize);
    std::memcpy(entry, e.typeGuid, 16);
    std::memcpy(entry + 16, diskGuid, 16);
    PutU32(entry + 28, index + 1);
    uint64_t firstLba = e.offset / kLbaSize;
    uint64_t sizeLba = e.size / kLbaSize;
    PutU64(entry + 32, firstLba);
    PutU64(entry + 40, firstLba + sizeLba - 1);
    PutU64(entry + 48, 0);  // attributes
    size_t chars = std::min<size_t>(e.name.size(), 36);
    std::memcpy(entry + 56, e.name.data(), chars * 2);
}

void BuildGpt(const std::vector<TableEntry>& entries, uint64_t lbaCount, uint8_t diskGuid[16],
              std::vector<std::pair<uint64_t, std::vector<uint8_t>>>& regions) {
    if (lbaCount < kGptFirstUsable * 2) {
        throw std::runtime_error("Disk is too small for a GPT layout");
    }
    uint64_t lastLba = lbaCount - 1;
    uint64_t firstUsable = kGptFirstUsable;
    // Reserve the backup header (lastLba) and the 32 backup-entry sectors
    // (lastLba-32..lastLba-1), leaving two spare sectors before them.
    uint64_t lastUsable = lastLba - kSectorsGptEntries - 2;

    std::vector<uint8_t> entriesRegion(kSectorsGptEntries * kLbaSize, 0);
    for (size_t i = 0; i < entries.size(); i++) {
        WriteGptEntry(entriesRegion.data() + i * kGptEntrySize, entries[i], diskGuid, static_cast<uint32_t>(i));
    }
    uint32_t entriesCrc = ComputeCrc(entriesRegion.data(), entriesRegion.size());

    uint64_t backupEntriesLba = lastLba - kSectorsGptEntries;            // lastLba - 32
    uint64_t backupHeaderLba = lastLba;

    std::vector<uint8_t> primaryHeader(kLbaSize);
    BuildGptHeader(primaryHeader.data(), kLbaGptHeader, lastLba, firstUsable, lastUsable, diskGuid,
                   kLbaGptEntries, entriesCrc);

    std::vector<uint8_t> backupHeader(kLbaSize);
    BuildGptHeader(backupHeader.data(), lastLba, kLbaGptHeader, firstUsable, lastUsable, diskGuid,
                   backupEntriesLba, entriesCrc);

    std::vector<uint8_t> mbr;
    BuildProtectiveMbr(lbaCount, mbr);

    regions.emplace_back(0, std::move(mbr));
    regions.emplace_back(kLbaGptHeader * static_cast<uint64_t>(kLbaSize), std::move(primaryHeader));
    regions.emplace_back(kLbaGptEntries * static_cast<uint64_t>(kLbaSize), std::move(entriesRegion));
    regions.emplace_back(backupEntriesLba * kLbaSize, std::vector<uint8_t>(regions[2].second));
    regions.emplace_back(backupHeaderLba * kLbaSize, std::move(backupHeader));
}

void BuildMbr(const std::vector<TableEntry>& entries, uint64_t lbaCount, std::vector<uint8_t>& sector) {
    sector.assign(kLbaSize, 0);
    if (entries.size() > kMbrMaxPartitions) {
        throw std::runtime_error("MBR supports at most 4 partitions");
    }
    for (size_t i = 0; i < entries.size(); i++) {
        const auto& e = entries[i];
        uint64_t startLba = e.offset / kLbaSize;
        uint64_t sizeLba = e.size / kLbaSize;
        if (startLba > 0xFFFFFFFEu || sizeLba > 0xFFFFFFFFu) {
            throw std::runtime_error("MBR partition exceeds the 32-bit LBA limit");
        }
        uint8_t* entry = sector.data() + 0x1BE + i * 16;
        entry[0] = e.bootable ? 0x80 : 0x00;
        entry[1] = 0xFE;
        entry[2] = 0xFF;
        entry[3] = 0xFF;
        entry[4] = 0x07;  // NTFS / basic data
        entry[5] = 0xFE;
        entry[6] = 0xFF;
        entry[7] = 0xFF;
        PutU32(entry + 8, static_cast<uint32_t>(startLba));
        PutU32(entry + 12, static_cast<uint32_t>(sizeLba));
    }
    sector[510] = 0x55;
    sector[511] = 0xAA;
}

std::vector<TableEntry> ParseEntries(const Napi::Array& arr) {
    std::vector<TableEntry> entries;
    entries.reserve(arr.Length());
    for (uint32_t i = 0; i < arr.Length(); i++) {
        Napi::Value v = arr.Get(i);
        if (!v.IsObject()) {
            throw std::runtime_error("Each partition-table entry must be an object");
        }
        Napi::Object obj = v.As<Napi::Object>();
        TableEntry e = {};
        e.typeGuid[0] = 0;
        if (obj.Get("offset").IsBigInt()) {
            bool lossless = false;
            e.offset = obj.Get("offset").As<Napi::BigInt>().Uint64Value(&lossless);
        } else {
            e.offset = static_cast<uint64_t>(obj.Get("offset").As<Napi::Number>().Int64Value());
        }
        if (obj.Get("size").IsBigInt()) {
            bool lossless = false;
            e.size = obj.Get("size").As<Napi::BigInt>().Uint64Value(&lossless);
        } else {
            e.size = static_cast<uint64_t>(obj.Get("size").As<Napi::Number>().Int64Value());
        }
        if (e.offset % kLbaSize != 0 || e.size % kLbaSize != 0) {
            throw std::runtime_error("Partition offsets/sizes must be sector-aligned (512 bytes)");
        }
        if (obj.Has("typeGuid")) {
            std::string guidText = obj.Get("typeGuid").As<Napi::String>().Utf8Value();
            if (!ParseGuid(guidText, e.typeGuid)) {
                throw std::runtime_error("Invalid partition type GUID: " + guidText);
            }
        } else {
            e.typeGuid[0] = 0;  // zero GUID: caller should supply one for GPT
        }
        if (obj.Has("name")) {
            std::string utf8 = obj.Get("name").As<Napi::String>().Utf8Value();
            // Convert UTF-8 to UTF-16LE for the GPT name field.
            int size16 = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), nullptr, 0);
            if (size16 > 0) {
                std::vector<wchar_t> wide(size16);
                MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), wide.data(), size16);
                e.name.assign(wide.begin(), wide.end());
            }
        }
        e.bootable = obj.Has("bootable") ? obj.Get("bootable").As<Napi::Boolean>().Value() : false;
        entries.push_back(std::move(e));
    }
    return entries;
}

uint64_t ParseLbaCount(const Napi::Value& v) {
    if (v.IsBigInt()) {
        bool lossless = false;
        uint64_t n = v.As<Napi::BigInt>().Uint64Value(&lossless);
        if (!lossless) {
            throw std::runtime_error("lbaCount does not fit in a 64-bit integer");
        }
        return n;
    }
    return static_cast<uint64_t>(v.As<Napi::Number>().Int64Value());
}

Napi::Value BuildPartitionTable(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Expected (scheme, lbaCount, entries[, options])").ThrowAsJavaScriptException();
        return env.Null();
    }
    try {
        std::string scheme = info[0].As<Napi::String>().Utf8Value();
        uint64_t lbaCount = ParseLbaCount(info[1]);
        Napi::Array arr = info[2].As<Napi::Array>();
        std::vector<TableEntry> entries = ParseEntries(arr);

        uint8_t diskGuid[16] = {0};
        if (info.Length() >= 4 && info[3].IsObject()) {
            Napi::Object opts = info[3].As<Napi::Object>();
            if (opts.Has("diskGuid")) {
                std::string guidText = opts.Get("diskGuid").As<Napi::String>().Utf8Value();
                if (!ParseGuid(guidText, diskGuid)) {
                    throw std::runtime_error("Invalid disk GUID: " + guidText);
                }
            }
        }
        if (diskGuid[0] == 0 && diskGuid[1] == 0 && diskGuid[2] == 0 && diskGuid[3] == 0 && diskGuid[4] == 0 &&
            diskGuid[5] == 0 && diskGuid[6] == 0 && diskGuid[7] == 0) {
            DefaultDiskGuid(entries, lbaCount, diskGuid);
        }

        // Validate ordering + overlap + bounds before trusting the layout.
        uint64_t prevEnd = 0;
        for (size_t i = 0; i < entries.size(); i++) {
            if (entries[i].offset < prevEnd) {
                throw std::runtime_error("Partition entries overlap or are out of order");
            }
            uint64_t end = entries[i].offset + entries[i].size;
            if (end > lbaCount * kLbaSize) {
                throw std::runtime_error("Partition exceeds the disk size");
            }
            prevEnd = end;
        }

        std::vector<std::pair<uint64_t, std::vector<uint8_t>>> regions;
        if (scheme == "gpt") {
            for (const auto& e : entries) {
                if (e.offset < kGptFirstUsable * kLbaSize) {
                    throw std::runtime_error("GPT partitions must start at or after LBA 34");
                }
            }
            BuildGpt(entries, lbaCount, diskGuid, regions);
        } else if (scheme == "mbr") {
            std::vector<uint8_t> mbr;
            BuildMbr(entries, lbaCount, mbr);
            regions.emplace_back(0, std::move(mbr));
        } else {
            throw std::runtime_error("Unknown partition-table scheme: " + scheme);
        }

        Napi::Object result = Napi::Object::New(env);
        Napi::Array regionArr = Napi::Array::New(env, regions.size());
        for (size_t i = 0; i < regions.size(); i++) {
            Napi::Object region = Napi::Object::New(env);
            region.Set("offset", Napi::Number::New(env, static_cast<double>(regions[i].first)));
            region.Set(
                "data",
                Napi::Buffer<unsigned char>::Copy(env, regions[i].second.data(), regions[i].second.size()));
            regionArr.Set(i, region);
        }
        result.Set("regions", regionArr);
        result.Set("firstUsableLBA", Napi::Number::New(env, kGptFirstUsable));
        uint64_t lastLba = lbaCount - 1;
        result.Set("lastUsableLBA",
                   Napi::Number::New(env, static_cast<double>(scheme == "gpt" ? lastLba - kSectorsGptEntries - 2 : 0)));
        return result;
    } catch (const std::exception& e) {
        Napi::TypeError::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

}  // namespace

Napi::Object RegisterPartitionTable(Napi::Env env, Napi::Object exports) {
    exports.Set("buildPartitionTable", Napi::Function::New(env, BuildPartitionTable));
    return exports;
}