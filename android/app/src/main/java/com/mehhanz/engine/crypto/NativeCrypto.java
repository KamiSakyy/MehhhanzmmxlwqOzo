package com.mehhanz.engine.crypto;

/**
 * Мост к нативному ядру libmmxsec.so.
 *
 * Здесь НЕТ ключа: он лежит только внутри .so (обфусцированно), а функции
 * этого класса лишь просят нативную библиотеку открыть/закрыть модуль .c.
 * Ключ собирается на стеке на время операции и сразу затирается.
 */
public final class NativeCrypto {
    static {
        System.loadLibrary("mmxsec");
    }
    private NativeCrypto() { }

    /** Самотест криптоядра (SHA-256 KAT + AES round-trip) внутри .so. */
    public static native boolean selfTest();

    /** Метка сборки, вшитая в .so на этапе CI. */
    public static native String buildTag();

    /** SHA-256 мастер-ключа — только для диагностики. */
    public static native byte[] keyFingerprint();

    /** Проверка печати подписи APK (защита от переупаковки). */
    public static native boolean verifySigner(byte[] certSha256);

    /** Запечатать байткод в конверт .c мастер-ключом из .so. */
    public static native byte[] sealModule(byte[] plain);

    /** Открыть .c-модуль: расшифровка + проверка MAC. */
    public static native byte[] openModule(byte[] envelope);
}
