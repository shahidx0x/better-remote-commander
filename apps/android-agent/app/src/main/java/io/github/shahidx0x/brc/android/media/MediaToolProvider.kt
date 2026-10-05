package io.github.shahidx0x.brc.android.media

import android.content.ComponentName
import android.content.Context
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import io.github.shahidx0x.brc.android.notifications.BrcNotificationListenerService
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object MediaToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val app = context.applicationContext
        registry
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_media_sessions",
                        description = "List active Android media sessions when Notification Access is enabled.",
                        inputSchema = emptySchema(),
                    ),
                ) {
                    val sessions = controllers(app).mapIndexed(::snapshot)
                    ToolResults.json(
                        mapOf("count" to sessions.size, "sessions" to sessions),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_media_control",
                        description = "Control an active Android media session.",
                        inputSchema = objectSchema(
                            "package" to mapOf("type" to "string"),
                            "index" to mapOf("type" to "integer", "minimum" to 0),
                            "action" to mapOf(
                                "type" to "string",
                                "enum" to listOf(
                                    "play", "pause", "play_pause", "next",
                                    "previous", "stop", "seek",
                                ),
                            ),
                            "positionMs" to mapOf("type" to "integer", "minimum" to 0),
                        ),
                    ),
                ) { args ->
                    val sessions = controllers(app)
                    val packageName = args["package"] as? String
                    val requestedIndex = (args["index"] as? Number)?.toInt()
                    val controller = when {
                        !packageName.isNullOrBlank() ->
                            sessions.firstOrNull { it.packageName == packageName }
                        requestedIndex != null -> sessions.getOrNull(requestedIndex)
                        else -> sessions.firstOrNull()
                    } ?: error("No matching active media session.")

                    val action = args["action"] as? String ?: error("action is required")
                    val controls = controller.transportControls
                    when (action) {
                        "play" -> controls.play()
                        "pause" -> controls.pause()
                        "play_pause" -> {
                            if (controller.playbackState?.state == PlaybackState.STATE_PLAYING) {
                                controls.pause()
                            } else {
                                controls.play()
                            }
                        }
                        "next" -> controls.skipToNext()
                        "previous" -> controls.skipToPrevious()
                        "stop" -> controls.stop()
                        "seek" -> controls.seekTo(
                            (args["positionMs"] as? Number)?.toLong()
                                ?: error("positionMs is required for seek"),
                        )
                        else -> error("Unsupported media action.")
                    }
                    ToolResults.json(
                        mapOf(
                            "sent" to true,
                            "package" to controller.packageName,
                            "action" to action,
                        ),
                    )
                },
            )
    }

    private fun controllers(context: Context): List<MediaController> {
        val manager = context.getSystemService(Context.MEDIA_SESSION_SERVICE)
            as MediaSessionManager
        val component = ComponentName(context, BrcNotificationListenerService::class.java)
        return manager.getActiveSessions(component)
    }

    private fun snapshot(index: Int, controller: MediaController): Map<String, Any?> {
        val state = controller.playbackState
        val metadata = controller.metadata
        return linkedMapOf(
            "index" to index,
            "package" to controller.packageName,
            "state" to stateName(state?.state),
            "positionMs" to state?.position,
            "speed" to state?.playbackSpeed,
            "actions" to state?.actions,
            "title" to metadata?.getString(MediaMetadata.METADATA_KEY_TITLE),
            "artist" to metadata?.getString(MediaMetadata.METADATA_KEY_ARTIST),
            "album" to metadata?.getString(MediaMetadata.METADATA_KEY_ALBUM),
            "durationMs" to metadata?.getLong(MediaMetadata.METADATA_KEY_DURATION),
        )
    }

    private fun stateName(state: Int?): String = when (state) {
        PlaybackState.STATE_PLAYING -> "playing"
        PlaybackState.STATE_PAUSED -> "paused"
        PlaybackState.STATE_BUFFERING -> "buffering"
        PlaybackState.STATE_STOPPED -> "stopped"
        PlaybackState.STATE_FAST_FORWARDING -> "fast_forwarding"
        PlaybackState.STATE_REWINDING -> "rewinding"
        PlaybackState.STATE_SKIPPING_TO_NEXT -> "skipping_next"
        PlaybackState.STATE_SKIPPING_TO_PREVIOUS -> "skipping_previous"
        PlaybackState.STATE_ERROR -> "error"
        PlaybackState.STATE_NONE, null -> "none"
        else -> "other"
    }

    private fun emptySchema(): Map<String, Any?> =
        mapOf("type" to "object", "properties" to emptyMap<String, Any?>())

    private fun objectSchema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))
}
