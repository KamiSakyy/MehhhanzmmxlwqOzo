package com.messenger.chat;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.textfield.TextInputEditText;

/**
 * Экран входа: имя пользователя + адрес сервера.
 * Данные сохраняются в SharedPreferences.
 */
public class LoginActivity extends AppCompatActivity {

    private TextInputEditText usernameInput;
    private TextInputEditText serverInput;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        setContentView(R.layout.activity_login);

        usernameInput = findViewById(R.id.usernameInput);
        serverInput = findViewById(R.id.serverInput);
        MaterialButton loginButton = findViewById(R.id.loginButton);

        loginButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                tryLogin();
            }
        });

        // Edge-to-edge: отступ под системные панели
        View root = findViewById(R.id.loginRoot);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            int base = (int) (24 * getResources().getDisplayMetrics().density);
            v.setPadding(v.getPaddingLeft(), bars.top + base, v.getPaddingRight(), bars.bottom + base);
            return windowInsets;
        });
    }

    private void tryLogin() {
        String username = textOf(usernameInput).trim();
        String server = textOf(serverInput).trim();

        if (username.length() < 2) {
            toast("Введите имя (минимум 2 символа)");
            return;
        }
        if (username.length() > 24) {
            username = username.substring(0, 24);
        }
        if (server.isEmpty()) {
            toast("Введите адрес сервера");
            return;
        }

        SharedPreferences prefs = getSharedPreferences("messenger_prefs", MODE_PRIVATE);
        prefs.edit()
                .putString("username", username)
                .putString("server_url", server)
                .apply();

        startActivity(new Intent(this, MainActivity.class));
        finish();
    }

    private static String textOf(TextInputEditText input) {
        return input.getText() == null ? "" : input.getText().toString();
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }
}
