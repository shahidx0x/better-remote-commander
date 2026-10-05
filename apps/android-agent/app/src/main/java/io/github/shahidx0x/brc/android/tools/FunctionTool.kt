package io.github.shahidx0x.brc.android.tools

import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.protocol.ToolResult

class FunctionTool(
    override val definition: ToolDefinition,
    private val handler: (Map<String, Any?>) -> ToolResult,
) : AndroidTool {
    override fun execute(arguments: Map<String, Any?>): ToolResult =
        handler(arguments)
}
