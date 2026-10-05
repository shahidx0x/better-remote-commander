package io.github.shahidx0x.brc.android.core

import android.content.Context
import android.os.Build
import java.util.UUID

class DeviceIdentityStore(context: Context) {
    private val preferences = context.getSharedPreferences(
        "brc_agent_identity",
        Context.MODE_PRIVATE,
    )

    fun getOrCreateDeviceId(): String {
        val existing = preferences.getString(KEY_DEVICE_ID, null)
        if (!existing.isNullOrBlank()) return existing

        val created = UUID.randomUUID().toString()
        preferences.edit().putString(KEY_DEVICE_ID, created).apply()
        return created
    }

    fun setDeviceId(deviceId: String) {
        require(deviceId.isNotBlank()) { "Device ID must not be blank." }
        preferences.edit().putString(KEY_DEVICE_ID, deviceId).apply()
    }

    fun deviceLabel(): String =
        "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    private companion object {
        const val KEY_DEVICE_ID = "device_id"
    }
}
