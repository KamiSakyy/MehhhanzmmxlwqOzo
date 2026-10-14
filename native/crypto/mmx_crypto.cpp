// ============================================================================
//  MMX CRYPTO — реализация. См. mmx_crypto.h
//  Никаких внешних зависимостей: только C++17 std.
// ============================================================================
#include "mmx_crypto.h"

#include <cstring>
#include <cstdio>
#include <ctime>

namespace mmx {

// ---------------------------------------------------------------------------
//  SHA-256
// ---------------------------------------------------------------------------
namespace {
struct Sha256Ctx {
    uint32_t h[8];
    uint64_t len;
    uint8_t buf[64];
    size_t buflen;
};

const uint32_t K256[64] = {
    0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
    0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
    0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
    0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
    0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
    0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
    0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
    0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
};

inline uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

void sha256_block(Sha256Ctx& c, const uint8_t* p) {
    uint32_t w[64];
    for (int i = 0; i < 16; ++i) {
        w[i] = (uint32_t)p[i * 4] << 24 | (uint32_t)p[i * 4 + 1] << 16 |
               (uint32_t)p[i * 4 + 2] << 8 | (uint32_t)p[i * 4 + 3];
    }
    for (int i = 16; i < 64; ++i) {
        uint32_t s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >> 3);
        uint32_t s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >> 10);
        w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    uint32_t a=c.h[0],b=c.h[1],cc=c.h[2],d=c.h[3],e=c.h[4],f=c.h[5],g=c.h[6],hh=c.h[7];
    for (int i = 0; i < 64; ++i) {
        uint32_t S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
        uint32_t ch = (e & f) ^ ((~e) & g);
        uint32_t t1 = hh + S1 + ch + K256[i] + w[i];
        uint32_t S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
        uint32_t maj = (a & b) ^ (a & cc) ^ (b & cc);
        uint32_t t2 = S0 + maj;
        hh=g; g=f; f=e; e=d+t1; d=cc; cc=b; b=a; a=t1+t2;
    }
    c.h[0]+=a; c.h[1]+=b; c.h[2]+=cc; c.h[3]+=d;
    c.h[4]+=e; c.h[5]+=f; c.h[6]+=g; c.h[7]+=hh;
}

void sha256_init(Sha256Ctx& c) {
    c.h[0]=0x6a09e667u; c.h[1]=0xbb67ae85u; c.h[2]=0x3c6ef372u; c.h[3]=0xa54ff53au;
    c.h[4]=0x510e527fu; c.h[5]=0x9b05688cu; c.h[6]=0x1f83d9abu; c.h[7]=0x5be0cd19u;
    c.len = 0; c.buflen = 0;
}

void sha256_update(Sha256Ctx& c, const uint8_t* p, size_t len) {
    c.len += len;
    while (len > 0) {
        size_t take = 64 - c.buflen;
        if (take > len) take = len;
        std::memcpy(c.buf + c.buflen, p, take);
        c.buflen += take; p += take; len -= take;
        if (c.buflen == 64) { sha256_block(c, c.buf); c.buflen = 0; }
    }
}

void sha256_final(Sha256Ctx& c, uint8_t out[32]) {
    uint64_t bits = c.len * 8;
    uint8_t pad = 0x80;
    sha256_update(c, &pad, 1);
    uint8_t zero = 0x00;
    while (c.buflen != 56) sha256_update(c, &zero, 1);
    uint8_t lenb[8];
    for (int i = 0; i < 8; ++i) lenb[i] = (uint8_t)(bits >> (56 - i * 8));
    sha256_update(c, lenb, 8);
    for (int i = 0; i < 8; ++i) {
        out[i*4]   = (uint8_t)(c.h[i] >> 24);
        out[i*4+1] = (uint8_t)(c.h[i] >> 16);
        out[i*4+2] = (uint8_t)(c.h[i] >> 8);
        out[i*4+3] = (uint8_t)(c.h[i]);
    }
}
} // namespace

void sha256(const uint8_t* data, size_t len, uint8_t out[32]) {
    Sha256Ctx c; sha256_init(c);
    if (len && data) sha256_update(c, data, len);
    sha256_final(c, out);
}

