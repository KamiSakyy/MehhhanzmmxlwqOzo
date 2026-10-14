package com.messenger.chat;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * WebSocket-клиент чата на OkHttp.
 * Все колбэки слушателя вызываются в главном (UI) потоке.
 * Есть автоматическое переподключение с экспоненциальной задержкой.
 */
public class ChatSocket {

    public interface Listener {
        void onConnected();

        void onJoined(String username, List<String> users);

        void onChatMessage(String username, String text, String time);

        void onSystemMessage(String text, String time);

        void onUsers(List<String> users);

        void onTyping(String username, boolean typing);

        void onConnectionLost(String reason);
    }

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final OkHttpClient client = new OkHttpClient.Builder()
            .pingInterval(25, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build();

    private Listener listener;
    private WebSocket webSocket;
    private String url;
    private String username;

    private volatile boolean connected = false;
    private volatile boolean closedByUser = false;
    private volatile boolean downNotified = false;
    private int reconnectAttempts = 0;

    private final Runnable reconnectRunnable = new Runnable() {
        @Override
        public void run() {
            openSocket();
        }
    };

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public boolean isConnected() {
        return connected;
    }

    public void connect(String serverUrl, String username) {
        this.url = normalizeUrl(serverUrl);
        this.username = username;
        this.closedByUser = false;
        this.reconnectAttempts = 0;
        openSocket();
    }

    public void disconnect() {
        closedByUser = true;
        connected = false;
        mainHandler.removeCallbacksAndMessages(null);
        closeSocket();
    }

    public void sendChat(String text) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "message");
            json.put("text", text);
            send(json.toString());
        } catch (Exception ignored) {
            // never crash on JSON errors
        }
    }

    public void sendTyping(boolean typing) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "typing");
            json.put("typing", typing);
            send(json.toString());
        } catch (Exception ignored) {
            // never crash on JSON errors
        }
    }

    /**
     * Принимает адрес в любом виде (https://, http://, wss://, ws:// или просто хост)
     * и превращает его в ws/wss URL.
     */
    public static String normalizeUrl(String input) {
        String s = input == null ? "" : input.trim();
        if (s.startsWith("https://")) {
            s = "wss://" + s.substring("https://".length());
        } else if (s.startsWith("http://")) {
            s = "ws://" + s.substring("http://".length());
        } else if (!s.startsWith("ws://") && !s.startsWith("wss://")) {
            s = "wss://" + s;
        }
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    private void send(String payload) {
        WebSocket ws = webSocket;
        if (connected && ws != null) {
            ws.send(payload);
        }
    }

    private void openSocket() {
        if (closedByUser) return;
        closeSocket();
        Request request = new Request.Builder().url(url).build();
        webSocket = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                connected = true;
                downNotified = false;
                reconnectAttempts = 0;
                try {
                    JSONObject join = new JSONObject();
                    join.put("type", "join");
                    join.put("username", username);
                    ws.send(join.toString());
                } catch (Exception ignored) {
                    // never crash on JSON errors
                }
                notifyConnected();
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                handleMessage(text);
            }

            @Override
            public void onClosing(WebSocket ws, int code, String reason) {
                ws.close(1000, null);
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                onSocketDown("Соединение закрыто");
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                String message = t == null ? "Ошибка сети" : String.valueOf(t.getMessage());
                onSocketDown(message);
            }
        });
    }

    private void onSocketDown(String reason) {
        connected = false;
        if (closedByUser) return;
        if (!downNotified) {
            downNotified = true;
            notifyLost(reason);
        }
        scheduleReconnect();
    }

    private void scheduleReconnect() {
        if (closedByUser) return;
        reconnectAttempts++;
        long delay = Math.min(30_000L, 1_000L * (1L << Math.min(reconnectAttempts, 5)));
        mainHandler.removeCallbacks(reconnectRunnable);
        mainHandler.postDelayed(reconnectRunnable, delay);
    }

    private void closeSocket() {
        WebSocket ws = webSocket;
        webSocket = null;
        if (ws != null) {
            try {
                ws.close(1000, "bye");
            } catch (Exception ignored) {
                // ignore
            }
        }
    }

    private void handleMessage(String payload) {
        try {
            JSONObject json = new JSONObject(payload);
            String type = json.optString("type");
            switch (type) {
                case "joined": {
                    final String name = json.optString("username");
                    final List<String> users = toStringList(json.optJSONArray("users"));
                    mainHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            if (listener != null) listener.onJoined(name, users);
                        }
                    });
                    break;
                }
                case "message": {
                    final String from = json.optString("username");
                    final String text = json.optString("text");
                    final String time = json.optString("time");
                    mainHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            if (listener != null) listener.onChatMessage(from, text, time);
                        }
                    });
                    break;
                }
                case "system": {
                    final String text = json.optString("text");
                    final String time = json.optString("time");
                    mainHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            if (listener != null) listener.onSystemMessage(text, time);
                        }
                    });
                    break;
                }
                case "users": {
                    final List<String> users = toStringList(json.optJSONArray("users"));
                    mainHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            if (listener != null) listener.onUsers(users);
                        }
                    });
                    break;
                }
                case "typing": {
                    final String from = json.optString("username");
                    final boolean typing = json.optBoolean("typing");
                    mainHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            if (listener != null) listener.onTyping(from, typing);
                        }
                    });
                    break;
                }
                default:
                    break;
            }
        } catch (Exception ignored) {
            // ignore malformed messages
        }
    }

    private static List<String> toStringList(JSONArray array) {
        List<String> list = new ArrayList<>();
        if (array != null) {
            for (int i = 0; i < array.length(); i++) {
                list.add(array.optString(i));
            }
        }
        return list;
    }

    private void notifyConnected() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (listener != null) listener.onConnected();
            }
        });
    }

    private void notifyLost(final String reason) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (listener != null) listener.onConnectionLost(reason);
            }
        });
    }
}
