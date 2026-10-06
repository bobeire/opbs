#include <napi.h>

#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <wincrypt.h>
#include <ncrypt.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "ncrypt.lib")

// EFS EKU / certificate purpose OID used by Data Decryption Fields.
static const char kEfsEkuOid[] = "1.3.6.1.4.1.311.10.3.4";

struct RawExportBuffer {
    std::vector<BYTE> bytes;
};

static DWORD CALLBACK RawExportCallback(PBYTE pbData, PVOID pvCallbackContext,
                                        ULONG ulLength) {
    auto* out = static_cast<RawExportBuffer*>(pvCallbackContext);
    if (!out || !pbData) return ERROR_INVALID_PARAMETER;
    out->bytes.insert(out->bytes.end(), pbData, pbData + ulLength);
    return ERROR_SUCCESS;
}

static std::string NarrowPath(const std::wstring& wide) {
    if (wide.empty()) return std::string();
    int len = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), (int)wide.size(),
                                  nullptr, 0, nullptr, nullptr);
    if (len <= 0) return std::string();
    std::string out((size_t)len, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), (int)wide.size(), &out[0],
                        len, nullptr, nullptr);
    return out;
}

static std::string HresultMessage(DWORD code) {
    char* buf = nullptr;
    DWORD n = FormatMessageA(FORMAT_MESSAGE_ALLOCATE_BUFFER |
                                 FORMAT_MESSAGE_FROM_SYSTEM |
                                 FORMAT_MESSAGE_IGNORE_INSERTS,
                             nullptr, code, 0, (LPSTR)&buf, 0, nullptr);
    std::string msg;
    if (n && buf) {
        msg.assign(buf, n);
        while (!msg.empty() && (msg.back() == '\r' || msg.back() == '\n' ||
                                msg.back() == ' '))
            msg.pop_back();
        LocalFree(buf);
    } else {
        char tmp[32];
        snprintf(tmp, sizeof(tmp), "error 0x%08lX", (unsigned long)code);
        msg = tmp;
    }
    return msg;
}

static void Throw(Napi::Env env, const std::string& what) {
    Napi::Error::New(env, what).ThrowAsJavaScriptException();
}

/**
 * readEncryptedRaw(filePath) -> Buffer
 *
 * Export a live EFS file with ReadEncryptedFileRaw(). The returned buffer is
 * the raw encrypted stream exactly as Windows stores it for backup/restore
 * (metadata + ciphertext). This is only usable against a mounted NTFS volume
 * in the running system; images are decrypted through the parsed $EFS/$DATA
 * attributes instead.
 */
static Napi::Value ReadEncryptedRaw(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Throw(env, "readEncryptedRaw(filePath): path required");
        return env.Undefined();
    }
    std::u16string widePath = info[0].As<Napi::String>().Utf16Value();
    std::wstring path(widePath.begin(), widePath.end());

    PVOID context = nullptr;
    DWORD err = OpenEncryptedFileRawW(path.c_str(), 0, &context);
    if (err != ERROR_SUCCESS) {
        Throw(env, "OpenEncryptedFileRaw failed: " + HresultMessage(err));
        return env.Undefined();
    }

    RawExportBuffer out;
    err = ReadEncryptedFileRaw(RawExportCallback, &out, context);
    CloseEncryptedFileRaw(context);
    if (err != ERROR_SUCCESS) {
        Throw(env, "ReadEncryptedFileRaw failed: " + HresultMessage(err));
        return env.Undefined();
    }
    return Napi::Buffer<BYTE>::Copy(env, out.bytes.data(), out.bytes.size());
}