void hmac_sha256(const uint8_t* key, size_t keyLen,
                 const uint8_t* msg, size_t msgLen, uint8_t out[32]) {
    uint8_t k[64];
    std::memset(k, 0, sizeof(k));
    if (keyLen > 64) sha256(key, keyLen, k);
    else std::memcpy(k, key, keyLen);

    uint8_t ipad[64], opad[64];
    for (int i = 0; i < 64; ++i) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5C; }

    Sha256Ctx inner; sha256_init(inner);
    sha256_update(inner, ipad, 64);
    if (msgLen && msg) sha256_update(inner, msg, msgLen);
    uint8_t ih[32]; sha256_final(inner, ih);

    Sha256Ctx outer; sha256_init(outer);
    sha256_update(outer, opad, 64);
    sha256_update(outer, ih, 32);
    sha256_final(outer, out);
    std::memset(k, 0, sizeof(k));
    std::memset(ipad, 0, sizeof(ipad));
    std::memset(opad, 0, sizeof(opad));
}

// ---------------------------------------------------------------------------
//  AES-256
// ---------------------------------------------------------------------------
namespace {

const uint8_t SBOX[256] = {
0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16 };

uint8_t INV_SBOX[256];
bool invReady = false;

const uint8_t RCON[15] = {0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36,0x6c,0xd8,0xab,0x4d,0x9a};

void init_inv_sbox() {
    if (invReady) return;
    for (int i = 0; i < 256; ++i) INV_SBOX[SBOX[i]] = (uint8_t)i;
    invReady = true;
}

inline uint8_t xtime(uint8_t x) { return (uint8_t)((x << 1) ^ ((x >> 7) * 0x1b)); }
inline uint8_t gmul(uint8_t a, uint8_t b) {
    uint8_t p = 0;
    while (b) {
        if (b & 1) p ^= a;
        a = xtime(a);
        b >>= 1;
    }
    return p;
}

void add_round_key(uint8_t s[16], const uint8_t* rk) {
    for (int i = 0; i < 16; ++i) s[i] ^= rk[i];
}

void sub_bytes(uint8_t s[16]) { for (int i = 0; i < 16; ++i) s[i] = SBOX[s[i]]; }
void inv_sub_bytes(uint8_t s[16]) { init_inv_sbox(); for (int i = 0; i < 16; ++i) s[i] = INV_SBOX[s[i]]; }

void shift_rows(uint8_t s[16]) {
    uint8_t t[16];
    // состояния хранятся по столбцам: s[c*4+r]
    for (int c = 0; c < 4; ++c)
        for (int r = 0; r < 4; ++r)
            t[c*4 + r] = s[((c + r) & 3) * 4 + r];
    std::memcpy(s, t, 16);
}

void inv_shift_rows(uint8_t s[16]) {
    uint8_t t[16];
    for (int c = 0; c < 4; ++c)
        for (int r = 0; r < 4; ++r)
            t[c*4 + r] = s[((c - r + 4) & 3) * 4 + r];
    std::memcpy(s, t, 16);
}

void mix_columns(uint8_t s[16]) {
    for (int c = 0; c < 4; ++c) {
        uint8_t* col = s + c * 4;
        uint8_t a0 = col[0], a1 = col[1], a2 = col[2], a3 = col[3];
        col[0] = (uint8_t)(xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3);
        col[1] = (uint8_t)(a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3);
        col[2] = (uint8_t)(a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3));
        col[3] = (uint8_t)((xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3));
    }
}

void inv_mix_columns(uint8_t s[16]) {
    for (int c = 0; c < 4; ++c) {
        uint8_t* col = s + c * 4;
        uint8_t a0 = col[0], a1 = col[1], a2 = col[2], a3 = col[3];
        col[0] = (uint8_t)(gmul(a0,14) ^ gmul(a1,11) ^ gmul(a2,13) ^ gmul(a3,9));
        col[1] = (uint8_t)(gmul(a0,9) ^ gmul(a1,14) ^ gmul(a2,11) ^ gmul(a3,13));
        col[2] = (uint8_t)(gmul(a0,13) ^ gmul(a1,9) ^ gmul(a2,14) ^ gmul(a3,11));
        col[3] = (uint8_t)(gmul(a0,11) ^ gmul(a1,13) ^ gmul(a2,9) ^ gmul(a3,14));
    }
}

} // namespace

