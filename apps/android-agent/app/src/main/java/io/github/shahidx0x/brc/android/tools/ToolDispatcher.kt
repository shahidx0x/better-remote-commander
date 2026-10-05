package io.github.shahidx0x.brc.android.tools

import io.github.shahidx0x.brc.android.protocol.CallMessage
import io.github.shahidx0x.brc.android.protocol.ResultError
import io.github.shahidx0x.brc.android.protocol.ResultMessage

class ToolDispatcher(
    private val registry: ToolRegistry,
) {
    fun dispatch(call: CallMessage): ResultMessage {
        val tool = registry.get(call.tool)
            ?: return ResultMessage(
                id = call.id,
                error = ResultError(
                    code = "TOOL_NOT_FOUND",
                    message = "Unknown Android tool: ${call.tool}",
                ),
            )

        return runCatching { tool.execute(call.args) }
            .fold(
                onSuccess = { ResultMessage(id = call.id, result = it) },
                onFailure = { error ->
                    ResultMessage(
                        id = call.id,
                        error = ResultError(
                            code = "INTERNAL_ERROR",
                            message = error.message ?: "Tool execution failed.",
                        ),
                    )
                },
            )
    }
}
