#include <napi.h>

#include "disk_reader.h"
#include "vss_manager.h"
#include "backup_format.h"
#include "partition_table.h"

void RegisterWinFspMount(Napi::Env env, Napi::Object exports);

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

// Lock + dismount a mounted volume so raw restore writes are not racing FS cache.
Napi::Value LockAndDismountVolume(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "lockAndDismountVolume expects a volume path").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string volumePath = info[0].As<Napi::String>().Utf8Value();
    return Napi::Boolean::New(env, DiskReader::LockAndDismountVolume(volumePath));
}

// Unlock/close volumes held by lockAndDismountVolume.
Napi::Value ReleaseLockedVolumes(const Napi::CallbackInfo& info) {
    DiskReader::ReleaseLockedVolumes();
    return info.Env().Undefined();
}

// Ask Windows to re-read the partition table after a raw restore.
Napi::Value UpdateDiskProperties(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "updateDiskProperties expects a device path").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string devicePath = info[0].As<Napi::String>().Utf8Value();
    return Napi::Boolean::New(env, DiskReader::UpdateDiskProperties(devicePath));
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

void CloseAllHandles(const Napi::CallbackInfo& /*info*/) {
    DiskReader::CloseAllHandles();
}

// ---------------------------------------------------------------------------
// Async I/O workers — run in libuv thread pool, freeing the event loop.
// ---------------------------------------------------------------------------

class AsyncReadWorker : public Napi::AsyncWorker {
public:
    AsyncReadWorker(Napi::Env env, std::string devicePath, int64_t offset, int64_t length)
        : Napi::AsyncWorker(env),
          m_devicePath(std::move(devicePath)),
          m_offset(offset),
          m_length(length),
          m_deferred(Napi::Promise::Deferred::New(env)) {}

    Napi::Promise::Deferred& Deferred() { return m_deferred; }

    void Execute() override {
        try {
            m_data = DiskReader::ReadBlocks(m_devicePath, m_offset, m_length);
        } catch (const std::exception& e) {
            SetError(e.what());
        }
    }

    void OnOK() override {
        auto buf = Napi::Buffer<char>::Copy(Env(), m_data.data(), m_data.size());
        m_deferred.Resolve(buf);
    }

    void OnError(const Napi::Error& error) override {
        m_deferredReject(error.Value());
    }

private:
    void m_deferredReject(const Napi::Value& err) {
        m_deferred.Reject(err);
    }

    std::string m_devicePath;
    int64_t m_offset;
    int64_t m_length;
    std::vector<char> m_data;
    Napi::Promise::Deferred m_deferred;
};

class AsyncWriteWorker : public Napi::AsyncWorker {
public:
    AsyncWriteWorker(Napi::Env env, std::string devicePath, uint64_t offset,
                     const char* data, size_t length)
        : Napi::AsyncWorker(env),
          m_devicePath(std::move(devicePath)),
          m_offset(offset),
          m_data(data, data + length),
          m_deferred(Napi::Promise::Deferred::New(env)) {}

    Napi::Promise::Deferred& Deferred() { return m_deferred; }

    void Execute() override {
        try {
            m_written = DiskReader::WriteBlocks(m_devicePath, m_offset,
                                                 m_data.data(), m_data.size());
        } catch (const std::exception& e) {
            SetError(e.what());
        }
    }

    void OnOK() override {
        m_deferred.Resolve(Napi::Number::New(Env(), static_cast<double>(m_written)));
    }

    void OnError(const Napi::Error& error) override {
        m_deferred.Reject(error.Value());
    }

private:
    std::string m_devicePath;
    uint64_t m_offset;
    std::vector<char> m_data; // copy of JS buffer — safe to use in worker thread
    uint64_t m_written = 0;
    Napi::Promise::Deferred m_deferred;
};

// Async readBlocks — returns a Promise<Buffer>.
Napi::Value ReadBlocksAsync(const Napi::CallbackInfo& info) {
    std::string devicePath = info[0].As<Napi::String>().Utf8Value();
    bool lossless = false;
    int64_t offset = info[1].As<Napi::BigInt>().Int64Value(&lossless);
    int64_t length = info[2].As<Napi::BigInt>().Int64Value(&lossless);

    auto* worker = new AsyncReadWorker(info.Env(), devicePath, offset, length);
    auto promise = worker->Deferred().Promise();
    worker->Queue();
    return promise;
}

// Async writeBlocks — returns a Promise<number>.
Napi::Value WriteBlocksAsync(const Napi::CallbackInfo& info) {
    std::string devicePath = info[0].As<Napi::String>().Utf8Value();

    uint64_t offset = 0;
    if (info[1].IsBigInt()) {
        bool lossless = false;
        offset = info[1].As<Napi::BigInt>().Uint64Value(&lossless);
    } else {
        offset = static_cast<uint64_t>(info[1].As<Napi::Number>().Int64Value());
    }

    Napi::Buffer<char> buf = info[2].As<Napi::Buffer<char>>();

    auto* worker = new AsyncWriteWorker(info.Env(), devicePath, offset, buf.Data(), buf.Length());
    auto promise = worker->Deferred().Promise();
    worker->Queue();
    return promise;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    RegisterZstd(env, exports);
    RegisterPartitionTable(env, exports);
    RegisterWinFspMount(env, exports);
    exports.Set("getDisks", Napi::Function::New(env, GetDisks));
    exports.Set("getPartitions", Napi::Function::New(env, GetPartitions));
    exports.Set("getPhysicalDrivePath", Napi::Function::New(env, GetPhysicalDrivePath));
    exports.Set("getVolumePath", Napi::Function::New(env, GetVolumePath));
    exports.Set("lockAndDismountVolume", Napi::Function::New(env, LockAndDismountVolume));
    exports.Set("releaseLockedVolumes", Napi::Function::New(env, ReleaseLockedVolumes));
    exports.Set("updateDiskProperties", Napi::Function::New(env, UpdateDiskProperties));
    exports.Set("queryUsnJournal", Napi::Function::New(env, QueryUsnJournal));
    exports.Set("getUsnJournalInfo", Napi::Function::New(env, GetUsnJournalInfo));
    exports.Set("crc32", Napi::Function::New(env, Crc32));
    exports.Set("createSnapshot", Napi::Function::New(env, CreateSnapshot));
    exports.Set("deleteSnapshot", Napi::Function::New(env, DeleteSnapshot));
    exports.Set("readBlocks", Napi::Function::New(env, ReadBlocks));
    exports.Set("writeBlocks", Napi::Function::New(env, WriteBlocks));
    exports.Set("readBlocksAsync", Napi::Function::New(env, ReadBlocksAsync));
    exports.Set("writeBlocksAsync", Napi::Function::New(env, WriteBlocksAsync));
    exports.Set("openImageForWrite", Napi::Function::New(env, OpenImageForWrite));
    exports.Set("closeAllHandles", Napi::Function::New(env, CloseAllHandles));
    return exports;
}

NODE_API_MODULE(opbs_native, Init)
