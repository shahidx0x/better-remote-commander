package io.github.shahidx0x.brc.android.tools

import io.github.shahidx0x.brc.android.protocol.BrcProtocol
import io.github.shahidx0x.brc.android.protocol.ContentBlock
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.protocol.ToolResult

class PingTool : AndroidTool {
    override val definition = ToolDefinition(
        name = "android_ping",
        description = "Check whether the Android BRC agent dispatcher is responsive.",
        inputSchema = mapOf(
            "type" to "object",
            "properties" to emptyMap<String, Any?>(),
        ),
    )

    override fun execute(arguments: Map<String, Any?>): ToolResult =
        ToolResult(
            content = listOf(
                ContentBlock(
                    type = "text",
                    text = """{"pong":true,"platform":"${BrcProtocol.PLATFORM}","protocol":${BrcProtocol.VERSION}}""",
                ),
            ),
        )
}
