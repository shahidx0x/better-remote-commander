package io.github.shahidx0x.brc.android.storage

import android.content.Context

class AgentPreferences(context: Context) {
    private val prefs = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)

    var relayUrl: String
        get() = prefs.getString(KEY_RELAY_URL, DEFAULT_RELAY_URL).orEmpty()
        set(value) = prefs.edit().putString(KEY_RELAY_URL, value).apply()

    var deviceName: String
        get() = prefs.getString(KEY_DEVICE_NAME, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_DEVICE_NAME, value).apply()

    var agentEnabled: Boolean
        get() = prefs.getBoolean(KEY_AGENT_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_AGENT_ENABLED, value).apply()

    var connectionStatus: String
        get() = prefs.getString(KEY_STATUS, "Stopped").orEmpty()
        set(value) = prefs.edit().putString(KEY_STATUS, value).apply()

    companion object {
        private const val FILE_NAME = "brc_agent_preferences"
        private const val KEY_RELAY_URL = "relay_url"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_AGENT_ENABLED = "agent_enabled"
        private const val KEY_STATUS = "connection_status"

        const val DEFAULT_RELAY_URL = "https://brc.ses-systems.de"
    }
}
