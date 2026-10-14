// Кросс-проверка: C++ открывает модуль, зашифрованный Java(JCE), и шифрует свой.
#include "mmx_crypto.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
static std::string dir;
static std::vector<uint8_t> readFile(const std::string& p, bool* ok = nullptr) {
    std::vector<uint8_t> v; FILE* f = fopen(p.c_str(), "rb");
    if (!f) { if (ok) *ok = false; return v; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    v.resize(n); size_t got = n ? fread(v.data(), 1, n, f) : 0; fclose(f);
    if (ok) *ok = (got == (size_t)n); return v;
}
static void writeAll(const std::string& p, const void* d, size_t n) {
    FILE* f = fopen(p.c_str(), "wb"); if (!f) { std::printf("[FAIL] не пишется %s\n", p.c_str()); exit(2); }
    fwrite(d, 1, n, f); fclose(f);
}
int main(int argc, char** argv) {
    if (argc < 2) { std::printf("usage: mmx_cross_test <dir>\n"); return 1; }
    dir = argv[1];
    int fails = 0;
    auto keyHex = readFile(dir + "/key.hex"); keyHex.push_back(0);
    uint8_t key[32];
    for (int i = 0; i < 32; ++i) key[i] = (uint8_t)strtol(std::string((char*)keyHex.data() + i * 2, 2).c_str(), nullptr, 16);
    bool ok = false;
    auto plain = readFile(dir + "/plain.bin", &ok);
    if (!ok) { std::printf("[FAIL] нет plain.bin\n"); return 2; }
    auto env = readFile(dir + "/env.bin", &ok);
    if (!ok) { std::printf("[FAIL] нет env.bin (не запустили Java seal?)\n"); return 2; }
    std::printf("  конверт Java: %zu байт, открытый текст: %zu байт\n", env.size(), plain.size());
    std::vector<uint8_t> out(plain.size() + 1024); size_t outLen = 0;
    if (!mmx::envelope_open(key, env.data(), env.size(), out.data(), out.size(), &outLen)) {
        std::printf("  [FAIL] C++ не смог открыть конверт Java\n"); ++fails;
    } else if (outLen != plain.size() || memcmp(out.data(), plain.data(), outLen) != 0) {
        std::printf("  [FAIL] данные после C++-расшифровки не совпали\n"); ++fails;
    } else {
        std::printf("  [OK]   C++ расшифровал конверт Java: байты совпадают\n");
    }
    uint8_t bad[32]; memcpy(bad, key, 32); bad[0] ^= 0xFF;
    size_t tmpLen = 0;
    if (mmx::envelope_open(bad, env.data(), env.size(), out.data(), out.size(), &tmpLen)) {
        std::printf("  [FAIL] C++ принял неверный ключ\n"); ++fails;
    } else std::printf("  [OK]   C++ отверг неверный ключ\n");

    std::vector<uint8_t> jenv(mmx::envelope_overhead(plain.size()) + 64);
    size_t jl = mmx::envelope_seal(key, plain.data(), plain.size(), jenv.data(), jenv.size());
    if (!jl) { std::printf("  [FAIL] C++ не смог запечатать\n"); ++fails; }
    else { writeAll(dir + "/jenv.bin", jenv.data(), jl); std::printf("  [OK]   C++ запечатал модуль (%zu байт) для проверки Java\n", jl); }
    std::printf("=== кросс-тест C++: ошибок %d ===\n", fails);
    return fails ? 1 : 0;
}
