package io.github.shahidx0x.brc.android.protocol

object BrcProtocol {
    const val VERSION = 1
    const val PLATFORM = "android"
}

data class ToolDefinition(
    val name: String,
    val description: String,
    val inputSchema: Map<String, Any?>,
    val annotations: Map<String, Any?>? = null,
)

data class DeviceInfo(
    val deviceId: String,
    val name: String,
    val platform: String,
    val arch: String,
    val hostname: String,
    val agentVersion: String,
    val coreVersion: String,
)

data class ContentBlock(
    val type: String,
    val text: String? = null,
    val data: String? = null,
    val mimeType: String? = null,
)

data class ToolResult(
    val content: List<ContentBlock>,
    val isError: Boolean = false,
)

data class ResultError(val code: String, val message: String)

sealed interface AgentMessage { val type: String }

data class HelloMessage(
    val protocol: Int,
    val device: DeviceInfo,
    val tools: List<ToolDefinition>,
    override val type: String = "hello",
) : AgentMessage

data class ResultMessage(
    val id: String,
    val result: ToolResult? = null,
    val error: ResultError? = null,
    override val type: String = "result",
) : AgentMessage

data class PongMessage(
    val ts: Long,
    override val type: String = "pong",
) : AgentMessage

sealed interface RelayMessage { val type: String }

data class WelcomeMessage(
    val protocol: Int,
    val relayVersion: String,
    val serverTime: Long,
    override val type: String = "welcome",
) : RelayMessage

data class ClientInfo(
    val name: String? = null,
    val version: String? = null,
)

data class CallMessage(
    val id: String,
    val tool: String,
    val args: Map<String, Any?> = emptyMap(),
    val client: ClientInfo? = null,
    val timeoutMs: Long? = null,
    override val type: String = "call",
) : RelayMessage

data class PingMessage(
    val ts: Long,
    override val type: String = "ping",
) : RelayMessage

data class ErrorMessage(
    val code: String,
    val message: String,
    val fatal: Boolean = false,
    override val type: String = "error",
) : RelayMessage
