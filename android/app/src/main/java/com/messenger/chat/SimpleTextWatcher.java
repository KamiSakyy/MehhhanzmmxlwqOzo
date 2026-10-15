package com.messenger.chat;

import android.text.Editable;
import android.text.TextWatcher;

/**
 * TextWatcher с пустыми методами по умолчанию, чтобы не писать лишний код.
 */
public abstract class SimpleTextWatcher implements TextWatcher {

    @Override
    public void beforeTextChanged(CharSequence s, int start, int count, int after) {
        // not used
    }

    @Override
    public void onTextChanged(CharSequence s, int start, int before, int count) {
        // override in subclasses
    }

    @Override
    public void afterTextChanged(Editable s) {
        // not used
    }
}
