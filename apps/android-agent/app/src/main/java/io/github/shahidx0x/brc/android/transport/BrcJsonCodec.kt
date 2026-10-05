package io.github.shahidx0x.brc.android.transport

import io.github.shahidx0x.brc.android.protocol.AgentMessage
import io.github.shahidx0x.brc.android.protocol.CallMessage
import io.github.shahidx0x.brc.android.protocol.ClientInfo
import io.github.shahidx0x.brc.android.protocol.ContentBlock
import io.github.shahidx0x.brc.android.protocol.ErrorMessage
import io.github.shahidx0x.brc.android.protocol.HelloMessage
import io.github.shahidx0x.brc.android.protocol.PingMessage
import io.github.shahidx0x.brc.android.protocol.PongMessage
import io.github.shahidx0x.brc.android.protocol.RelayMessage
import io.github.shahidx0x.brc.android.protocol.ResultMessage
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.protocol.ToolResult
import io.github.shahidx0x.brc.android.protocol.WelcomeMessage
import org.json.JSONArray
import org.json.JSONObject

object BrcJsonCodec {
    fun encode(message: AgentMessage): String = when (message) {
        is HelloMessage -> JSONObject()
            .put("type", message.type)
            .put("protocol", message.protocol)
            .put("device", mapToJson(mapOf(
                "deviceId" to message.device.deviceId,
                "name" to message.device.name,
                "platform" to message.device.platform,
                "arch" to message.device.arch,
                "hostname" to message.device.hostname,
                "agentVersion" to message.device.agentVersion,
                "coreVersion" to message.device.coreVersion,
            )))
            .put("tools", JSONArray(message.tools.map(::toolToJson)))
            .toString()

        is ResultMessage -> JSONObject()
            .put("type", message.type)
            .put("id", message.id)
            .apply {
                message.result?.let { put("result", resultToJson(it)) }
                message.error?.let {
                    put("error", JSONObject().put("code", it.code).put("message", it.message))
                }
            }
            .toString()

        is PongMessage -> JSONObject()
            .put("type", message.type)
            .put("ts", message.ts)
            .toString()
    }

    fun decodeRelay(raw: String): RelayMessage? = runCatching {
        val json = JSONObject(raw)
        when (json.optString("type")) {
            "welcome" -> WelcomeMessage(
                protocol = json.getInt("protocol"),
                relayVersion = json.optString("relayVersion"),
                serverTime = json.optLong("serverTime"),
            )

            "ping" -> PingMessage(ts = json.getLong("ts"))

            "call" -> CallMessage(
                id = json.getString("id"),
                tool = json.getString("tool"),
                args = json.optJSONObject("args")?.toMap().orEmpty(),
                client = json.optJSONObject("client")?.let {
                    ClientInfo(
                        name = it.optString("name").takeIf(String::isNotBlank),
                        version = it.optString("version").takeIf(String::isNotBlank),
                    )
                },
                timeoutMs = if (json.has("timeoutMs")) json.optLong("timeoutMs") else null,
            )

            "error" -> ErrorMessage(
                code = json.optString("code"),
                message = json.optString("message"),
                fatal = json.optBoolean("fatal", false),
            )

            else -> null
        }
    }.getOrNull()

    private fun toolToJson(tool: ToolDefinition): JSONObject = JSONObject()
        .put("name", tool.name)
        .put("description", tool.description)
        .put("inputSchema", mapToJson(tool.inputSchema))
        .apply { tool.annotations?.let { put("annotations", mapToJson(it)) } }

    private fun resultToJson(result: ToolResult): JSONObject = JSONObject()
        .put("content", JSONArray(result.content.map(::contentToJson)))
        .apply { if (result.isError) put("isError", true) }

    private fun contentToJson(block: ContentBlock): JSONObject = JSONObject()
        .put("type", block.type)
        .apply {
            block.text?.let { put("text", it) }
            block.data?.let { put("data", it) }
            block.mimeType?.let { put("mimeType", it) }
        }

    fun mapToJson(map: Map<String, Any?>): JSONObject =
        JSONObject().apply { map.forEach { (key, value) -> put(key, toJsonValue(value)) } }

    private fun toJsonValue(value: Any?): Any? = when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().apply {
            value.forEach { (key, child) ->
                if (key is String) put(key, toJsonValue(child))
            }
        }
        is Iterable<*> -> JSONArray(value.map(::toJsonValue))
        is Array<*> -> JSONArray(value.map(::toJsonValue))
        else -> value
    }

    private fun JSONObject.toMap(): Map<String, Any?> =
        keys().asSequence().associateWith { key -> fromJsonValue(get(key)) }

    private fun fromJsonValue(value: Any?): Any? = when (value) {
        JSONObject.NULL -> null
        is JSONObject -> value.toMap()
        is JSONArray -> (0 until value.length()).map { fromJsonValue(value.get(it)) }
        else -> value
    }
}
