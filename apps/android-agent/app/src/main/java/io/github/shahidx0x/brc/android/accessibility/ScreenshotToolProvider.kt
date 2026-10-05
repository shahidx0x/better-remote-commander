package io.github.shahidx0x.brc.android.accessibility

import android.util.Base64
import io.github.shahidx0x.brc.android.protocol.ContentBlock
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.protocol.ToolResult
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.transport.BrcJsonCodec

object ScreenshotToolProvider {
    fun register(registry: ToolRegistry) {
        val screenshots = ScreenshotEngine()
        val accessibility = AccessibilityEngine()

        registry.register(
            FunctionTool(
                ToolDefinition(
                    name = "android_screenshot",
                    description = "Capture the current Android display as a PNG image using owner-enabled Accessibility.",
                    inputSchema = emptySchema(),
                ),
            ) {
                val frame = screenshots.capture()
                ToolResult(
                    content = listOf(
                        ContentBlock(
                            type = "text",
                            text = BrcJsonCodec.mapToJson(
                                mapOf(
                                    "width" to frame.width,
                                    "height" to frame.height,
                                    "format" to "png",
                                    "bytes" to frame.png.size,
                                ),
                            ).toString(),
                        ),
                        ContentBlock(
                            type = "image",
                            data = Base64.encodeToString(frame.png, Base64.NO_WRAP),
                            mimeType = "image/png",
                        ),
                    ),
                )
            },
        )

        registry.register(
            FunctionTool(
                ToolDefinition(
                    name = "android_visual_state",
                    description = "Capture a PNG screenshot together with the current semantic accessibility UI tree.",
                    inputSchema = mapOf(
                        "type" to "object",
                        "properties" to mapOf(
                            "maxNodes" to mapOf(
                                "type" to "integer",
                                "minimum" to 1,
                                "maximum" to 2000,
                            ),
                        ),
                    ),
                ),
            ) { args ->
                val frame = screenshots.capture()
                val tree = accessibility.uiTree(
                    ((args["maxNodes"] as? Number)?.toInt() ?: 500)
                        .coerceIn(1, 2000),
                )
                ToolResult(
                    content = listOf(
                        ContentBlock(
                            type = "text",
                            text = BrcJsonCodec.mapToJson(
                                mapOf(
                                    "width" to frame.width,
                                    "height" to frame.height,
                                    "format" to "png",
                                    "ui" to tree,
                                ),
                            ).toString(),
                        ),
                        ContentBlock(
                            type = "image",
                            data = Base64.encodeToString(frame.png, Base64.NO_WRAP),
                            mimeType = "image/png",
                        ),
                    ),
                )
            },
        )
    }

    private fun emptySchema(): Map<String, Any?> =
        mapOf("type" to "object", "properties" to emptyMap<String, Any?>())
}
