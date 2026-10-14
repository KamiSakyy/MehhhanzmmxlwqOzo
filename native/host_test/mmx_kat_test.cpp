// KAT: SHA-256 (FIPS 180-4), HMAC-SHA256 (RFC 4231), AES-256 (FIPS-197 / SP 800-38A), конверт MMXC.
#include "mmx_crypto.h"
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>
using namespace mmx;
static int failures = 0, checks = 0;
static std::string tohex(const uint8_t* d, size_t n) {
    static const char* H = "0123456789abcdef"; std::string s;
    for (size_t i = 0; i < n; ++i) { s += H[d[i] >> 4]; s += H[d[i] & 15]; } return s;
}
static void expect_hex(const char* name, const uint8_t* got, size_t n, const char* want) {
    ++checks; std::string g = tohex(got, n);
    if (g == want) std::printf("  [OK]   %s\n", name);
    else { std::printf("  [FAIL] %s\n    got:  %s\n    want: %s\n", name, g.c_str(), want); ++failures; }
}
static void check(const char* name, bool ok) { ++checks; std::printf("  [%s] %s\n", ok ? "OK" : "FAIL", name); if (!ok) ++failures; }
int main() {
    std::printf("=== MMX CRYPTO KAT ===\n");
    {
        uint8_t out[32];
        sha256((const uint8_t*)"abc", 3, out);
        expect_hex("SHA-256(\"abc\")", out, 32, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        sha256((const uint8_t*)"", 0, out);
        expect_hex("SHA-256(\"\")", out, 32, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        std::string m; for (int i = 0; i < 1000; ++i) m.append(1000, 'a');
        sha256((const uint8_t*)m.data(), m.size(), out);
        expect_hex("SHA-256(1e6 x 'a')", out, 32, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    }
    {
        uint8_t out[32], k20[20]; std::memset(k20, 0x0b, 20);
        hmac_sha256(k20, 20, (const uint8_t*)"Hi There", 8, out);
        expect_hex("HMAC RFC4231 TC1", out, 32, "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
        hmac_sha256((const uint8_t*)"Jefe", 4, (const uint8_t*)"what do ya want for nothing?", 28, out);
        expect_hex("HMAC RFC4231 TC2", out, 32, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        uint8_t k131[131]; std::memset(k131, 0xaa, 131); std::string d50(50, (char)0xdd);
        hmac_sha256(k131, 131, (const uint8_t*)d50.data(), 50, out);
        expect_hex("HMAC RFC4231 TC6", out, 32, "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    }
    {
        uint8_t key[32] = {0}, pt[16] = {0}, ct[16];
        aes256_encrypt_block(key, pt, ct);
        expect_hex("AES-256 FIPS-197 C.3", ct, 16, "dc95c078a2408989ad48a21492842087");
        uint8_t rt[16]; aes256_decrypt_block(key, ct, rt);
        check("AES-256 block round-trip", std::memcmp(rt, pt, 16) == 0);
    }
    {
        uint8_t key[32] = { 0x60,0x3d,0xeb,0x10,0x15,0xca,0x71,0xbe,0x2b,0x73,0xae,0xf0,0x85,0x7d,0x77,0x81,
                            0x1f,0x35,0x2c,0x07,0x3b,0x61,0x08,0xd7,0x2d,0x98,0x10,0xa3,0x09,0x14,0xdf,0xf4 };
        uint8_t iv[16]; for (int i = 0; i < 16; ++i) iv[i] = (uint8_t)i;
        uint8_t plain[48] = {
            0x6b,0xc1,0xbe,0xe2,0x2e,0x40,0x9f,0x96,0xe9,0x3d,0x7e,0x11,0x73,0x93,0x17,0x2a,
            0xae,0x2d,0x8a,0x57,0x1e,0x03,0xac,0x9c,0x9e,0xb7,0x6f,0xac,0x45,0xaf,0x8e,0x51,
            0x30,0xc8,0x1c,0x46,0xa3,0x5c,0xe4,0x11,0xe5,0xfb,0xc1,0x19,0x1a,0x0a,0x52,0xef };
        uint8_t out[64]; size_t outLen = 0;
        bool ok = aes256_cbc_encrypt(key, iv, plain, 48, out, sizeof(out), &outLen);
        check("CBC: 48 -> 64 (PKCS#7)", ok && outLen == 64);
        expect_hex("CBC block1 (SP800-38A F.2.5)", out, 16, "f58c4c04d6e5f1ba779eabfb5f7bfbd6");
        expect_hex("CBC block2", out + 16, 16, "9cfc4e967edb808d679f777bc6702c7d");
        uint8_t dec[64]; size_t decLen = 0;
        ok = aes256_cbc_decrypt(key, iv, out, outLen, dec, sizeof(dec), &decLen);
        check("CBC round-trip", ok && decLen == 48 && std::memcmp(dec, plain, 48) == 0);
    }
    {
        uint8_t ikm[32], salt[16], ke1[32], km1[32], ke2[32], km2[32];
        for (int i = 0; i < 32; ++i) ikm[i] = (uint8_t)i;
        for (int i = 0; i < 16; ++i) salt[i] = (uint8_t)(200 - i);
        mmx_derive_keys(ikm, salt, ke1, km1);
        mmx_derive_keys(ikm, salt, ke2, km2);
        check("HKDF детерминирован", std::memcmp(ke1, ke2, 32) == 0 && std::memcmp(km1, km2, 32) == 0);
        check("Kenc != Kmac", std::memcmp(ke1, km1, 32) != 0);
        uint8_t s2[16]; std::memcpy(s2, salt, 16); s2[0] ^= 1;
        mmx_derive_keys(ikm, s2, ke2, km2);
        check("смена соли меняет Kenc", std::memcmp(ke1, ke2, 32) != 0);
        uint8_t c1[32], c2[32], c3[32];
        mmx_chunk_key(ke1, km1, 0, c1); mmx_chunk_key(ke1, km1, 1, c2); mmx_chunk_key(ke1, km1, 0, c3);
        check("ключ чанка уникален", std::memcmp(c1, c2, 32) != 0);
        check("ключ чанка детерминирован", std::memcmp(c1, c3, 32) == 0);
    }
    {
        char b[256]; uint8_t d[256]; size_t dl = 0;
        base64_encode((const uint8_t*)"Hello, MMX!", 11, b, sizeof(b));
        check("base64 encode", std::string(b) == "SGVsbG8sIE1NWCE=");
        check("base64 decode", base64_decode(b, std::strlen(b), d, sizeof(d), &dl) && dl == 11 && std::memcmp(d, "Hello, MMX!", 11) == 0);
    }
    {
        uint8_t key[32]; std::memset(key, 0xA7, 32);
        std::string plain; for (int i = 0; i < 100000; ++i) plain += (char)(i * 31 + 7);
        std::vector<uint8_t> env(envelope_overhead(plain.size()) + 64);
        size_t envLen = envelope_seal(key, (const uint8_t*)plain.data(), plain.size(), env.data(), env.size());
        check("seal: конверт создан", envLen > plain.size());
        check("seal: магия MMXC", std::memcmp(env.data(), "MMXC", 4) == 0);
        std::vector<uint8_t> back(plain.size() + 64); size_t backLen = 0;
        check("open: успешно", envelope_open(key, env.data(), envLen, back.data(), back.size(), &backLen));
        check("open: данные идентичны", backLen == plain.size() && std::memcmp(back.data(), plain.data(), backLen) == 0);
        uint8_t wrong[32]; std::memcpy(wrong, key, 32); wrong[5] ^= 0x11;
        check("open: неверный ключ отвергнут", !envelope_open(wrong, env.data(), envLen, back.data(), back.size(), &backLen));
        std::vector<uint8_t> tam = env; tam[envLen / 2] ^= 0x5A;
        check("open: порча отвергнута", !envelope_open(key, tam.data(), tam.size(), back.data(), back.size(), &backLen));
        std::vector<uint8_t> e0(4096); size_t b0 = 0;
        size_t l0 = envelope_seal(key, (const uint8_t*)"", 0, e0.data(), e0.size());
        check("seal/open пустого модуля", l0 > 0 && envelope_open(key, e0.data(), l0, back.data(), back.size(), &b0) && b0 == 0);
    }
    std::printf("=== KAT: %d проверок, ошибок %d ===\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