static bool HexToBytes(const std::string& hex, std::vector<BYTE>* out) {
    if (hex.size() % 2 != 0) return false;
    out->clear();
    out->reserve(hex.size() / 2);
    for (size_t i = 0; i < hex.size(); i += 2) {
        auto nib = [&](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        int hi = nib(hex[i]), lo = nib(hex[i + 1]);
        if (hi < 0 || lo < 0) return false;
        out->push_back((BYTE)((hi << 4) | lo));
    }
    return true;
}

static void BytesToHex(const BYTE* data, size_t len, std::string* out) {
    static const char* d = "0123456789abcdef";
    out->clear();
    out->reserve(len * 2);
    for (size_t i = 0; i < len; i++) {
        out->push_back(d[data[i] >> 4]);
        out->push_back(d[data[i] & 0x0f]);
    }
}

/**
 * unwrapEfsFek(thumbprintHex, efek) -> Buffer
 *
 * Unwrap a file's encrypted FEK (EFEK) with the owning user's private key.
 * The certificate is located by SHA-1 thumbprint in the current user's MY
 * store; the key itself is DPAPI-protected and is opened through
 * CryptAcquireCertificatePrivateKey(), which transparently unprotects it.
 *
 * The EFEK is stored byte-reversed (little-endian MPI), so it is reversed
 * before the RSA private-key operation. PKCS#1 v1.5 type 2 padding is
 * removed by the CryptoAPI/CNG call itself.
 */
static Napi::Value UnwrapEfsFek(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsBuffer()) {
        Throw(env, "unwrapEfsFek(thumbprintHex, efek) requires both arguments");
        return env.Undefined();
    }

    std::string thumbHex = info[0].As<Napi::String>().Utf8Value();
    std::vector<BYTE> thumbprint;
    if (!HexToBytes(thumbHex, &thumbprint) || thumbprint.size() != 20) {
        Throw(env, "unwrapEfsFek: thumbprint must be 40 hex characters");
        return env.Undefined();
    }

    Napi::Buffer<BYTE> efekBuf = info[1].As<Napi::Buffer<BYTE>>();
    std::vector<BYTE> efek(efekBuf.Data(), efekBuf.Data() + efekBuf.Length());
    std::reverse(efek.begin(), efek.end());

    HCERTSTORE store = CertOpenStore(CERT_STORE_PROV_SYSTEM_W, 0, 0,
                                     CERT_SYSTEM_STORE_CURRENT_USER |
                                         CERT_STORE_READONLY_FLAG,
                                     L"MY");
    if (!store) {
        Throw(env, "CertOpenStore(MY) failed: " + HresultMessage(GetLastError()));
        return env.Undefined();
    }

    CRYPT_HASH_BLOB hashBlob;
    hashBlob.cbData = (DWORD)thumbprint.size();
    hashBlob.pbData = thumbprint.data();

    PCCERT_CONTEXT cert = CertFindCertificateInStore(
        store, X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, 0, CERT_FIND_SHA1_HASH,
        &hashBlob, nullptr);
    if (!cert) {
        CertCloseStore(store, 0);
        Throw(env, "unwrapEfsFek: no certificate with thumbprint " + thumbHex +
                       " in the current user's MY store");
        return env.Undefined();
    }

    DWORD keySpec = 0;
    BOOL freeKey = FALSE;
    HCRYPTPROV_OR_NCRYPT_KEY_HANDLE keyHandle = 0;
    DWORD acqFlags = CRYPT_ACQUIRE_PREFER_NCRYPT_KEY_FLAG |
                     CRYPT_ACQUIRE_SILENT_FLAG;
    if (!CryptAcquireCertificatePrivateKey(cert, acqFlags, nullptr, &keyHandle,
                                           &keySpec, &freeKey)) {
        DWORD e = GetLastError();
        CertFreeCertificateContext(cert);
        CertCloseStore(store, 0);
        Throw(env, "CryptAcquireCertificatePrivateKey failed: " +
                       HresultMessage(e));
        return env.Undefined();
    }

    Napi::Value result = env.Undefined();
    if (keySpec == CERT_NCRYPT_KEY_SPEC) {
        auto key = (NCRYPT_KEY_HANDLE)keyHandle;
        DWORD outLen = 0;
        SECURITY_STATUS st =
            NCryptDecrypt(key, efek.data(), (DWORD)efek.size(), nullptr, nullptr,
                          0, &outLen, BCRYPT_PAD_PKCS1);
        if (st == ERROR_SUCCESS || st == NTE_BUFFER_TOO_SMALL) {
            std::vector<BYTE> plain(outLen, 0);
            DWORD written = 0;
            st = NCryptDecrypt(key, efek.data(), (DWORD)efek.size(), nullptr,
                               plain.data(), (DWORD)plain.size(), &written,
                               BCRYPT_PAD_PKCS1);
            if (st == ERROR_SUCCESS) {
                plain.resize(written);
                result = Napi::Buffer<BYTE>::Copy(env, plain.data(),
                                                  plain.size());
            }
        }
        if (result.IsUndefined()) {
            Throw(env, std::string("NCryptDecrypt failed: ") +
                           HresultMessage((DWORD)st));
        }
        if (freeKey) NCryptFreeObject(key);
    } else {
        auto key = (HCRYPTPROV_OR_NCRYPT_KEY_HANDLE)keyHandle;
        // pbBuffer must be at least as large as the RSA modulus; the input
        // length handed to CryptDecrypt is exactly the wrapped FEK size.
        size_t capacity = efek.size() > 4096 ? efek.size() : 4096;
        std::vector<BYTE> plain(capacity, 0);
        memcpy(plain.data(), efek.data(), efek.size());
        DWORD len = (DWORD)efek.size();
        if (CryptDecrypt((HCRYPTKEY)key, 0, TRUE, 0, plain.data(), &len)) {
            plain.resize(len);
            result = Napi::Buffer<BYTE>::Copy(env, plain.data(), plain.size());
        } else {
            Throw(env, std::string("CryptDecrypt failed: ") +
                           HresultMessage(GetLastError()));
        }
        if (freeKey) CryptReleaseContext((HCRYPTPROV)key, 0);
    }

    CertFreeCertificateContext(cert);
    CertCloseStore(store, 0);
    return result;
}

