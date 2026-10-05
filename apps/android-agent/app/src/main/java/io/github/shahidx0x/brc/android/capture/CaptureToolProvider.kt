package io.github.shahidx0x.brc.android.capture

import android.Manifest
import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.util.Base64
import io.github.shahidx0x.brc.android.protocol.ContentBlock
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.protocol.ToolResult
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults
import io.github.shahidx0x.brc.android.transport.BrcJsonCodec

object CaptureToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val app = context.applicationContext
        registry
            .register(cameraInfoTool(app))
            .register(cameraCaptureTool(app))
            .register(audioRecordTool(app))
    }

    private fun cameraInfoTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_camera_info",
            description = "List Android cameras, lens directions, sensor orientation, and supported JPEG sizes.",
            inputSchema = emptySchema(),
        ),
    ) {
        ToolResults.json(
            mapOf("cameras" to CameraCaptureEngine(context).cameras()),
        )
    }

    private fun cameraCaptureTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_camera_capture",
            description = "Capture a JPEG image from an Android camera. On modern Android, BRC must be visible or operate as Device Owner.",
            inputSchema = objectSchema(
                "facing" to mapOf(
                    "type" to "string",
                    "enum" to listOf("back", "front", "external"),
                ),
                "maxWidth" to mapOf(
                    "type" to "integer",
                    "minimum" to 320,
                    "maximum" to 4096,
                ),
                "maxHeight" to mapOf(
                    "type" to "integer",
                    "minimum" to 240,
                    "maximum" to 4096,
                ),
            ),
        ),
    ) { args ->
        CapturePolicy.requirePermissionAndVisibility(
            context,
            Manifest.permission.CAMERA,
            "Camera capture",
        )
        val image = CameraCaptureEngine(context).capture(
            facing = args["facing"] as? String,
            maxWidth = (args["maxWidth"] as? Number)?.toInt() ?: 1920,
            maxHeight = (args["maxHeight"] as? Number)?.toInt() ?: 1080,
        )
        val metadata = linkedMapOf<String, Any?>(
            "cameraId" to image.cameraId,
            "lensFacing" to CameraCaptureEngine.lensFacingName(image.lensFacing),
            "sensorOrientation" to image.sensorOrientation,
            "width" to image.width,
            "height" to image.height,
            "bytes" to image.bytes.size,
            "mimeType" to "image/jpeg",
        )
        ToolResult(
            content = listOf(
                ContentBlock(
                    type = "text",
                    text = BrcJsonCodec.mapToJson(metadata).toString(),
                ),
                ContentBlock(
                    type = "image",
                    data = Base64.encodeToString(
                        image.bytes,
                        Base64.NO_WRAP,
                    ),
                    mimeType = "image/jpeg",
                ),
            ),
        )
    }

    private fun audioRecordTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_record_audio",
            description = "Record microphone audio to an M4A file. On modern Android, BRC must be visible or operate as Device Owner.",
            inputSchema = objectSchema(
                "durationMs" to mapOf(
                    "type" to "integer",
                    "minimum" to 500,
                    "maximum" to 60000,
                ),
            ),
        ),
    ) { args ->
        CapturePolicy.requirePermissionAndVisibility(
            context,
            Manifest.permission.RECORD_AUDIO,
            "Microphone recording",
        )
        val duration = (args["durationMs"] as? Number)?.toLong() ?: 3_000L
        val recording = AudioCaptureEngine(context).record(duration)
        ToolResults.json(
            mapOf(
                "path" to recording.path,
                "bytes" to recording.bytes,
                "durationMs" to recording.durationMs,
                "mimeType" to recording.mimeType,
            ),
        )
    }

    private fun emptySchema(): Map<String, Any?> =
        mapOf("type" to "object", "properties" to emptyMap<String, Any?>())

    private fun objectSchema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))
}