void aes256_key_expand(const uint8_t key[32], uint8_t rk[240]) {
    std::memcpy(rk, key, 32);
    int bytes = 32, rconIdx = 0;
    uint8_t t[4];
    while (bytes < 240) {
        std::memcpy(t, rk + bytes - 4, 4);
        if (bytes % 32 == 0) {
            uint8_t x = t[0];
            t[0] = (uint8_t)(SBOX[t[1]] ^ RCON[rconIdx++]);
            t[1] = SBOX[t[2]];
            t[2] = SBOX[t[3]];
            t[3] = SBOX[x];
        } else if (bytes % 32 == 16) {
            for (int i = 0; i < 4; ++i) t[i] = SBOX[t[i]];
        }
        std::memcpy(rk + bytes, rk + bytes - 32, 4);
        for (int i = 0; i < 4; ++i) rk[bytes + i] ^= t[i];
        bytes += 4;
    }
}

void aes256_encrypt_block(const uint8_t key[32], const uint8_t in[16], uint8_t out[16]) {
    uint8_t rk[240];
    aes256_key_expand(key, rk);
    uint8_t s[16];
    std::memcpy(s, in, 16);
    add_round_key(s, rk);
    for (int r = 1; r <= 13; ++r) {
        sub_bytes(s);
        shift_rows(s);
        mix_columns(s);
        add_round_key(s, rk + r * 16);
    }
    sub_bytes(s);
    shift_rows(s);
    add_round_key(s, rk + 14 * 16);
    std::memcpy(out, s, 16);
    std::memset(rk, 0, sizeof(rk));
    std::memset(s, 0, sizeof(s));
}

void aes256_decrypt_block(const uint8_t key[32], const uint8_t in[16], uint8_t out[16]) {
    uint8_t rk[240];
    aes256_key_expand(key, rk);
    uint8_t s[16];
    std::memcpy(s, in, 16);
    add_round_key(s, rk + 14 * 16);
    for (int r = 13; r >= 1; --r) {
        inv_shift_rows(s);
        inv_sub_bytes(s);
        add_round_key(s, rk + r * 16);
        inv_mix_columns(s);
    }
    inv_shift_rows(s);
    inv_sub_bytes(s);
    add_round_key(s, rk);
    std::memcpy(out, s, 16);
    std::memset(rk, 0, sizeof(rk));
    std::memset(s, 0, sizeof(s));
}

bool aes256_cbc_encrypt(const uint8_t key[32], const uint8_t iv[16],
                        const uint8_t* in, size_t inLen,
                        uint8_t* out, size_t outCap, size_t* outLen) {
    size_t pad = 16 - (inLen % 16);
    size_t total = inLen + pad;
    if (total > outCap) return false;
    uint8_t rk[240];
    aes256_key_expand(key, rk);
    uint8_t prev[16];
    std::memcpy(prev, iv, 16);
    uint8_t block[16], enc[16];
    for (size_t off = 0; off < total; off += 16) {
        for (int i = 0; i < 16; ++i) {
            size_t pos = off + i;
            uint8_t p = pos < inLen ? in[pos] : (uint8_t)pad;
            block[i] = (uint8_t)(p ^ prev[i]);
        }
        // шифруем блок с уже развёрнутым ключом
        uint8_t s[16];
        std::memcpy(s, block, 16);
        add_round_key(s, rk);
        for (int r = 1; r <= 13; ++r) { sub_bytes(s); shift_rows(s); mix_columns(s); add_round_key(s, rk + r * 16); }
        sub_bytes(s); shift_rows(s); add_round_key(s, rk + 14 * 16);
        std::memcpy(enc, s, 16);
        std::memcpy(out + off, enc, 16);
        std::memcpy(prev, enc, 16);
    }
    std::memset(rk, 0, sizeof(rk));
    if (outLen) *outLen = total;
    return true;
}

