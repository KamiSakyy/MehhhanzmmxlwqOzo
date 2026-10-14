package com.mehhanz.studio.util;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import java.security.MessageDigest;

/** Печать подписи APK: SHA-256 сертификата для нативной проверки. */
public final class SignerInfo {
    private SignerInfo() { }

    public static byte[] certSha256(Context ctx) {
        try {
            PackageManager pm = ctx.getPackageManager();
            PackageInfo pi;
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                pi = pm.getPackageInfo(ctx.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
                if (pi.signingInfo == null) return new byte[32];
                Signature[] sigs = pi.signingInfo.hasMultipleSigners()
                        ? pi.signingInfo.getApkContentsSigners()
                        : pi.signingInfo.getSigningCertificateHistory();
                if (sigs == null || sigs.length == 0) return new byte[32];
                return MessageDigest.getInstance("SHA-256").digest(sigs[0].toByteArray());
            }
            pi = pm.getPackageInfo(ctx.getPackageName(), PackageManager.GET_SIGNATURES);
            if (pi.signatures == null || pi.signatures.length == 0) return new byte[32];
            return MessageDigest.getInstance("SHA-256").digest(pi.signatures[0].toByteArray());
        } catch (Throwable t) {
            return new byte[32];
        }
    }
}
