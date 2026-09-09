#include <napi.h>

#include "disk_reader.h"
#include "vss_manager.h"
#include "backup_format.h"
#include "partition_table.h"

// Disk enumeration wrapper
Napi::Value GetDisks(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    auto disks = DiskReader::EnumerateDisks();
    auto result = Napi::Array::New(env, disks.size());
    
    for (size_t i = 0; i < disks.size(); i++) {
        auto obj = Napi::Object::New(env);
        obj.Set("index", disks[i].index);
        obj.Set("model", disks[i].model);
        obj.Set("size", disks[i].size);
        obj.Set("serial", disks[i].serial);
        result.Set(i, obj);
    }
    
    return result;
}

// Get partitions for a disk
Napi::Value GetPartitions(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int diskIndex = info[0].As<Napi::Number>().Int32Value();
    
    try {
        auto partitions = DiskReader::EnumeratePartitions(diskIndex);
        auto result = Napi::Array::New(env, partitions.size());
        
        for (size_t i = 0; i < partitions.size(); i++) {
            auto obj = Napi::Object::New(env);
            obj.Set("diskIndex", partitions[i].diskIndex);
            obj.Set("partitionIndex", partitions[i].partitionIndex);
            obj.Set("offset", partitions[i].offset);
            obj.Set("size", partitions[i].size);
            obj.Set("type", partitions[i].type);
            result.Set(i, obj);
        }
        
        return result;
    } catch (const std::exception& e) {
        Napi::TypeError::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

// Get physical drive path
Napi::Value GetPhysicalDrivePath(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int diskIndex = info[0].As<Napi::Number>().Int32Value();
    
    std::string path = DiskReader::GetPhysicalDrivePath(diskIndex);
    return Napi::String::New(env, path);
}

// Get the volume device path that backs the partition at the given offset
Napi::Value GetVolumePath(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int diskIndex = info[0].As<Napi::Number>().Int32Value();
    uint64_t partitionOffset = 0;
    if (info[1].IsBigInt()) {
        bool lossless = false;
        partitionOffset = info[1].As<Napi::BigInt>().Uint64Value(&lossless);
    } else {
        partitionOffset = static_cast<uint64_t>(info[1].As<Napi::Number>().Int64Value());
    }
    
    std::string path = DiskReader::GetVolumePathForOffset(diskIndex, partitionOffset);
    return Napi::String::New(env, path);
}

// Compute a CRC-32 of a buffer (matches the JS implementation).
Napi::Value Crc32(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "crc32 expects a Buffer").ThrowAsJavaScriptException();
        return env.Null();
    }
    Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
    uint32_t seed = info.Length() > 1 ? info[1].As<Napi::Number>().Uint32Value() : 0;
    uint32_t crc = DiskReader::Crc32(buf.Data(), buf.Length(), seed);
    return Napi::Number::New(env, crc);
}

// Return the USN journal cursor info (first/next/lowest-valid USN).
Napi::Value GetUsnJournalInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string volumePath = info[0].As<Napi::String>().Utf8Value();
    try {
        auto journal = DiskReader::GetUsnJournalInfo(volumePath);
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("firstUsn", Napi::BigInt::New(env, journal.firstUsn));
        obj.Set("nextUsn", Napi::BigInt::New(env, journal.nextUsn));
        obj.Set("lowestValidUsn", Napi::BigInt::New(env, journal.lowestValidUsn));
        return obj;
    } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

