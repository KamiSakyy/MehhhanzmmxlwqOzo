// ============================================================================
//  JNI-мост: com.mehhanz.engine.crypto.NativeCrypto
//
//  КЛЮЧ ОТ .c-МОДУЛЕЙ ЖИВЁТ ТОЛЬКО ЗДЕСЬ — внутри libmmxsec.so.
//  Java (и DEX) могут открывать/закрывать модули, но не знают ключа:
//  он собирается на стеке на время операции и затирается после.
// ============================================================================
#include <jni.h>
#include <android/log.h>
#include <cstring>
#include <vector>
#include <string>

#include "mmx_crypto.h"
#include "mmx_keys_generated.h"

#define MMX_LOG_TAG "MMXSEC"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, MMX_LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, MMX_LOG_TAG, __VA_ARGS__)

namespace {

// Ключ собирается из трёх обфусцированных кусков. Живёт только на стеке.
struct StackKey {
    uint8_t bytes[32];
    StackKey() {
        for (int i = 0; i < 32; ++i)
            bytes[i] = (uint8_t)(MMX_K_ENC[i] ^ MMX_K_MASK1[i] ^ MMX_K_MASK2[i]);
    }
    ~StackKey() {
        volatile uint8_t* p = bytes;
        for (int i = 0; i < 32; ++i) p[i] = 0;
    }
    const uint8_t* data() const { return bytes; }
};

void throwSecurity(JNIEnv* env, const char* msg) {
    jclass cls = env->FindClass("java/lang/SecurityException");
    if (cls) env->ThrowNew(cls, msg);
}

jbyteArray toByteArray(JNIEnv* env, const uint8_t* data, size_t len) {
    jbyteArray arr = env->NewByteArray((jsize)len);
    if (!arr) return nullptr;
    env->SetByteArrayRegion(arr, 0, (jsize)len, reinterpret_cast<const jbyte*>(data));
    return arr;
}

bool readArray(JNIEnv* env, jbyteArray arr, std::vector<uint8_t>& out) {
    if (!arr) return false;
    jsize n = env->GetArrayLength(arr);
    out.resize((size_t)n);
    if (n > 0) env->GetByteArrayRegion(arr, 0, n, reinterpret_cast<jbyte*>(out.data()));
    return true;
}

} // namespace

extern "C" {

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM*, void*) {
    LOGI("libmmxsec загружена, сборка %s (run %u)", MMX_BUILD_TAG, MMX_BUILD_RUN);
    return JNI_VERSION_1_6;
}

JNIEXPORT jboolean JNICALL
Java_com_mehhanz_engine_crypto_NativeCrypto_selfTest(JNIEnv*, jclass) {
    static const uint8_t want[32] = {
        0xba,0x78,0x16,0xbf,0x8f,0x01,0xcf,0xea,0x41,0x41,0x40,0xde,0x5d,0xae,0x22,0x23,
        0xb0,0x03,0x61,0xa3,0x96,0x17,0x7a,0x9c,0xb4,0x10,0xff,0x61,0xf2,0x00,0x15,0xad
    };
    uint8_t got[32];
    mmx::sha256(reinterpret_cast<const uint8_t*>("abc"), 3, got);
    bool ok = (memcmp(got, want, 32) == 0);

    uint8_t key[32], iv[16], pt[32], ct[48], rt[48];
    for (int i = 0; i < 32; ++i) key[i] = (uint8_t)i;
    for (int i = 0; i < 16; ++i) iv[i] = (uint8_t)(i * 3);
    for (int i = 0; i < 32; ++i) pt[i] = (uint8_t)(255 - i);
    size_t ctLen = 0, rtLen = 0;
    ok = ok && mmx::aes256_cbc_encrypt(key, iv, pt, 32, ct, sizeof(ct), &ctLen);
    ok = ok && mmx::aes256_cbc_decrypt(key, iv, ct, ctLen, rt, sizeof(rt), &rtLen);
    ok = ok && (rtLen == 32) && (memcmp(pt, rt, 32) == 0);
    return ok ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_com_mehhanz_engine_crypto_NativeCrypto_buildTag(JNIEnv* env, jclass) {
    return env->NewStringUTF(MMX_BUILD_TAG);
}

JNIEXPORT jbyteArray JNICALL
Java_com_mehhanz_engine_crypto_NativeCrypto_keyFingerprint(JNIEnv* env, jclass) {
    StackKey key;
    uint8_t fp[32];
    mmx::sha256(key.data(), 32, fp);
    return toByteArray(env, fp, 32);
}

JNIEXPORT jboolean JNICALL
Java_com_mehhanz_engine_crypto_NativeCrypto_verifySigner(JNIEnv* env, jclass, jbyteArray certSha) {
    if (!certSha || env->GetArrayLength(certSha) != 32) return JNI_FALSE;
    uint8_t got[32];
    env->GetByteArrayRegion(certSha, 0, 32, reinterpret_cast<jbyte*>(got));
    bool same = (memcmp(got, MMX_SIGNER_SHA256, 32) == 0);
    if (!same) LOGE("печать подписи не совпала — переупакованный APK");
    return same ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jbyteArray JNICALL
Java_com_mehhanz_engine_crypto_NativeCrypto_sealModule(JNIEnv* env, jclass, jbyteArray plain) {
    std::vector<uint8_t> data;
    if (!readArray(env, plain, data)) return nullptr;
    StackKey key;
    std::vector<uint8_t> out(mmx::envelope_overhead(data.size()) + 64);
    size_t n = mmx::envelope_seal(key.data(), data.data(), data.size(), out.data(), out.size());
    if (!n) { throwSecurity(env, "MMX: не удалось запечатать модуль"); return nullptr; }
    return toByteArray(env, out.data(), n);
}

JNIEXPORT jbyteArray JNICALL
Java_com_mehhanz_engine_crypto_NativeCrypto_openModule(JNIEnv* env, jclass, jbyteArray envelope) {
    std::vector<uint8_t> envData;
    if (!readArray(env, envelope, envData)) return nullptr;
    StackKey key;
    std::vector<uint8_t> plain(envData.size() + 64);
    size_t plainLen = 0;
    if (!mmx::envelope_open(key.data(), envData.data(), envData.size(),
                            plain.data(), plain.size(), &plainLen)) {
        throwSecurity(env, "MMX: модуль .c повреждён или ключ не подходит");
        return nullptr;
    }
    return toByteArray(env, plain.data(), plainLen);
}

} // extern "C"
