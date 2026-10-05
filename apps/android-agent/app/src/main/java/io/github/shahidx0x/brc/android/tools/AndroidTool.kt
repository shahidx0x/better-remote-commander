package io.github.shahidx0x.brc.android.tools

import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.protocol.ToolResult

interface AndroidTool {
    val definition: ToolDefinition

    fun execute(arguments: Map<String, Any?>): ToolResult
}
