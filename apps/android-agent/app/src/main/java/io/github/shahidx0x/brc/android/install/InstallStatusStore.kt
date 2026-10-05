package io.github.shahidx0x.brc.android.install

import android.content.Context
import org.json.JSONObject

class InstallStatusStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(
        "brc_install_status",
        Context.MODE_PRIVATE,
    )

    @Synchronized
    fun update(
        sessionId: Int,
        status: Int?,
        state: String,
        message: String? = null,
        packageName: String? = null,
    ) {
        val value = JSONObject()
            .put("sessionId", sessionId)
            .put("status", status)
            .put("state", state)
            .put("message", message)
            .put("packageName", packageName)
            .put("updatedAtMs", System.currentTimeMillis())
        prefs.edit()
            .putString(sessionId.toString(), value.toString())
            .putInt(KEY_LATEST, sessionId)
            .apply()
    }

    fun get(sessionId: Int): Map<String, Any?>? =
        prefs.getString(sessionId.toString(), null)
            ?.let(::parse)

    fun latest(): Map<String, Any?>? {
        val id = prefs.getInt(KEY_LATEST, -1)
        return if (id >= 0) get(id) else null
    }

    fun list(): List<Map<String, Any?>> =
        prefs.all
            .filterKeys { it != KEY_LATEST }
            .values
            .mapNotNull { it as? String }
            .mapNotNull(::parse)
            .sortedByDescending { (it["updatedAtMs"] as? Number)?.toLong() ?: 0L }
            .take(50)

    private fun parse(raw: String): Map<String, Any?>? =
        runCatching {
            val json = JSONObject(raw)
            json.keys().asSequence().associateWith { key ->
                val value = json.get(key)
                if (value == JSONObject.NULL) null else value
            }
        }.getOrNull()

    private companion object {
        const val KEY_LATEST = "_latest"
    }
}
