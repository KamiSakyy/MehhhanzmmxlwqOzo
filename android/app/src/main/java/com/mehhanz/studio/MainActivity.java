package com.mehhanz.studio;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.mehhanz.engine.crypto.NativeCrypto;

/**
 * Стартовый экран-диагностика MMX Engine.
 * (Полноценная студия подключается на следующем шаге сборки.)
 */
public class MainActivity extends Activity {

    private TextView log;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0D1117"));
        int pad = dp(20);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("MEHHANZ MMX STUDIO");
        title.setTextColor(Color.parseColor("#2ECC71"));
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        title.setGravity(Gravity.CENTER);
        root.addView(title, lp(-1, -2));

        TextView sub = new TextView(this);
        sub.setText("Движок приложений и игр · язык MOCHI · оффлайн-компилятор");
        sub.setTextColor(Color.parseColor("#8B949E"));
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, dp(6), 0, dp(18));
        root.addView(sub, lp(-1, -2));

        log = new TextView(this);
        log.setTextColor(Color.parseColor("#E6EDF3"));
        log.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        log.setTypeface(Typeface.MONOSPACE);
        log.setTextIsSelectable(true);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(log, lp(-1, -2));
        root.addView(scroll, lp(-1, 0, 1f));

        setContentView(root);
        runDiagnostics();
    }

    private void runDiagnostics() {
        StringBuilder sb = new StringBuilder();
        sb.append("Android: ").append(Build.VERSION.RELEASE)
          .append(" (API ").append(Build.VERSION.SDK_INT).append(")\n");
        sb.append("Устройство: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append("\n\n");
        try {
            sb.append("Нативное ядро: ").append(NativeCrypto.buildTag()).append('\n');
            boolean ok = NativeCrypto.selfTest();
            sb.append("Самотест криптоядра: ").append(ok ? "ПРОЙДЕН ✓" : "ОШИБКА ✗").append('\n');
            byte[] fp = NativeCrypto.keyFingerprint();
            sb.append("Отпечаток ключа .c: ");
            for (int i = 0; i < Math.min(16, fp.length); i++) sb.append(String.format("%02x", fp[i]));
            sb.append("…\n");
            sb.append("Проверка печати подписи: ")
              .append(NativeCrypto.verifySigner(com.mehhanz.studio.util.SignerInfo.certSha256(this))
                      ? "совпала ✓" : "не задана ✗").append('\n');
        } catch (Throwable t) {
            sb.append("Нативная библиотека: ОШИБКА ").append(t).append('\n');
        }
        sb.append("\nГотово. Язык MOCHI и компилятор подключаются далее.\n");
        log.setText(sb.toString());
    }

    private LinearLayout.LayoutParams lp(int w, int h) { return new LinearLayout.LayoutParams(w, h); }
    private LinearLayout.LayoutParams lp(int w, int h, float weight) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(w, h);
        p.weight = weight;
        return p;
    }
    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
}
