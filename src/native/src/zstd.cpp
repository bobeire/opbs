// N-API wrapper exposing libzstd's simple compression API to JS.
//
// Compiled together with the vendored libzstd sources (src/native/vendor/zstd)
// into opbs_native.node. Used by image-format.ts as the fast native path for
// COMPRESSION_ZSTD, with the pure-JS zstdify/fzstd codecs as fallback.

#include <napi.h>
#include <vector>
#include <new>
#define ZSTD_STATIC_LINKING_ONLY
#include "zstd.h"
#include "zstd_errors.h"

namespace {

// Compress a Buffer with a zstd level (clamped to the valid 1..22 range).
Napi::Value ZstdCompress(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "zstdCompress expects a Buffer").ThrowAsJavaScriptException();
        return env.Null();
    }
    Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
    int level = 3;
    if (info.Length() > 1 && info[1].IsNumber()) {
        level = info[1].As<Napi::Number>().Int32Value();
    }
    if (level < 1) level = 1;
    if (level > 22) level = 22;

    const uint8_t* data = buf.Data();
    const size_t size = buf.Length();

    size_t bound = ZSTD_compressBound(size);
    if (ZSTD_isError(bound)) {
        Napi::Error::New(env, std::string("zstd compressBound failed: ") + ZSTD_getErrorName(bound)).ThrowAsJavaScriptException();
        return env.Null();
    }

    std::vector<uint8_t> out(bound);
    size_t written = ZSTD_compress(out.data(), out.size(), data, size, level);
    if (ZSTD_isError(written)) {
        Napi::Error::New(env, std::string("zstd compress failed: ") + ZSTD_getErrorName(written)).ThrowAsJavaScriptException();
        return env.Null();
    }

    return Napi::Buffer<uint8_t>::Copy(env, out.data(), written);
}

// Decompress a zstd frame. `maxOutput` (optional) is the caller's expected
// output size; used as a capacity hint and also guards against a decompression
// bomb when the frame header omits the content size.
Napi::Value ZstdDecompress(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "zstdDecompress expects a Buffer").ThrowAsJavaScriptException();
        return env.Null();
    }
    Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
    const uint8_t* data = buf.Data();
    const size_t size = buf.Length();

    uint64_t expected = 0;
    if (info.Length() > 1 && info[1].IsNumber()) {
        const int64_t n = info[1].As<Napi::Number>().Int64Value();
        if (n > 0) expected = static_cast<uint64_t>(n);
    }

    // Prefer the exact content size from the frame header when available.
    size_t capacity = 0;
    const unsigned long long csz = ZSTD_getFrameContentSize(data, size);
    if (csz != ZSTD_CONTENTSIZE_UNKNOWN && csz != ZSTD_CONTENTSIZE_ERROR && csz > 0) {
        capacity = static_cast<size_t>(csz);
    }
    // Otherwise use the decompressed-size upper bound.
    if (capacity == 0) {
        const unsigned long long bound = ZSTD_decompressBound(data, size);
        if (!ZSTD_isError(bound) && bound > 0) {
            capacity = static_cast<size_t>(bound);
        }
    }
    if (expected > capacity) capacity = static_cast<size_t>(expected);
    // Absolute bomb guard: never trust a frame header implicitly beyond this.
    if (capacity == 0) capacity = 64 * 1024;
    if (capacity > (size_t)1 << 31) {
        Napi::Error::New(env, "zstd decompress size exceeds the 2 GiB block limit").ThrowAsJavaScriptException();
        return env.Null();
    }

    for (int attempt = 0; attempt < 8; attempt++) {
        std::vector<uint8_t> out(capacity);
        size_t written = ZSTD_decompress(out.data(), out.size(), data, size);
        if (!ZSTD_isError(written)) {
            return Napi::Buffer<uint8_t>::Copy(env, out.data(), written);
        }
        const ZSTD_ErrorCode code = ZSTD_getErrorCode(written);
        if (code == ZSTD_error_dstSize_tooSmall && capacity < ((size_t)1 << 31)) {
            capacity *= 2;
            continue;
        }
        Napi::Error::New(env, std::string("zstd decompress failed: ") + ZSTD_getErrorName(written)).ThrowAsJavaScriptException();
        return env.Null();
    }
    Napi::Error::New(env, "zstd decompress: output capacity grew past the limit").ThrowAsJavaScriptException();
    return env.Null();
}

Napi::Value ZstdCompressBound(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "zstdCompressBound expects a number").ThrowAsJavaScriptException();
        return env.Null();
    }
    const size_t size = static_cast<size_t>(info[0].As<Napi::Number>().Int64Value());
    return Napi::Number::New(env, static_cast<double>(ZSTD_compressBound(size)));
}

}  // namespace

Napi::Object RegisterZstd(Napi::Env env, Napi::Object exports) {
    exports.Set("zstdCompress", Napi::Function::New(env, ZstdCompress));
    exports.Set("zstdDecompress", Napi::Function::New(env, ZstdDecompress));
    exports.Set("zstdCompressBound", Napi::Function::New(env, ZstdCompressBound));
    return exports;
}