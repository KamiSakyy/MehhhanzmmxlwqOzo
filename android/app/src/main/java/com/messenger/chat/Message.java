package com.messenger.chat;

/**
 * Модель одного сообщения в чате.
 */
public class Message {

    public static final int TYPE_RECEIVED = 0;
    public static final int TYPE_SENT = 1;
    public static final int TYPE_SYSTEM = 2;

    public final int type;
    public final String username;
    public final String text;
    public final String time;

    public Message(int type, String username, String text, String time) {
        this.type = type;
        this.username = username;
        this.text = text;
        this.time = time;
    }
}
