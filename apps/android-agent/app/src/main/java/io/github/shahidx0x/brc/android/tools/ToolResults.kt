package io.github.shahidx0x.brc.android.tools

import io.github.shahidx0x.brc.android.protocol.ContentBlock
import io.github.shahidx0x.brc.android.protocol.ToolResult
import io.github.shahidx0x.brc.android.transport.BrcJsonCodec

object ToolResults {
    fun json(data: Map<String, Any?>): ToolResult =
        ToolResult(
            content = listOf(
                ContentBlock(
                    type = "text",
                    text = BrcJsonCodec.mapToJson(data).toString(),
                ),
            ),
        )

    fun text(value: String): ToolResult =
        ToolResult(content = listOf(ContentBlock(type = "text", text = value)))

    fun error(message: String): ToolResult =
        ToolResult(
            content = listOf(ContentBlock(type = "text", text = message)),
            isError = true,
        )
}