// Query the NTFS USN journal for recent change records.
Napi::Value QueryUsnJournal(const Napi::CallbackInfo& info) {    Napi::Env env = info.Env();
    std::string volumePath = info[0].As<Napi::String>().Utf8Value();
    uint64_t startUsn = 0;
    if (info.Length() > 1 && info[1].IsNumber()) {
        startUsn = static_cast<uint64_t>(info[1].As<Napi::Number>().Int64Value());
    }

    try {
        auto records = DiskReader::QueryUsnJournal(volumePath, startUsn);
        Napi::Array result = Napi::Array::New(env, records.size());
        for (size_t i = 0; i < records.size(); i++) {
            Napi::Object obj = Napi::Object::New(env);
            obj.Set("usn", Napi::BigInt::New(env, records[i].usn));
            obj.Set("fileReference", Napi::BigInt::New(env, records[i].fileReference));
            obj.Set("reason", Napi::Number::New(env, records[i].reason));
            obj.Set("fileName", Napi::String::New(env, records[i].fileName));
            result.Set(i, obj);
        }
        return result;
    } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

// Create VSS snapshot for a volume
Napi::Value CreateSnapshot(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string volumePath = info[0].As<Napi::String>().Utf8Value();
    
    try {
        auto snapshot = VssManager::CreateSnapshot(volumePath);
        auto result = Napi::Object::New(env);
        result.Set("id", snapshot.id);
        result.Set("devicePath", snapshot.devicePath);
        return result;
    } catch (const std::exception& e) {
        Napi::TypeError::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

// Delete a VSS snapshot
Napi::Value DeleteSnapshot(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string snapshotId = info[0].As<Napi::String>().Utf8Value();
    
    try {
        VssManager::DeleteSnapshot(snapshotId);
        return Napi::Boolean::New(env, true);
    } catch (const std::exception& e) {
        Napi::TypeError::New(env, e.what()).ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
}

// Read a block from disk
Napi::Value ReadBlocks(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string devicePath = info[0].As<Napi::String>().Utf8Value();
    bool lossless = false;
    int64_t offset = info[1].As<Napi::BigInt>().Int64Value(&lossless);
    int64_t length = info[2].As<Napi::BigInt>().Int64Value(&lossless);
    
    try {
        auto data = DiskReader::ReadBlocks(devicePath, offset, length);
        return Napi::Buffer<char>::Copy(env, data.data(), data.size());
    } catch (const std::exception& e) {
        Napi::TypeError::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

// Write raw blocks to a device
Napi::Value WriteBlocks(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string devicePath = info[0].As<Napi::String>().Utf8Value();
    
    uint64_t offset = 0;
    if (info[1].IsBigInt()) {
        bool lossless = false;
        offset = info[1].As<Napi::BigInt>().Uint64Value(&lossless);
    } else {
        offset = static_cast<uint64_t>(info[1].As<Napi::Number>().Int64Value());
    }
    
    Napi::Buffer<char> bufferData = info[2].As<Napi::Buffer<char>>();
    
    try {
        uint64_t written = DiskReader::WriteBlocks(
            devicePath,
            offset,
            bufferData.Data(),
            bufferData.Length()
        );
        return Napi::Number::New(env, static_cast<double>(written));
    } catch (const std::exception& e) {
        Napi::TypeError::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

// Open an image file for writing
Napi::Value OpenImageForWrite(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string path = info[0].As<Napi::String>().Utf8Value();
    
    try {
        auto handle = BackupFormat::OpenForWrite(path);
        return Napi::BigInt::New(env, handle);
    } catch (const std::exception& e) {
        Napi::TypeError::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

Napi::Object RegisterZstd(Napi::Env env, Napi::Object exports);

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    RegisterZstd(env, exports);
    RegisterPartitionTable(env, exports);
    exports.Set("getDisks", Napi::Function::New(env, GetDisks));
    exports.Set("getPartitions", Napi::Function::New(env, GetPartitions));
    exports.Set("getPhysicalDrivePath", Napi::Function::New(env, GetPhysicalDrivePath));
    exports.Set("getVolumePath", Napi::Function::New(env, GetVolumePath));
    exports.Set("queryUsnJournal", Napi::Function::New(env, QueryUsnJournal));
    exports.Set("getUsnJournalInfo", Napi::Function::New(env, GetUsnJournalInfo));
    exports.Set("crc32", Napi::Function::New(env, Crc32));
    exports.Set("createSnapshot", Napi::Function::New(env, CreateSnapshot));
    exports.Set("deleteSnapshot", Napi::Function::New(env, DeleteSnapshot));
    exports.Set("readBlocks", Napi::Function::New(env, ReadBlocks));
    exports.Set("writeBlocks", Napi::Function::New(env, WriteBlocks));
    exports.Set("openImageForWrite", Napi::Function::New(env, OpenImageForWrite));
    return exports;
}

NODE_API_MODULE(opbs_native, Init)