bool aes256_cbc_decrypt(const uint8_t key[32], const uint8_t iv[16],
                        const uint8_t* in, size_t inLen,
                        uint8_t* out, size_t outCap, size_t* outLen) {
    if (inLen == 0 || inLen % 16 != 0) return false;
    if (inLen > outCap) return false;
    uint8_t rk[240];
    aes256_key_expand(key, rk);
    uint8_t prev[16];
    std::memcpy(prev, iv, 16);
    uint8_t s[16], dec[16];
    for (size_t off = 0; off < inLen; off += 16) {
        uint8_t ct[16];
        std::memcpy(ct, in + off, 16);
        std::memcpy(s, ct, 16);
        add_round_key(s, rk + 14 * 16);
        for (int r = 13; r >= 1; --r) { inv_shift_rows(s); inv_sub_bytes(s); add_round_key(s, rk + r*16); inv_mix_columns(s); }
        inv_shift_rows(s); inv_sub_bytes(s); add_round_key(s, rk);
        for (int i = 0; i < 16; ++i) dec[i] = (uint8_t)(s[i] ^ prev[i]);
        std::memcpy(out + off, dec, 16);
        std::memcpy(prev, ct, 16);
    }
    uint8_t pad = out[inLen - 1];
    if (pad == 0 || pad > 16) { std::memset(rk, 0, sizeof(rk)); return false; }
    for (size_t i = 0; i < pad; ++i)
        if (out[inLen - 1 - i] != pad) { std::memset(rk, 0, sizeof(rk)); return false; }
    if (outLen) *outLen = inLen - pad;
    std::memset(rk, 0, sizeof(rk));
    return true;
}

// ---------------------------------------------------------------------------
//  Вывод ключей (HKDF-Expand, RFC 5869)
// ---------------------------------------------------------------------------
namespace {
void hkdf_expand(const uint8_t prk[32], const uint8_t* info, size_t infoLen,
                 uint8_t counter, uint8_t out[32]) {
    uint8_t buf[64];
    size_t n = 0;
    std::memcpy(buf, info, infoLen);
    n = infoLen;
    buf[n++] = counter;
    hmac_sha256(prk, 32, buf, n, out);
    std::memset(buf, 0, sizeof(buf));
}
} // namespace

void mmx_derive_keys(const uint8_t ikm[32], const uint8_t salt[16],
                     uint8_t outKenc[32], uint8_t outKmac[32]) {
    static const uint8_t INFO_ENC[] = {'M','M','X','-','K','E','N','C'};
    uint8_t prk[32];
    hmac_sha256(salt, 16, ikm, 32, prk);
    uint8_t kenc[32];
    hkdf_expand(prk, INFO_ENC, sizeof(INFO_ENC), 0x01, kenc);
    uint8_t infoMac[32 + sizeof(INFO_ENC)];
    std::memcpy(infoMac, kenc, 32);
    std::memcpy(infoMac + 32, INFO_ENC, sizeof(INFO_ENC));
    hkdf_expand(prk, infoMac, sizeof(infoMac), 0x02, outKmac);
    std::memcpy(outKenc, kenc, 32);
    std::memset(prk, 0, sizeof(prk));
    std::memset(kenc, 0, sizeof(kenc));
    std::memset(infoMac, 0, sizeof(infoMac));
}

void mmx_chunk_key(const uint8_t kenc[32], const uint8_t kmac[32],
                   uint32_t chunkIndex, uint8_t outKey[32]) {
    uint8_t buf[32 + sizeof(uint32_t)];
    std::memcpy(buf, kenc, 32);
    buf[32] = (uint8_t)(chunkIndex);
    buf[33] = (uint8_t)(chunkIndex >> 8);
    buf[34] = (uint8_t)(chunkIndex >> 16);
    buf[35] = (uint8_t)(chunkIndex >> 24);
    hmac_sha256(kmac, 32, buf, sizeof(buf), outKey);
    std::memset(buf, 0, sizeof(buf));
}

// ---------------------------------------------------------------------------
//  Base64
// ---------------------------------------------------------------------------
namespace {
const char B64C[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int b64_val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}
} // namespace

size_t base64_encode(const uint8_t* in, size_t len, char* out, size_t outCap) {
    size_t need = ((len + 2) / 3) * 4;
    if (!out || outCap < need + 1) return 0;
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        size_t rem = len - i;
        uint32_t v = (uint32_t)in[i] << 16;
        if (rem > 1) v |= (uint32_t)in[i+1] << 8;
        if (rem > 2) v |= (uint32_t)in[i+2];
        out[o++] = B64C[(v >> 18) & 63];
        out[o++] = B64C[(v >> 12) & 63];
        out[o++] = rem > 1 ? B64C[(v >> 6) & 63] : '=';
        out[o++] = rem > 2 ? B64C[v & 63] : '=';
    }
    out[o] = '\0';
    return o;
}

