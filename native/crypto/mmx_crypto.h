// ============================================================================
//  MMX CRYPTO — криптографическое ядро движка (ядро MMX Engine).
//
//  Здесь живут примитивы, которыми закрывается файл модуля `.c`:
//    * SHA-256
//    * HMAC-SHA256
//    * AES-256 (ECB-блок, CBC-режим, PKCS#7)
//    * вывод ключей (HKDF-подобный, RFC 5869-совместимый HKDF-Expand)
//    * Base64
//    * формат конверта MMXC (см. ниже)
//
//  Файл намеренно на 100% платформо-независимый: тот же исходник собирается
//  и в libmmxsec.so для Android (NDK), и в обычный g++-тест в CI, где
//  результаты сверяются с javax.crypto из Java. Так исключены ошибки
//  в реализации «своей» криптографии.
//
//  ФОРМАТ КОНВЕРТА MMXC (little-endian):
//    magic   "MMXC"                4 байта
//    version 0x01                  1 байт
//    flags   0x00                  1 байт
//    chunks  u16                   2 байта
//    salt    16 байт
//    plainLen u32                  4 байта
//    --- далее записи по одной на чанк:
//    iv[16] | ctLen u32 | ct[ctLen] | mac[16]
//    --- в самом конце:
//    fileMac[32]
// ============================================================================
#ifndef MMX_CRYPTO_H
#define MMX_CRYPTO_H

#include <stddef.h>
#include <stdint.h>

namespace mmx {

const size_t MMX_KEY_SIZE = 32;      // AES-256
const size_t MMX_SALT_SIZE = 16;
const size_t MMX_IV_SIZE = 16;
const size_t MMX_MAC_SIZE = 16;      // усечённый HMAC
const size_t MMX_FILEMAC_SIZE = 32;
const size_t MMX_CHUNK_SIZE = 32768; // размер фрагмента байткода
const size_t MMX_MAX_ENVELOPE = 24u * 1024u * 1024u;

// --- хеши ---------------------------------------------------------------
void sha256(const uint8_t* data, size_t len, uint8_t out[32]);
void hmac_sha256(const uint8_t* key, size_t keyLen,
                 const uint8_t* msg, size_t msgLen, uint8_t out[32]);

// --- AES-256 ------------------------------------------------------------
void aes256_key_expand(const uint8_t key[32], uint8_t roundKeys[240]);
void aes256_encrypt_block(const uint8_t key[32], const uint8_t in[16], uint8_t out[16]);
void aes256_decrypt_block(const uint8_t key[32], const uint8_t in[16], uint8_t out[16]);
bool aes256_cbc_encrypt(const uint8_t key[32], const uint8_t iv[16],
                        const uint8_t* in, size_t inLen,
                        uint8_t* out, size_t outCap, size_t* outLen);
bool aes256_cbc_decrypt(const uint8_t key[32], const uint8_t iv[16],
                        const uint8_t* in, size_t inLen,
                        uint8_t* out, size_t outCap, size_t* outLen);

// --- вывод ключей -------------------------------------------------------
// PRK = HMAC(ikm, salt); Kenc = HKDF-Expand(PRK, info, 1);
// Kmac = HKDF-Expand(PRK, Kenc||info, 2)
void mmx_derive_keys(const uint8_t ikm[32], const uint8_t salt[16],
                     uint8_t outKenc[32], uint8_t outKmac[32]);

// Ключ конкретного фрагмента
void mmx_chunk_key(const uint8_t kenc[32], const uint8_t kmac[32],
                   uint32_t chunkIndex, uint8_t outKey[32]);

// --- Base64 -------------------------------------------------------------
size_t base64_encode(const uint8_t* in, size_t len, char* out, size_t outCap);
bool base64_decode(const char* in, size_t len, uint8_t* out, size_t outCap, size_t* outLen);

// --- случайные байты ----------------------------------------------------
bool random_bytes(uint8_t* out, size_t len);

// --- конверт MMXC -------------------------------------------------------
size_t envelope_overhead(size_t plainLen);
size_t envelope_seal(const uint8_t masterKey[32], const uint8_t* plain, size_t plainLen,
                     uint8_t* out, size_t outCap);
bool envelope_open(const uint8_t masterKey[32], const uint8_t* env, size_t envLen,
                   uint8_t* out, size_t outCap, size_t* outLen);

} // namespace mmx

#endif // MMX_CRYPTO_H
