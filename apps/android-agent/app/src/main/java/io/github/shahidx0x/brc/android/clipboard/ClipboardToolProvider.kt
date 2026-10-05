package io.github.shahidx0x.brc.android.clipboard

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object ClipboardToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val app = context.applicationContext
        registry
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_get_clipboard",
                        description = "Read the current clipboard when Android permits the BRC app to access it.",
                        inputSchema = emptySchema(),
                    ),
                ) {
                    val manager = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    val clip = manager.primaryClip
                    val items = if (clip == null) {
                        emptyList()
                    } else {
                        (0 until clip.itemCount).map { index ->
                            clip.getItemAt(index).coerceToText(app)?.toString().orEmpty()
                        }
                    }
                    ToolResults.json(
                        mapOf(
                            "hasPrimaryClip" to manager.hasPrimaryClip(),
                            "items" to items,
                            "count" to items.size,
                        ),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_set_clipboard",
                        description = "Set plain text on the Android clipboard.",
                        inputSchema = objectSchema(
                            "text" to mapOf("type" to "string"),
                            "label" to mapOf("type" to "string"),
                        ),
                    ),
                ) { args ->
                    val text = args["text"] as? String ?: error("text is required")
                    val label = args["label"] as? String ?: "BRC"
                    val manager = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    manager.setPrimaryClip(ClipData.newPlainText(label, text))
                    ToolResults.json(mapOf("set" to true, "length" to text.length))
                },
            )
    }

    private fun emptySchema(): Map<String, Any?> =
        mapOf("type" to "object", "properties" to emptyMap<String, Any?>())

    private fun objectSchema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))
}
