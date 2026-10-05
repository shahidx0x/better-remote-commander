package io.github.shahidx0x.brc.android.automation

import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object AutomationToolProvider {
    fun register(registry: ToolRegistry) {
        val manager = AutomationManager(registry)

        registry
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_start_task",
                        description = "Start a local multi-step Android automation job.",
                        inputSchema = mapOf(
                            "type" to "object",
                            "properties" to mapOf(
                                "name" to mapOf("type" to "string"),
                                "steps" to mapOf(
                                    "type" to "array",
                                    "minItems" to 1,
                                    "maxItems" to 100,
                                    "items" to mapOf("type" to "object"),
                                ),
                            ),
                            "required" to listOf("steps"),
                        ),
                    ),
                ) { args ->
                    @Suppress("UNCHECKED_CAST")
                    val rawSteps = args["steps"] as? List<Any?>
                        ?: error("steps is required")
                    val steps = rawSteps.mapIndexed { index, raw ->
                        @Suppress("UNCHECKED_CAST")
                        raw as? Map<String, Any?>
                            ?: error("steps[$index] must be an object")
                    }
                    val job = manager.start(
                        name = args["name"] as? String,
                        steps = steps,
                    )
                    ToolResults.json(job.snapshot(includeSteps = false))
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_task_status",
                        description = "Return the current state of a local Android automation job.",
                        inputSchema = taskIdSchema(
                            extra = mapOf(
                                "includeSteps" to mapOf("type" to "boolean"),
                            ),
                        ),
                    ),
                ) { args ->
                    val job = manager.get(requireTaskId(args))
                    ToolResults.json(
                        job.snapshot(
                            includeSteps = args["includeSteps"] as? Boolean ?: false,
                        ),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_cancel_task",
                        description = "Cancel a queued or running Android automation job.",
                        inputSchema = taskIdSchema(),
                    ),
                ) { args ->
                    ToolResults.json(
                        manager.cancel(requireTaskId(args)).snapshot(),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_task_events",
                        description = "Return bounded event history for an Android automation job.",
                        inputSchema = taskIdSchema(
                            extra = mapOf(
                                "afterIndex" to mapOf(
                                    "type" to "integer",
                                    "minimum" to 0,
                                ),
                            ),
                        ),
                    ),
                ) { args ->
                    ToolResults.json(
                        manager.events(
                            taskId = requireTaskId(args),
                            afterIndex = (args["afterIndex"] as? Number)?.toInt() ?: 0,
                        ),
                    )
                },
            )
    }

    private fun requireTaskId(args: Map<String, Any?>): String =
        (args["taskId"] as? String)?.takeIf { it.isNotBlank() }
            ?: error("taskId is required")

    private fun taskIdSchema(
        extra: Map<String, Map<String, Any?>> = emptyMap(),
    ): Map<String, Any?> =
        mapOf(
            "type" to "object",
            "properties" to (
                mapOf(
                    "taskId" to mapOf(
                        "type" to "string",
                        "minLength" to 1,
                    ),
                ) + extra
            ),
            "required" to listOf("taskId"),
        )
}
