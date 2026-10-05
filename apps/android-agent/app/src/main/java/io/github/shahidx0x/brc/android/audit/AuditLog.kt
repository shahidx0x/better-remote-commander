package io.github.shahidx0x.brc.android.audit

import android.content.Context
import org.json.JSONObject
import java.io.File

class AuditLog(context: Context) {
    private val file = File(context.applicationContext.filesDir, "brc-audit.jsonl")

    @Synchronized
    fun append(
        event: String,
        details: Map<String, Any?> = emptyMap(),
    ) {
        rotateIfNeeded()
        val json = JSONObject()
            .put("timestampMs", System.currentTimeMillis())
            .put("event", event)
        details.forEach { (key, value) ->
            json.put(key, JSONObject.wrap(value))
        }
        file.appendText(json.toString() + "\n", Charsets.UTF_8)
    }

    @Synchronized
    fun read(limit: Int = 200): List<Map<String, Any?>> {
        if (!file.exists()) return emptyList()
        val safeLimit = limit.coerceIn(1, 1000)
        return file.readLines(Charsets.UTF_8)
            .takeLast(safeLimit)
            .mapNotNull(::parseLine)
    }

    @Synchronized
    fun clear() {
        file.delete()
    }

    private fun parseLine(line: String): Map<String, Any?> =
        runCatching {
            val json = JSONObject(line)
            json.keys().asSequence().associateWith { key ->
                val value = json.get(key)
                if (value == JSONObject.NULL) null else value
            }
        }.getOrNull() ?: emptyMap()

    private fun rotateIfNeeded() {
        if (!file.exists() || file.length() < MAX_BYTES) return
        val backup = File(file.parentFile, "brc-audit.previous.jsonl")
        if (backup.exists()) backup.delete()
        file.renameTo(backup)
    }

    companion object {
        private const val MAX_BYTES = 1_048_576L
    }
}
