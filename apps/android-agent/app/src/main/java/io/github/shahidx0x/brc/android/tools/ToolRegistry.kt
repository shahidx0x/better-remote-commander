package io.github.shahidx0x.brc.android.tools

import io.github.shahidx0x.brc.android.protocol.ToolDefinition

class ToolRegistry {
    private val tools = linkedMapOf<String, AndroidTool>()

    fun register(tool: AndroidTool): ToolRegistry = apply {
        val name = tool.definition.name
        require(name.isNotBlank()) { "Tool name must not be blank." }
        require(tools.putIfAbsent(name, tool) == null) {
            "Tool already registered: ${name}"
        }
    }

    fun get(name: String): AndroidTool? = tools[name]

    fun definitions(): List<ToolDefinition> =
        tools.values.map { it.definition }
}
