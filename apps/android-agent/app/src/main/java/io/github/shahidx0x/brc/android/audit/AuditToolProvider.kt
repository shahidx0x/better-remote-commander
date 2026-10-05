package io.github.shahidx0x.brc.android.audit

import android.content.Context
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object AuditToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val audit = AuditLog(context.applicationContext)
        registry
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_audit_log",
                        description = "Return recent local BRC security/audit events. Command arguments and secrets are not logged.",
                        inputSchema = mapOf(
                            "type" to "object",
                            "properties" to mapOf(
                                "limit" to mapOf(
                                    "type" to "integer",
                                    "minimum" to 1,
                                    "maximum" to 1000,
                                ),
                            ),
                        ),
                    ),
                ) { args ->
                    val limit = (args["limit"] as? Number)?.toInt() ?: 200
                    val events = audit.read(limit)
                    ToolResults.json(
                        mapOf(
                            "count" to events.size,
                            "events" to events,
                        ),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_clear_audit_log",
                        description = "Clear the local BRC audit log.",
                        inputSchema = mapOf(
                            "type" to "object",
                            "properties" to emptyMap<String, Any?>(),
                        ),
                    ),
                ) {
                    audit.clear()
                    audit.append("audit_cleared")
                    ToolResults.json(mapOf("cleared" to true))
                },
            )
    }
}
