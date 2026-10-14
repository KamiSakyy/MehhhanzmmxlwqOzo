package mmxtest;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.SecureRandom;
import java.util.Arrays;

/**
 * Фикстура кросс-проверки Java(JCE) <-> C++ (libmmxsec).
 * Реализует конверт MMXC ровно так же, как native/crypto/mmx_crypto.cpp,
 * чтобы CI мог сравнить результаты двух независимых реализаций.
 *   seal   <dir>  -> key.hex, plain.bin, env.bin
 *   verify <dir>  -> проверяет jenv.bin (зашифрован C++) против plain.bin
 */
public final class CrossSealFixture {
    static final byte[] INFO_ENC = {'M','M','X','-','K','E','N','C'};
    static final int CHUNK = 32768;

    static byte[] le32(int v) { return new byte[]{(byte)v,(byte)(v>>>8),(byte)(v>>>16),(byte)(v>>>24)}; }
    static void putLe32(byte[] a, int off, int v) { a[off]=(byte)v; a[off+1]=(byte)(v>>>8); a[off+2]=(byte)(v>>>16); a[off+3]=(byte)(v>>>24); }
    static int getLe32(byte[] a, int off) { return (a[off]&0xFF)|((a[off+1]&0xFF)<<8)|((a[off+2]&0xFF)<<16)|((a[off+3]&0xFF)<<24); }
    static void putLe16(byte[] a, int off, int v) { a[off]=(byte)v; a[off+1]=(byte)(v>>>8); }
    static int getLe16(byte[] a, int off) { return (a[off]&0xFF)|((a[off+1]&0xFF)<<8); }
    static void u32be(byte[] dst, int off, int v) { dst[off]=(byte)(v>>>24); dst[off+1]=(byte)(v>>>16); dst[off+2]=(byte)(v>>>8); dst[off+3]=(byte)v; }