bool base64_decode(const char* in, size_t len, uint8_t* out, size_t outCap, size_t* outLen) {
    size_t o = 0;
    int quad[4]; int qn = 0;
    for (size_t i = 0; i < len; ++i) {
        char c = in[i];
        if (c == '\r' || c == '\n' || c == ' ' || c == '\t') continue;
        if (c == '=') { quad[qn++] = -2; }
        else {
            int v = b64_val(c);
            if (v < 0) return false;
            quad[qn++] = v;
        }
        if (qn == 4) {
            if (quad[0] < 0 || quad[1] < 0) return false;
            if (outCap < o + 3) return false;
            out[o++] = (uint8_t)((quad[0] << 2) | (quad[1] >> 4));
            if (quad[2] != -2) {
                out[o++] = (uint8_t)(((quad[1] & 15) << 4) | (quad[2] >> 2));
                if (quad[3] != -2)
                    out[o++] = (uint8_t)(((quad[2] & 3) << 6) | quad[3]);
            }
            qn = 0;
        }
    }
    if (qn != 0) return false;
    if (outLen) *outLen = o;
    return true;
}

// ---------------------------------------------------------------------------
//  Случайные байты
// ---------------------------------------------------------------------------
bool random_bytes(uint8_t* out, size_t len) {
    std::FILE* f = std::fopen("/dev/urandom", "rb");
    if (f) {
        size_t got = std::fread(out, 1, len, f);
        std::fclose(f);
        if (got == len) return true;
    }
    // fallback (не для прода, только чтобы не падать)
    uint64_t seed = (uint64_t)std::time(nullptr) ^ (uint64_t)(size_t)out;
    for (size_t i = 0; i < len; ++i) {
        seed = seed * 6364136223846793005ULL + 1442695040888963407ULL;
        out[i] = (uint8_t)(seed >> 33);
    }
    return false;
}