static bool HasEfsEku(PCCERT_CONTEXT cert) {
    BOOL found = FALSE;
    DWORD size = 0;
    if (!CertGetEnhancedKeyUsage(cert, 0, nullptr, &size)) {
        DWORD e = GetLastError();
        if (e == CRYPT_E_NOT_FOUND) return true;  // no EKU = unrestricted
        return false;
    }
    std::vector<BYTE> buf(size);
    if (!CertGetEnhancedKeyUsage(cert, 0, (PCERT_ENHKEY_USAGE)buf.data(),
                                 &size))
        return false;
    auto* usage = (PCERT_ENHKEY_USAGE)buf.data();
    for (DWORD i = 0; i < usage->cUsageIdentifier; i++) {
        if (strcmp(usage->rgpszUsageIdentifier[i], kEfsEkuOid) == 0) {
            found = TRUE;
            break;
        }
    }
    return found == TRUE;
}

/**
 * listEfsKeyCerts() -> [{ thumbprint, subject, hasPrivateKey, hasEfsEku }]
 *
 * Enumerate certificates in the current user's MY store. Used to report which
 * local identities can unwrap EFEKs (and to pick a test certificate).
 */
static Napi::Value ListEfsKeyCerts(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);

    HCERTSTORE store = CertOpenStore(CERT_STORE_PROV_SYSTEM_W, 0, 0,
                                     CERT_SYSTEM_STORE_CURRENT_USER |
                                         CERT_STORE_READONLY_FLAG,
                                     L"MY");
    if (!store) {
        Throw(env, "CertOpenStore(MY) failed: " + HresultMessage(GetLastError()));
        return env.Undefined();
    }

    PCCERT_CONTEXT cert = nullptr;
    uint32_t index = 0;
    while ((cert = CertFindCertificateInStore(
                store, X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, 0,
                CERT_FIND_ANY, nullptr, cert)) != nullptr) {
        DWORD hashSize = 0;
        std::string thumb;
        std::vector<BYTE> hash(20, 0);
        hashSize = (DWORD)hash.size();
        if (CertGetCertificateContextProperty(cert, CERT_SHA1_HASH_PROP_ID,
                                              hash.data(), &hashSize))
            BytesToHex(hash.data(), hash.size(), &thumb);

        HCRYPTPROV_OR_NCRYPT_KEY_HANDLE probeHandle = 0;
        DWORD probeSpec = 0;
        BOOL probeFree = FALSE;
        BOOL hasKey = CryptAcquireCertificatePrivateKey(
            cert, CRYPT_ACQUIRE_SILENT_FLAG | CRYPT_ACQUIRE_PREFER_NCRYPT_KEY_FLAG,
            nullptr, &probeHandle, &probeSpec, &probeFree);
        if (hasKey) {
            if (probeSpec == CERT_NCRYPT_KEY_SPEC) {
                if (probeFree) NCryptFreeObject((NCRYPT_KEY_HANDLE)probeHandle);
            } else if (probeFree) {
                CryptReleaseContext((HCRYPTPROV)probeHandle, 0);
            }
        }
        Napi::Boolean hasKeyVal = Napi::Boolean::New(env, hasKey == TRUE);

        Napi::Object entry = Napi::Object::New(env);
        entry.Set("thumbprint", Napi::String::New(env, thumb));
        std::string subject = NarrowPath(L"");
        {
            DWORD chars =
                CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0,
                                   nullptr, nullptr, 0);
            if (chars > 1) {
                std::wstring w(chars - 1, L'\0');
                CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0,
                                   nullptr, &w[0], chars);
                subject = NarrowPath(w);
            }
        }
        entry.Set("subject", Napi::String::New(env, subject));
        entry.Set("hasPrivateKey", hasKeyVal);
        entry.Set("hasEfsEku", Napi::Boolean::New(env, HasEfsEku(cert)));
        result.Set(index++, entry);
    }
    CertCloseStore(store, 0);
    return result;
}

void RegisterEfs(Napi::Env env, Napi::Object exports) {
    exports.Set("readEncryptedRaw", Napi::Function::New(env, ReadEncryptedRaw));
    exports.Set("unwrapEfsFek", Napi::Function::New(env, UnwrapEfsFek));
    exports.Set("listEfsKeyCerts", Napi::Function::New(env, ListEfsKeyCerts));
}
