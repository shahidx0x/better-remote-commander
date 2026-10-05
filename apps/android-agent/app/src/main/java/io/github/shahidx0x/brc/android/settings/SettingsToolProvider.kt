package io.github.shahidx0x.brc.android.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object SettingsToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val app = context.applicationContext
        registry
            .register(getSettingTool(app))
            .register(setSettingTool(app))
            .register(getBrightnessTool(app))
            .register(setBrightnessTool(app))
            .register(screenTimeoutTool(app))
            .register(openSettingTool(app))
    }

    private fun getSettingTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_get_setting",
            description = "Read an Android System, Secure, or Global setting when Android exposes it.",
            inputSchema = objectSchema(
                "namespace" to mapOf(
                    "type" to "string",
                    "enum" to listOf("system", "secure", "global"),
                ),
                "key" to mapOf("type" to "string", "minLength" to 1),
            ),
        ),
    ) { args ->
        val namespace = (args["namespace"] as? String ?: "system").lowercase()
        val key = requireString(args, "key")
        val value = when (namespace) {
            "secure" -> Settings.Secure.getString(context.contentResolver, key)
            "global" -> Settings.Global.getString(context.contentResolver, key)
            else -> Settings.System.getString(context.contentResolver, key)
        }
        ToolResults.json(
            mapOf("namespace" to namespace, "key" to key, "value" to value),
        )
    }

    private fun setSettingTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_set_setting",
            description = "Write an Android System setting when the owner granted Modify System Settings. Secure/Global writes require an elevated privilege mode.",
            inputSchema = objectSchema(
                "namespace" to mapOf(
                    "type" to "string",
                    "enum" to listOf("system", "secure", "global"),
                ),
                "key" to mapOf("type" to "string", "minLength" to 1),
                "value" to mapOf("type" to "string"),
            ),
        ),
    ) { args ->
        val namespace = (args["namespace"] as? String ?: "system").lowercase()
        val key = requireString(args, "key")
        val value = args["value"]?.toString() ?: ""
        require(namespace == "system") {
            "Secure/Global settings require Device Owner, Shizuku, ADB, or root."
        }
        require(Settings.System.canWrite(context)) {
            "Modify System Settings access is not granted."
        }
        val written = Settings.System.putString(context.contentResolver, key, value)
        require(written) { "Android rejected the setting write." }
        ToolResults.json(
            mapOf(
                "written" to true,
                "namespace" to namespace,
                "key" to key,
                "value" to Settings.System.getString(context.contentResolver, key),
            ),
        )
    }

    private fun getBrightnessTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_get_brightness",
            description = "Return the current system screen brightness value.",
            inputSchema = emptySchema(),
        ),
    ) {
        ToolResults.json(
            mapOf(
                "brightness" to Settings.System.getInt(
                    context.contentResolver,
                    Settings.System.SCREEN_BRIGHTNESS,
                    -1,
                ),
                "mode" to Settings.System.getInt(
                    context.contentResolver,
                    Settings.System.SCREEN_BRIGHTNESS_MODE,
                    -1,
                ),
                "canWrite" to Settings.System.canWrite(context),
            ),
        )
    }

    private fun setBrightnessTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_set_brightness",
            description = "Set screen brightness from 0 to 255 when Modify System Settings is granted.",
            inputSchema = objectSchema(
                "brightness" to mapOf(
                    "type" to "integer",
                    "minimum" to 0,
                    "maximum" to 255,
                ),
            ),
        ),
    ) { args ->
        require(Settings.System.canWrite(context)) {
            "Modify System Settings access is not granted."
        }
        val value = (args["brightness"] as? Number)?.toInt()
            ?: error("brightness is required")
        require(value in 0..255) { "brightness must be between 0 and 255." }
        Settings.System.putInt(
            context.contentResolver,
            Settings.System.SCREEN_BRIGHTNESS_MODE,
            Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL,
        )
        Settings.System.putInt(
            context.contentResolver,
            Settings.System.SCREEN_BRIGHTNESS,
            value,
        )
        ToolResults.json(mapOf("brightness" to value))
    }

    private fun screenTimeoutTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_set_screen_timeout",
            description = "Set the screen-off timeout in milliseconds when Modify System Settings is granted.",
            inputSchema = objectSchema(
                "timeoutMs" to mapOf(
                    "type" to "integer",
                    "minimum" to 15000,
                    "maximum" to 2147483647,
                ),
            ),
        ),
    ) { args ->
        require(Settings.System.canWrite(context)) {
            "Modify System Settings access is not granted."
        }
        val timeout = (args["timeoutMs"] as? Number)?.toLong()
            ?: error("timeoutMs is required")
        require(timeout in 15_000L..Int.MAX_VALUE.toLong()) {
            "timeoutMs is outside the supported range."
        }
        Settings.System.putLong(
            context.contentResolver,
            Settings.System.SCREEN_OFF_TIMEOUT,
            timeout,
        )
        ToolResults.json(mapOf("timeoutMs" to timeout))
    }

    private fun openSettingTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_open_setting",
            description = "Open a specific Android settings or settings-panel screen.",
            inputSchema = objectSchema(
                "page" to mapOf(
                    "type" to "string",
                    "enum" to listOf(
                        "main", "internet", "wifi", "bluetooth", "display", "sound",
                        "location", "accessibility", "apps", "notifications", "battery",
                        "overlay", "write_settings", "all_files", "unknown_sources",
                    ),
                ),
            ),
        ),
    ) { args ->
        val page = args["page"] as? String ?: "main"
        val intent = when (page) {
            "internet" -> Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY)
            "wifi" -> Intent(Settings.ACTION_WIFI_SETTINGS)
            "bluetooth" -> Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
            "display" -> Intent(Settings.ACTION_DISPLAY_SETTINGS)
            "sound" -> Intent(Settings.ACTION_SOUND_SETTINGS)
            "location" -> Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
            "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            "apps" -> Intent(Settings.ACTION_APPLICATION_SETTINGS)
            "notifications" -> Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            "overlay" -> packageIntent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, context)
            "write_settings" -> packageIntent(Settings.ACTION_MANAGE_WRITE_SETTINGS, context)
            "all_files" -> packageIntent(
                Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                context,
            )
            "unknown_sources" -> packageIntent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                context,
            )
            else -> Intent(Settings.ACTION_SETTINGS)
        }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        ToolResults.json(mapOf("opened" to true, "page" to page))
    }

    private fun packageIntent(action: String, context: Context): Intent =
        Intent(action, Uri.parse("package:${context.packageName}"))

    private fun requireString(args: Map<String, Any?>, key: String): String =
        (args[key] as? String)?.takeIf { it.isNotBlank() }
            ?: error("$key is required")

    private fun emptySchema(): Map<String, Any?> =
        mapOf("type" to "object", "properties" to emptyMap<String, Any?>())

    private fun objectSchema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))
}
