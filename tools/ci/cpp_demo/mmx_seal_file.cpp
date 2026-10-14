// Утилита: запечатать произвольный файл в конверт MMXC (ключ — аргумент или случайный).
#include "mmx_crypto.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
int main(int argc, char** argv) {
    if (argc < 3) { printf("usage: mmx_seal_file <in> <out> [keyhex]\n"); return 1; }
    FILE* f = fopen(argv[1], "rb");
    if (!f) { printf("не открыт %s\n", argv[1]); return 2; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    std::vector<uint8_t> in(n);
    if (n && fread(in.data(), 1, n, f) != (size_t)n) return 2;
    fclose(f);
    uint8_t key[32];
    if (argc >= 4) {
        for (int i = 0; i < 32; ++i) key[i] = (uint8_t)strtol(std::string(argv[3] + i*2, 2).c_str(), nullptr, 16);
    } else if (!mmx::random_bytes(key, 32)) return 3;
    std::vector<uint8_t> env(mmx::envelope_overhead(in.size()) + 64);
    size_t envLen = mmx::envelope_seal(key, in.data(), in.size(), env.data(), env.size());
    if (!envLen) { printf("ошибка запечатывания\n"); return 4; }
    FILE* o = fopen(argv[2], "wb");
    if (!o) return 2;
    fwrite(env.data(), 1, envLen, o); fclose(o);
    if (argc < 4) { for (int i = 0; i < 32; ++i) printf("%02x", key[i]); printf("\n"); }
    fprintf(stderr, "[seal] %ld -> %zu байт\n", n, envLen);
    return 0;
}
