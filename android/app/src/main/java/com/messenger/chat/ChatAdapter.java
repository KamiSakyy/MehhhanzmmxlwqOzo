package com.messenger.chat;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.google.android.material.card.MaterialCardView;

import java.util.ArrayList;
import java.util.List;

/**
 * Адаптер списка сообщений: три типа — отправленное, полученное и системное.
 */
public class ChatAdapter extends RecyclerView.Adapter<RecyclerView.ViewHolder> {

    private final List<Message> messages = new ArrayList<>();

    public void addMessage(Message message) {
        messages.add(message);
        notifyItemInserted(messages.size() - 1);
    }

    public void clear() {
        messages.clear();
        notifyDataSetChanged();
    }

    @Override
    public int getItemViewType(int position) {
        return messages.get(position).type;
    }

    @NonNull
    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        LayoutInflater inflater = LayoutInflater.from(parent.getContext());
        if (viewType == Message.TYPE_SENT) {
            return new SentHolder(inflater.inflate(R.layout.item_message_sent, parent, false));
        }
        if (viewType == Message.TYPE_SYSTEM) {
            return new SystemHolder(inflater.inflate(R.layout.item_message_system, parent, false));
        }
        return new ReceivedHolder(inflater.inflate(R.layout.item_message_received, parent, false));
    }

    @Override
    public void onBindViewHolder(@NonNull RecyclerView.ViewHolder holder, int position) {
        Message message = messages.get(position);
        if (holder instanceof SentHolder) {
            ((SentHolder) holder).bind(message);
        } else if (holder instanceof SystemHolder) {
            ((SystemHolder) holder).bind(message);
        } else {
            ((ReceivedHolder) holder).bind(message);
        }
    }

    @Override
    public int getItemCount() {
        return messages.size();
    }

    static class SentHolder extends RecyclerView.ViewHolder {
        final TextView text;
        final TextView time;

        SentHolder(@NonNull View itemView) {
            super(itemView);
            text = itemView.findViewById(R.id.messageText);
            time = itemView.findViewById(R.id.messageTime);
        }

        void bind(Message message) {
            text.setText(message.text);
            time.setText(message.time);
        }
    }

    static class ReceivedHolder extends RecyclerView.ViewHolder {
        final TextView username;
        final TextView text;
        final TextView time;

        ReceivedHolder(@NonNull View itemView) {
            super(itemView);
            username = itemView.findViewById(R.id.messageUsername);
            text = itemView.findViewById(R.id.messageText);
            time = itemView.findViewById(R.id.messageTime);
        }

        void bind(Message message) {
            username.setText(message.username);
            text.setText(message.text);
            time.setText(message.time);
        }
    }

    static class SystemHolder extends RecyclerView.ViewHolder {
        final TextView text;

        SystemHolder(@NonNull View itemView) {
            super(itemView);
            text = itemView.findViewById(R.id.messageText);
        }

        void bind(Message message) {
            text.setText(message.text);
        }
    }
}
