package io.github.shahidx0x.brc.android.projection

import android.content.Context
import android.content.Intent
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object ProjectionToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val app = context.applicationContext
        registry
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_request_screen_projection",
                        description = "Open Android's owner-visible MediaProjection authorization prompt.",
                        inputSchema = emptySchema(),
                    ),
                ) {
                    app.startActivity(
                        Intent(
                            app,
                            ScreenProjectionPermissionActivity::class.java,
                        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                    ToolResults.json(
                        mapOf(
                            "requested" to true,
                            "note" to "The device owner must approve Android's screen capture prompt.",
                        ),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_screen_projection_status",
                        description = "Return MediaProjection authorization and screen-recording state.",
                        inputSchema = emptySchema(),
                    ),
                ) {
                    ToolResults.json(ScreenProjectionService.currentStatus())
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_start_screen_recording",
                        description = "Start MP4 screen recording after the owner has authorized MediaProjection.",
                        inputSchema = objectSchema(
                            "maxWidth" to mapOf(
                                "type" to "integer",
                                "minimum" to 320,
                                "maximum" to 3840,
                            ),
                            "maxHeight" to mapOf(
                                "type" to "integer",
                                "minimum" to 240,
                                "maximum" to 2160,
                            ),
                            "fps" to mapOf(
                                "type" to "integer",
                                "minimum" to 15,
                                "maximum" to 60,
                            ),
                            "bitrate" to mapOf(
                                "type" to "integer",
                                "minimum" to 1000000,
                                "maximum" to 20000000,
                            ),
                        ),
                    ),
                ) { args ->
                    ToolResults.json(
                        ScreenProjectionService.startRecording(
                            maxWidth = (args["maxWidth"] as? Number)?.toInt() ?: 1920,
                            maxHeight = (args["maxHeight"] as? Number)?.toInt() ?: 1080,
                            fps = (args["fps"] as? Number)?.toInt() ?: 30,
                            bitrate = (args["bitrate"] as? Number)?.toInt() ?: 6_000_000,
                        ),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_stop_screen_recording",
                        description = "Stop the active MediaProjection recording and return the MP4 file path.",
                        inputSchema = emptySchema(),
                    ),
                ) {
                    ToolResults.json(ScreenProjectionService.stopRecording())
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
