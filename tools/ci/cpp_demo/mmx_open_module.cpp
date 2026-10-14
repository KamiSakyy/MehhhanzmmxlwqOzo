// Утилита: открыть .c модуль нативным ядром MMX (как это делает libmmxsec.so).
#include "mmx_crypto.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <string>
static std::vector<uint8_t> readFile(const char* p) {
    std::vector<uint8_t> v; FILE* f = fopen(p, "rb");
    if (!f) { fprintf(stderr, "не открыт %s\n", p); exit(2); }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    v.resize(n); if (fread(v.data(), 1, n, f) != (size_t)n) exit(2); fclose(f); return v;
}
static std::vector<uint8_t> fromHex(const char* h) {
    std::vector<uint8_t> v; size_t n = strlen(h);
    for (size_t i = 0; i + 1 < n; i += 2) v.push_back((uint8_t)strtol(std::string(h + i, 2).c_str(), nullptr, 16));
    return v;
}
int main(int argc, char** argv) {
    if (argc < 3) { printf("usage: mmx_open_module <module.c> <keyhex>\n"); return 1; }
    auto env = readFile(argv[1]);
    auto key = fromHex(argv[2]);
    if (key.size() != 32) { printf("[FAIL] ключ должен быть 32 байта\n"); return 1; }
    std::vector<uint8_t> plain(env.size() + 64); size_t plen = 0;
    if (!mmx::envelope_open(key.data(), env.data(), env.size(), plain.data(), plain.size(), &plen)) {
        printf("[FAIL] MAC/расшифровка не прошли — модуль отвергнут\n"); return 1;
    }
    printf("[OK] модуль открыт: %zu байт байткода (конверт %zu байт)\n", plen, env.size());
    if (plen >= 8) {
        char magic[9] = {0}; memcpy(magic, plain.data(), 8);
        printf("[OK] магия байткода: %.8s\n", magic);
    }
    uint8_t bad[32]; memcpy(bad, key.data(), 32); bad[3] ^= 0x77;
    std::vector<uint8_t> tmp(plain.size());
    if (mmx::envelope_open(bad, env.data(), env.size(), tmp.data(), tmp.size(), &plen)) {
        printf("[FAIL] неверный ключ не был отвергнут!\n"); return 1;
    }
    printf("[OK] неверный ключ отвергнут (защита работает)\n");
    return 0;
}