    static byte[] hmac(byte[] key, byte[]... parts) throws Exception {
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(new SecretKeySpec(key, "HmacSHA256"));
        for (byte[] p : parts) m.update(p);
        return m.doFinal();
    }
    static byte[][] deriveKeys(byte[] ikm, byte[] salt) throws Exception {
        byte[] prk = hmac(salt, ikm);
        byte[] kenc = hmac(prk, concat(INFO_ENC, new byte[]{1}));
        byte[] kmac = hmac(prk, concat(kenc, INFO_ENC, new byte[]{2}));
        return new byte[][]{kenc, kmac};
    }
    static byte[] chunkKey(byte[] kenc, byte[] kmac, int idx) throws Exception {
        return hmac(kmac, concat(kenc, le32(idx)));
    }
    static byte[] concat(byte[]... parts) {
        int n = 0; for (byte[] p : parts) n += p.length;
        byte[] out = new byte[n]; int o = 0;
        for (byte[] p : parts) { System.arraycopy(p, 0, out, o, p.length); o += p.length; }
        return out;
    }
    static byte[] aesCbc(int mode, byte[] key, byte[] iv, byte[] in) throws Exception {
        Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
        c.init(mode, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv));
        return c.doFinal(in);
    }

    static byte[] seal(byte[] key, byte[] plain, byte[] salt) throws Exception {
        byte[][] dk = deriveKeys(key, salt);
        int nChunks = Math.max(1, (plain.length + CHUNK - 1) / CHUNK);
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] header = new byte[28];
        System.arraycopy("MMXC".getBytes("US-ASCII"), 0, header, 0, 4);
        header[4] = 1; header[5] = 0;
        putLe16(header, 6, nChunks);
        System.arraycopy(salt, 0, header, 8, 16);
        putLe32(header, 24, plain.length);
        bos.write(header);
        SecureRandom rnd = new SecureRandom();
        for (int i = 0; i < nChunks; i++) {
            int off = i * CHUNK;
            int len = Math.min(CHUNK, plain.length - off);
            byte[] iv = new byte[16]; rnd.nextBytes(iv);
            byte[] ck = chunkKey(dk[0], dk[1], i);
            byte[] ct = aesCbc(Cipher.ENCRYPT_MODE, ck, iv, Arrays.copyOfRange(plain, off, off + len));
            byte[] mac = Arrays.copyOf(hmac(ck, ct), 16);
            bos.write(iv); bos.write(le32(ct.length)); bos.write(ct); bos.write(mac);
        }
        byte[] body = bos.toByteArray();
        byte[] fileMac = hmac(dk[1], body);
        return concat(body, fileMac);
    }

    static byte[] open(byte[] key, byte[] env) throws Exception {
        if (env.length < 60 || !"MMXC".equals(new String(env, 0, 4, "US-ASCII")) || env[4] != 1) return null;
        int chunks = getLe16(env, 6);
        int plainLen = getLe32(env, 24);
        byte[] salt = Arrays.copyOfRange(env, 8, 24);
        byte[][] dk = deriveKeys(key, salt);
        byte[] fileMac = hmac(dk[1], Arrays.copyOfRange(env, 0, env.length - 32));
        if (!Arrays.equals(fileMac, Arrays.copyOfRange(env, env.length - 32, env.length))) return null;
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        int o = 28;
        for (int i = 0; i < chunks; i++) {
            byte[] iv = Arrays.copyOfRange(env, o, o + 16); o += 16;
            int ctLen = getLe32(env, o); o += 4;
            byte[] ct = Arrays.copyOfRange(env, o, o + ctLen); o += ctLen;
            byte[] mac = Arrays.copyOfRange(env, o, o + 16); o += 16;
            byte[] ck = chunkKey(dk[0], dk[1], i);
            if (!Arrays.equals(Arrays.copyOf(hmac(ck, ct), 16), mac)) return null;
            out.write(aesCbc(Cipher.DECRYPT_MODE, ck, iv, ct));
        }
        byte[] res = out.toByteArray();
        return res.length == plainLen ? res : null;
    }

    public static void main(String[] args) throws Exception {
        String mode = args[0];
        File dir = new File(args[1]); dir.mkdirs();
        if (mode.equals("seal")) {
            byte[] key = new byte[32];
            for (int i = 0; i < 32; i++) key[i] = (byte)(i * 7 + 3);
            byte[] plain = new byte[70000];
            for (int i = 0; i < plain.length; i++) plain[i] = (byte)((i * 13 + (i >> 8)) & 0xFF);
            byte[] salt = new byte[16];
            for (int i = 0; i < 16; i++) salt[i] = (byte)(0xC0 + i);
            Files.write(Paths.get(dir.getPath(), "plain.bin"), plain);
            Files.write(Paths.get(dir.getPath(), "env.bin"), seal(key, plain, salt));
            StringBuilder sb = new StringBuilder();
            for (byte b : key) sb.append(String.format("%02x", b));
            Files.write(Paths.get(dir.getPath(), "key.hex"), sb.toString().getBytes("US-ASCII"));
            System.out.printf("  [OK]   JCE зашифровала модуль: %d байт (было %d)%n", 
                Files.readAllBytes(Paths.get(dir.getPath(), "env.bin")).length, plain.length);
        } else {
            byte[] key = hex(Files.readAllBytes(Paths.get(dir.getPath(), "key.hex")));
            byte[] plain = Files.readAllBytes(Paths.get(dir.getPath(), "plain.bin"));
            byte[] jenv = Files.readAllBytes(Paths.get(dir.getPath(), "jenv.bin"));
            byte[] back = open(key, jenv);
            if (back == null) { System.out.println("  [FAIL] Java не смогла открыть конверт C++"); System.exit(1); }
            if (!Arrays.equals(back, plain)) { System.out.println("  [FAIL] данные C++-конверта не совпали"); System.exit(1); }
            System.out.printf("  [OK]   Java расшифровала конверт C++: %d байт совпали%n", back.length);
            System.out.printf("  [OK]   Java открыла свой конверт: %d байт%n", open(key, Files.readAllBytes(Paths.get(dir.getPath(), "env.bin"))).length);
        }
    }
    static byte[] hex(byte[] h) {
        String s = new String(h).trim();
        byte[] r = new byte[s.length() / 2];
        for (int i = 0; i < r.length; i++) r[i] = (byte)Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        return r;
    }
}
