package io.github.shahidx0x.brc.android.tools

import android.content.Context
import io.github.shahidx0x.brc.android.core.CapabilityManager
import io.github.shahidx0x.brc.android.protocol.ContentBlock
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.protocol.ToolResult
import io.github.shahidx0x.brc.android.transport.BrcJsonCodec

class CapabilityTool(context: Context) : AndroidTool {
    private val manager = CapabilityManager(context.applicationContext)

    override val definition = ToolDefinition(
        name = "android_get_capabilities",
        description = "Return the permissions and capabilities currently available to the Android BRC agent.",
        inputSchema = mapOf(
            "type" to "object",
            "properties" to emptyMap<String, Any?>(),
        ),
    )

    override fun execute(arguments: Map<String, Any?>): ToolResult {
        val snapshot = manager.snapshot()
        val payload = linkedMapOf<String, Any?>(
            "platform" to snapshot.platform,
            "androidApi" to snapshot.androidApi,
            "protocolVersion" to snapshot.protocolVersion,
            "capabilities" to snapshot.capabilities,
        )
        return ToolResult(
            content = listOf(
                ContentBlock(
                    type = "text",
                    text = BrcJsonCodec.mapToJson(payload).toString(),
                ),
            ),
        )
    }
}