// ---------------------------------------------------------------------------
//  Конверт MMXC
// ---------------------------------------------------------------------------
namespace {
inline void put_u32(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
inline uint32_t get_u32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
inline void put_u16(uint8_t* p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
inline uint16_t get_u16(const uint8_t* p) { return (uint16_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8)); }

const size_t HEADER = 4 + 1 + 1 + 2 + 16 + 4;          // 28
const size_t REC_OVERHEAD = 16 + 4 + 16;               // iv + len + mac
} // namespace

size_t envelope_overhead(size_t plainLen) {
    size_t chunks = (plainLen + MMX_CHUNK_SIZE - 1) / MMX_CHUNK_SIZE;
    if (chunks == 0) chunks = 1;
    size_t ct = 0;
    size_t left = plainLen;
    for (size_t i = 0; i < chunks; ++i) {
        size_t cl = left > MMX_CHUNK_SIZE ? MMX_CHUNK_SIZE : left;
        ct += ((cl + 15) / 16) * 16 + 16;
        left -= cl;
    }
    return HEADER + ct + chunks * 20 + MMX_FILEMAC_SIZE;
}

size_t envelope_seal(const uint8_t masterKey[32], const uint8_t* plain, size_t plainLen,
                     uint8_t* out, size_t outCap) {
    if (!out || plainLen > MMX_MAX_ENVELOPE) return 0;
    size_t need = envelope_overhead(plainLen);
    if (need > outCap) return 0;

    uint8_t salt[MMX_SALT_SIZE];
    if (!random_bytes(salt, sizeof(salt))) return 0;
    uint8_t kenc[32], kmac[32];
    mmx_derive_keys(masterKey, salt, kenc, kmac);

    size_t chunks = (plainLen + MMX_CHUNK_SIZE - 1) / MMX_CHUNK_SIZE;
    if (chunks == 0) chunks = 1;

    std::memcpy(out, "MMXC", 4);
    out[4] = 0x01; out[5] = 0x00;
    put_u16(out + 6, (uint16_t)chunks);
    std::memcpy(out + 8, salt, 16);
    put_u32(out + 24, (uint32_t)plainLen);

    size_t o = HEADER;
    size_t left = plainLen;
    uint8_t tmp[MMX_CHUNK_SIZE + 32];
    for (size_t i = 0; i < chunks; ++i) {
        size_t cl = left > MMX_CHUNK_SIZE ? MMX_CHUNK_SIZE : left;
        uint8_t iv[16];
        if (!random_bytes(iv, 16)) { std::memset(kenc,0,32); std::memset(kmac,0,32); return 0; }
        uint8_t ck[32];
        mmx_chunk_key(kenc, kmac, (uint32_t)i, ck);
        size_t ctLen = 0;
        if (!aes256_cbc_encrypt(ck, iv, plain + (plainLen - left), cl, tmp, sizeof(tmp), &ctLen)) {
            std::memset(kenc,0,32); std::memset(kmac,0,32); std::memset(ck,0,32); return 0;
        }
        uint8_t mac[32];
        hmac_sha256(ck, 32, tmp, ctLen, mac);
        std::memcpy(out + o, iv, 16); o += 16;
        put_u32(out + o, (uint32_t)ctLen); o += 4;
        std::memcpy(out + o, tmp, ctLen); o += ctLen;
        std::memcpy(out + o, mac, MMX_MAC_SIZE); o += MMX_MAC_SIZE;
        std::memset(ck, 0, sizeof(ck));
        std::memset(mac, 0, sizeof(mac));
        left -= cl;
    }
    uint8_t fmac[32];
    hmac_sha256(kmac, 32, out, o, fmac);
    std::memcpy(out + o, fmac, MMX_FILEMAC_SIZE); o += MMX_FILEMAC_SIZE;

    std::memset(kenc, 0, 32);
    std::memset(kmac, 0, 32);
    std::memset(tmp, 0, sizeof(tmp));
    return o;
}

bool envelope_open(const uint8_t masterKey[32], const uint8_t* env, size_t envLen,
                   uint8_t* out, size_t outCap, size_t* outLen) {
    if (!env || envLen < HEADER + MMX_FILEMAC_SIZE) return false;
    if (std::memcmp(env, "MMXC", 4) != 0) return false;
    if (env[4] != 0x01) return false;
    uint16_t chunks = get_u16(env + 6);
    uint32_t plainLen = get_u32(env + 24);
    if (plainLen > MMX_MAX_ENVELOPE || plainLen > outCap) return false;
    if (chunks == 0 || chunks > 1024) return false;

    const uint8_t* salt = env + 8;
    uint8_t kenc[32], kmac[32];
    mmx_derive_keys(masterKey, salt, kenc, kmac);

    const uint8_t* fmacPos = env + envLen - MMX_FILEMAC_SIZE;
    uint8_t fmac[32];
    hmac_sha256(kmac, 32, env, envLen - MMX_FILEMAC_SIZE, fmac);
    if (std::memcmp(fmac, fmacPos, MMX_FILEMAC_SIZE) != 0) {
        std::memset(kenc, 0, 32); std::memset(kmac, 0, 32); return false;
    }

    size_t o = HEADER;
    size_t produced = 0;
    uint8_t tmp[MMX_CHUNK_SIZE + 32];
    for (size_t i = 0; i < chunks; ++i) {
        if (o + REC_OVERHEAD > envLen - MMX_FILEMAC_SIZE) return false;
        const uint8_t* iv = env + o; o += 16;
        uint32_t ctLen = get_u32(env + o); o += 4;
        if (ctLen == 0 || ctLen % 16 != 0 || ctLen > MMX_CHUNK_SIZE + 16) return false;
        if (o + ctLen + MMX_MAC_SIZE > envLen - MMX_FILEMAC_SIZE) return false;
        const uint8_t* ct = env + o; o += ctLen;
        const uint8_t* mac = env + o; o += MMX_MAC_SIZE;

        uint8_t ck[32];
        mmx_chunk_key(kenc, kmac, (uint32_t)i, ck);
        uint8_t calc[32];
        hmac_sha256(ck, 32, ct, ctLen, calc);
        if (std::memcmp(calc, mac, MMX_MAC_SIZE) != 0) { std::memset(ck,0,32); std::memset(kenc,0,32); std::memset(kmac,0,32); return false; }
        size_t ptLen = 0;
        if (!aes256_cbc_decrypt(ck, iv, ct, ctLen, tmp, sizeof(tmp), &ptLen)) {
            std::memset(ck, 0, 32); std::memset(kenc,0,32); std::memset(kmac,0,32); return false;
        }
        if (produced + ptLen > plainLen) { std::memset(ck,0,32); std::memset(kenc,0,32); std::memset(kmac,0,32); return false; }
        std::memcpy(out + produced, tmp, ptLen);
        produced += ptLen;
        std::memset(ck, 0, 32);
    }
    if (produced != plainLen) { std::memset(kenc,0,32); std::memset(kmac,0,32); return false; }
    std::memset(kenc, 0, 32);
    std::memset(kmac, 0, 32);
    if (outLen) *outLen = produced;
    return true;
}

} // namespace mmx
