package com.messenger.chat;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.textfield.TextInputEditText;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Главный экран чата: список сообщений, онлайн-пользователи,
 * индикатор «Печатает…», поле ввода и кнопка отправки.
 */
public class MainActivity extends AppCompatActivity implements ChatSocket.Listener {

    private ChatSocket socket;
    private ChatAdapter adapter;
    private RecyclerView recyclerView;
    private TextInputEditText editText;
    private TextView typingText;
    private MaterialToolbar toolbar;
    private LinearLayout usersContainer;
    private View inputCard;

    private String username;
    private String serverUrl;
    private boolean connected = false;

    private final Set<String> typingUsers = new HashSet<>();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean typingSent = false;
    private long lastTypingSentAt = 0L;

    private final Runnable stopTypingRunnable = new Runnable() {
        @Override
        public void run() {
            if (typingSent) {
                typingSent = false;
                if (socket != null) socket.sendTyping(false);
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        SharedPreferences prefs = getSharedPreferences("messenger_prefs", MODE_PRIVATE);
        username = prefs.getString("username", "");
        serverUrl = prefs.getString("server_url", getString(R.string.default_server_url));

        if (username == null || username.isEmpty()) {
            startActivity(new Intent(this, LoginActivity.class));
            finish();
            return;
        }

        setContentView(R.layout.activity_main);

        toolbar = findViewById(R.id.toolbar);
        recyclerView = findViewById(R.id.recyclerView);
        editText = findViewById(R.id.editText);
        typingText = findViewById(R.id.typingText);
        usersContainer = findViewById(R.id.usersContainer);
        inputCard = findViewById(R.id.inputCard);
        ImageButton sendButton = findViewById(R.id.sendButton);

        toolbar.setTitle(R.string.app_name);

        adapter = new ChatAdapter();
        LinearLayoutManager layoutManager = new LinearLayoutManager(this);
        layoutManager.setStackFromEnd(true);
        recyclerView.setLayoutManager(layoutManager);
        recyclerView.setAdapter(adapter);

        sendButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                sendCurrentMessage();
            }
        });

        editText.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendCurrentMessage();
                return true;
            }
            return false;
        });

        editText.addTextChangedListener(new SimpleTextWatcher() {
            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                handleTyping(s);
            }
        });

        applyInsets();

        socket = new ChatSocket();
        socket.setListener(this);
        socket.connect(serverUrl, username);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (socket != null) socket.disconnect();
        super.onDestroy();
    }

    // ---------- ChatSocket.Listener (вызывается в главном потоке) ----------

    @Override
    public void onConnected() {
        connected = true;
        updateSubtitle();
    }

    @Override
    public void onJoined(String myUsername, List<String> users) {
        username = myUsername;
        updateUsers(users);
        updateSubtitle();
    }

    @Override
    public void onChatMessage(String from, String text, String time) {
        int type = from != null && from.equals(username)
                ? Message.TYPE_SENT
                : Message.TYPE_RECEIVED;
        adapter.addMessage(new Message(type, from, text, time));
        scrollToBottom();
    }

    @Override
    public void onSystemMessage(String text, String time) {
        adapter.addMessage(new Message(Message.TYPE_SYSTEM, "", text, time));
        scrollToBottom();
    }

    @Override
    public void onUsers(List<String> users) {
        updateUsers(users);
        updateSubtitle();
    }

    @Override
    public void onTyping(String from, boolean typing) {
        if (from == null || from.equals(username)) return;
        if (typing) {
            typingUsers.add(from);
        } else {
            typingUsers.remove(from);
        }
        updateTyping();
    }

    @Override
    public void onConnectionLost(String reason) {
        connected = false;
        typingUsers.clear();
        updateTyping();
        updateSubtitle();
    }

    // ---------- UI-хелперы ----------

    private void applyInsets() {
        // Edge-to-edge: отступы под статус-бар и навигационную панель
        View root = findViewById(R.id.chatRoot);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            toolbar.setPadding(toolbar.getPaddingLeft(), bars.top,
                    toolbar.getPaddingRight(), toolbar.getPaddingBottom());
            int bottom = bars.bottom + (int) (8 * getResources().getDisplayMetrics().density);
            inputCard.setPadding(inputCard.getPaddingLeft(), inputCard.getPaddingTop(),
                    inputCard.getPaddingRight(), bottom);
            return windowInsets;
        });
    }

    private void updateSubtitle() {
        if (connected) {
            toolbar.setSubtitle("● Онлайн: " + usersContainer.getChildCount());
            toolbar.setSubtitleTextColor(getColor(R.color.online_green));
        } else {
            toolbar.setSubtitle("● Нет соединения…");
            toolbar.setSubtitleTextColor(getColor(R.color.md_theme_outline));
        }
    }

    private void updateUsers(List<String> users) {
        usersContainer.removeAllViews();
        if (users == null) return;
        float density = getResources().getDisplayMetrics().density;
        int paddingH = (int) (14 * density);
        int paddingV = (int) (6 * density);
        int margin = (int) (8 * density);
        for (String user : users) {
            TextView chip = new TextView(this);
            chip.setText(user.equals(username) ? user + " (вы)" : user);
            chip.setTextSize(13f);
            chip.setTextColor(getColor(R.color.md_theme_onSurface));
            chip.setBackgroundResource(R.drawable.bg_user_chip);
            chip.setPadding(paddingH, paddingV, paddingH, paddingV);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.setMarginEnd(margin);
            chip.setLayoutParams(lp);
            usersContainer.addView(chip);
        }
    }

    private void updateTyping() {
        if (typingUsers.isEmpty()) {
            typingText.setVisibility(View.GONE);
        } else if (typingUsers.size() == 1) {
            typingText.setText("Печатает " + typingUsers.iterator().next() + "…");
            typingText.setVisibility(View.VISIBLE);
        } else {
            typingText.setText("Печатают " + typingUsers.size() + " человек…");
            typingText.setVisibility(View.VISIBLE);
        }
    }

    private void scrollToBottom() {
        int count = adapter.getItemCount();
        if (count > 0) {
            recyclerView.smoothScrollToPosition(count - 1);
        }
    }

    private void handleTyping(CharSequence s) {
        if (socket == null) return;
        boolean hasText = s != null && s.length() > 0;
        long now = System.currentTimeMillis();
        if (hasText && (!typingSent || now - lastTypingSentAt > 3000)) {
            socket.sendTyping(true);
            typingSent = true;
            lastTypingSentAt = now;
        }
        handler.removeCallbacks(stopTypingRunnable);
        handler.postDelayed(stopTypingRunnable, 2500);
    }

    private void sendCurrentMessage() {
        String text = editText.getText() == null ? "" : editText.getText().toString().trim();
        if (text.isEmpty()) return;
        if (!connected) {
            Toast.makeText(this, "Нет соединения с сервером", Toast.LENGTH_SHORT).show();
        }
        socket.sendChat(text);
        editText.setText("");
        typingSent = false;
    }
}
