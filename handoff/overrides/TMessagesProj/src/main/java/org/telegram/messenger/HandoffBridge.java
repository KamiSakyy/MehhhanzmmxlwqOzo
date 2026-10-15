/*
 * НАШ СЕРВЕР вместо MTProto.
 *
 * Это единственный транспорт приложения: все TL-запросы клиента Telegram
 * уходят на наш сервер (HTTPS, /api/tl), все обновления приходят с него же
 * по WebSocket. Ни одного байта на сервера Telegram не отправляется.
 *
 * Формат: запрос = ровно те же TL-байты, которые клиент отдал бы в tgnet;
 * ответ = TL-объект (или RpcError). Обновления = TL_updates / updateShort*.
 */

package org.telegram.messenger;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.TextUtils;

import com.neovisionaries.ws.client.WebSocket;
import com.neovisionaries.ws.client.WebSocketAdapter;
import com.neovisionaries.ws.client.WebSocketException;
import com.neovisionaries.ws.client.WebSocketFactory;
import com.neovisionaries.ws.client.WebSocketFrame;

import org.telegram.tgnet.SerializedData;
import org.telegram.tgnet.TLObject;
import org.telegram.tgnet.TLRPC;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class HandoffBridge {

    public static final String DEFAULT_SERVER = "https://mwmmw-production.up.railway.app";
    public static final String PREF_NAME = "handoff_prefs";

    public interface ResponseCallback {
        void onResult(byte[] response, int errorCode, String errorText);
    }

    private static volatile HandoffBridge instance;
    public static HandoffBridge getInstance() {
        if (instance == null) {
            synchronized (HandoffBridge.class) {
                if (instance == null) instance = new HandoffBridge();
            }
        }
        return instance;
    }

    private String server = DEFAULT_SERVER;
    private String token = "";
    private int account = 0;
    private boolean started = false;

    private WebSocket socket;
    private int reconnectAttempt = 0;
    private final Object socketLock = new Object();

    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

    // ---------------- настройки ----------------
    public void init(Context context) {
        if (context == null) return;
        SharedPreferences prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        server = prefs.getString("server_url", DEFAULT_SERVER);
        token = prefs.getString("token", "");
        if (TextUtils.isEmpty(server)) server = DEFAULT_SERVER;
    }

    public String getServer() {
        return server;
    }

    public void setServer(String value) {
        server = normalizeServer(value);
    }

    public String getToken() {
        return token;
    }

    public void setToken(String value) {
        boolean changed = token == null ? value != null : !token.equals(value);
        token = value == null ? "" : value;
        if (changed) restartSocket();
    }

    public static String normalizeServer(String raw) {
        String s = raw == null ? "" : raw.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (s.isEmpty()) s = DEFAULT_SERVER;
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
        return s;
    }

    public void start(int accountNum) {
        account = accountNum;
        started = true;
        openSocket();
    }

    // ---------------- запросы ----------------
    public void sendRequest(final byte[] request, final ResponseCallback callback) {
        pool.execute(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(server + "/api/tl");
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/x-telegram-tl");
                conn.setRequestProperty("Accept", "application/x-telegram-tl");
                if (!TextUtils.isEmpty(token)) {
                    conn.setRequestProperty("Authorization", "Bearer " + token);
                }
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(60000);
                conn.setDoInput(true);
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(request.length);
                OutputStream os = conn.getOutputStream();
                os.write(request);
                os.flush();
                os.close();

                int code = conn.getResponseCode();
                if (code == 401) {
                    callback.onResult(null, 401, "SESSION_EXPIRED");
                    return;
                }
                InputStream is = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
                byte[] response = is != null ? readAll(is) : new byte[0];
                if (code < 200 || code >= 300) {
                    callback.onResult(null, code, "HTTP_" + code);
                    return;
                }
                if (response.length >= 4) {
                    int magic = (response[0] & 0xff) | ((response[1] & 0xff) << 8) | ((response[2] & 0xff) << 16) | ((response[3] & 0xff) << 24);
                    if (magic == TLRPC.TL_error.constructor) {
                        try {
                            TLRPC.TL_error error = new TLRPC.TL_error();
                            SerializedData data = new SerializedData(response);
                            data.readInt32(true);
                            error.readParams(data, true);
                            data.cleanup();
                            callback.onResult(null, error.code, error.text);
                        } catch (Exception e) {
                            FileLog.e(e);
                            callback.onResult(null, 500, "DESERIALIZE_ERROR");
                        }
                        return;
                    }
                }
                callback.onResult(response, 0, null);
            } catch (Exception e) {
                FileLog.e(e);
                callback.onResult(null, -1000, e.getMessage());
            } finally {
                if (conn != null) {
                    try { conn.disconnect(); } catch (Exception ignore) { }
                }
            }
        });
    }

    private static byte[] readAll(InputStream is) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        try { is.close(); } catch (Exception ignore) { }
        return bos.toByteArray();
    }

    // ---------------- WebSocket ----------------
    private String socketUrl() {
        String base = server;
        if (base.startsWith("https://")) base = "wss://" + base.substring("https://".length());
        else if (base.startsWith("http://")) base = "ws://" + base.substring("http://".length());
        return base + "/ws" + (TextUtils.isEmpty(token) ? "" : "?token=" + token);
    }

    private void openSocket() {
        if (!started) return;
        synchronized (socketLock) {
            try {
                socket = new WebSocketFactory().createSocket(socketUrl(), 15000);
                socket.addListener(new WebSocketAdapter() {
                    @Override
                    public void onConnected(WebSocket websocket, Map<String, List<String>> headers) {
                        if (BuildVars.LOGS_ENABLED) FileLog.d("handoff: ws connected");
                        reconnectAttempt = 0;
                        try {
                            websocket.sendText("{\"type\":\"auth\",\"token\":\"" + token + "\"}");
                        } catch (Exception ignore) { }
                    }

                    @Override
                    public void onTextMessage(WebSocket websocket, String text) {
                        if (BuildVars.LOGS_ENABLED) FileLog.d("handoff: ws text " + text);
                    }

                    @Override
                    public void onBinaryMessage(WebSocket websocket, byte[] binary) {
                        handleBinary(binary);
                    }

                    @Override
                    public void onConnectError(WebSocket websocket, WebSocketException cause) {
                        scheduleReconnect();
                    }

                    @Override
                    public void onError(WebSocket websocket, WebSocketException cause) {
                        scheduleReconnect();
                    }

                    @Override
                    public void onDisconnected(WebSocket websocket, WebSocketFrame serverCloseFrame, WebSocketFrame clientCloseFrame, boolean closedByServer) {
                        scheduleReconnect();
                    }
                });
                socket.connectAsynchronously();
            } catch (Exception e) {
                FileLog.e(e);
                scheduleReconnect();
            }
        }
    }

    private void scheduleReconnect() {
        reconnectAttempt++;
        long delay = Math.min(30000, 1000L * reconnectAttempt);
        try {
            scheduler.schedule(() -> {
                if (!started) return;
                openSocket();
            }, delay, TimeUnit.MILLISECONDS);
        } catch (Exception ignore) { }
    }

    private void restartSocket() {
        try {
            synchronized (socketLock) {
                if (socket != null) {
                    try { socket.disconnect(); } catch (Exception ignore) { }
                    socket = null;
                }
            }
            reconnectAttempt = 0;
            openSocket();
        } catch (Exception e) {
            FileLog.e(e);
        }
    }

    private void handleBinary(byte[] data) {
        try {
            SerializedData stream = new SerializedData(data);
            int constructor = stream.readInt32(true);
            TLObject obj = null;
            if (constructor == TLRPC.TL_updates.constructor) {
                obj = new TLRPC.TL_updates();
            } else if (constructor == TLRPC.TL_updatesCombined.constructor) {
                obj = new TLRPC.TL_updatesCombined();
            } else if (constructor == TLRPC.TL_updateShort.constructor) {
                obj = new TLRPC.TL_updateShort();
            } else if (constructor == TLRPC.TL_updateShortMessage.constructor) {
                obj = new TLRPC.TL_updateShortMessage();
            } else if (constructor == TLRPC.TL_updateShortChatMessage.constructor) {
                obj = new TLRPC.TL_updateShortChatMessage();
            } else if (constructor == TLRPC.TL_updateShortSentMessage.constructor) {
                obj = new TLRPC.TL_updateShortSentMessage();
            }
            if (obj == null) {
                stream.cleanup();
                return;
            }
            obj.readParams(stream, true);
            stream.cleanup();
            if (obj instanceof TLRPC.Updates) {
                final TLRPC.Updates updates = (TLRPC.Updates) obj;
                Utilities.stageQueue.postRunnable(() -> {
                    try {
                        AccountInstance.getInstance(account).getMessagesController().processUpdates(updates, false);
                    } catch (Exception e) {
                        FileLog.e(e);
                    }
                });
            }
        } catch (Exception e) {
            FileLog.e(e);
        }
    }
}
