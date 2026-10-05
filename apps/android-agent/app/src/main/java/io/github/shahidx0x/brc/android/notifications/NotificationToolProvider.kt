package io.github.shahidx0x.brc.android.notifications

import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object NotificationToolProvider {
    fun register(registry: ToolRegistry) {
        registry
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_get_notifications",
                        description = "List active Android notifications visible to the owner-enabled BRC Notification Listener.",
                        inputSchema = objectSchema(
                            "package" to mapOf("type" to "string"),
                            "limit" to mapOf(
                                "type" to "integer",
                                "minimum" to 1,
                                "maximum" to 500,
                            ),
                        ),
                    ),
                ) { args ->
                    val service = service()
                    val items = service.snapshots(
                        packageFilter = args["package"] as? String,
                        limit = ((args["limit"] as? Number)?.toInt() ?: 100),
                    )
                    ToolResults.json(
                        mapOf(
                            "connected" to true,
                            "count" to items.size,
                            "notifications" to items,
                        ),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_open_notification",
                        description = "Open an active notification's content action.",
                        inputSchema = keySchema(),
                    ),
                ) { args ->
                    val key = requireString(args, "key")
                    service().open(key)
                    ToolResults.json(mapOf("opened" to true, "key" to key))
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_notification_action",
                        description = "Invoke an owner-visible action exposed by an active notification.",
                        inputSchema = objectSchema(
                            "key" to mapOf("type" to "string", "minLength" to 1),
                            "actionIndex" to mapOf("type" to "integer", "minimum" to 0),
                        ),
                    ),
                ) { args ->
                    val key = requireString(args, "key")
                    val index = (args["actionIndex"] as? Number)?.toInt()
                        ?: error("actionIndex is required")
                    service().invokeAction(key, index)
                    ToolResults.json(
                        mapOf("invoked" to true, "key" to key, "actionIndex" to index),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_reply_notification",
                        description = "Reply through a notification RemoteInput action when the app exposes one.",
                        inputSchema = objectSchema(
                            "key" to mapOf("type" to "string", "minLength" to 1),
                            "actionIndex" to mapOf("type" to "integer", "minimum" to 0),
                            "text" to mapOf("type" to "string"),
                        ),
                    ),
                ) { args ->
                    val key = requireString(args, "key")
                    val text = args["text"] as? String ?: error("text is required")
                    val index = (args["actionIndex"] as? Number)?.toInt()
                    service().reply(key, index, text)
                    ToolResults.json(
                        mapOf(
                            "replied" to true,
                            "key" to key,
                            "actionIndex" to index,
                        ),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_dismiss_notification",
                        description = "Dismiss an active notification when Android marks it clearable.",
                        inputSchema = keySchema(),
                    ),
                ) { args ->
                    val key = requireString(args, "key")
                    service().dismiss(key)
                    ToolResults.json(mapOf("dismissed" to true, "key" to key))
                },
            )
    }

    private fun service(): BrcNotificationListenerService =
        BrcNotificationListenerService.instance
            ?: error("BRC Notification Listener is not connected. Enable Notification Access.")

    private fun keySchema(): Map<String, Any?> =
        objectSchema("key" to mapOf("type" to "string", "minLength" to 1))

    private fun requireString(args: Map<String, Any?>, key: String): String =
        (args[key] as? String)?.takeIf { it.isNotBlank() }
            ?: error("$key is required")

    private fun objectSchema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))
}
