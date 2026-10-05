package io.github.shahidx0x.brc.android.tools

import android.app.ActivityManager
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.hardware.Sensor
import android.hardware.SensorManager
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.protocol.ToolResult
import java.io.File
import java.util.Locale

object DeviceToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val app = context.applicationContext
        registry
            .register(tool("android_device_info", "Return Android device and OS information.") {
                deviceInfo(app)
            })
            .register(tool("android_battery", "Return battery and charging information.") {
                batteryInfo(app)
            })
            .register(tool("android_storage", "Return internal and shared storage capacity.") {
                storageInfo(app)
            })
            .register(tool("android_memory", "Return Android memory information.") {
                memoryInfo(app)
            })
            .register(tool("android_network", "Return current network connectivity information.") {
                networkInfo(app)
            })
            .register(tool("android_get_volume", "Return Android audio stream volume levels.") {
                volumeInfo(app)
            })
            .register(setVolumeTool(app))
            .register(vibrateTool(app))
            .register(openUrlTool(app))
            .register(openSettingsTool(app))
            .register(tool("android_list_sensors", "List hardware sensors exposed by Android.") {
                sensorInfo(app)
            })
            .register(tool("android_orientation", "Return current orientation and display rotation.") {
                orientationInfo(app)
            })
            .register(tool("android_bluetooth_info", "Return Bluetooth adapter state when available.") {
                bluetoothInfo(app)
            })
    }

    private fun tool(
        name: String,
        description: String,
        handler: () -> ToolResult,
    ) = FunctionTool(
        ToolDefinition(
            name = name,
            description = description,
            inputSchema = emptyObjectSchema(),
        ),
    ) { handler() }

    private fun deviceInfo(context: Context): ToolResult =
        ToolResults.json(
            linkedMapOf(
                "manufacturer" to Build.MANUFACTURER,
                "brand" to Build.BRAND,
                "model" to Build.MODEL,
                "device" to Build.DEVICE,
                "product" to Build.PRODUCT,
                "androidRelease" to Build.VERSION.RELEASE,
                "androidApi" to Build.VERSION.SDK_INT,
                "securityPatch" to Build.VERSION.SECURITY_PATCH,
                "abis" to Build.SUPPORTED_ABIS.toList(),
                "locale" to Locale.getDefault().toLanguageTag(),
                "uptimeMs" to SystemClock.elapsedRealtime(),
                "powerSaveMode" to
                    (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
                        .isPowerSaveMode,
            ),
        )

    private fun batteryInfo(context: Context): ToolResult {
        val manager = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val sticky = context.registerReceiver(
            null,
            android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED),
        )
        return ToolResults.json(
            linkedMapOf(
                "capacityPercent" to
                    manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY),
                "chargeCounterMicroAh" to
                    manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER),
                "currentNowMicroA" to
                    manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW),
                "status" to sticky?.getIntExtra(BatteryManager.EXTRA_STATUS, -1),
                "plugged" to sticky?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0),
                "temperatureC" to
                    (sticky?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0)?.div(10.0)),
                "voltageMv" to sticky?.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0),
            ),
        )
    }

    private fun storageInfo(context: Context): ToolResult =
        ToolResults.json(
            linkedMapOf(
                "internal" to stat(context.filesDir),
                "shared" to runCatching {
                    stat(Environment.getExternalStorageDirectory())
                }.getOrNull(),
                "appFiles" to context.filesDir.absolutePath,
                "appCache" to context.cacheDir.absolutePath,
                "externalFiles" to context.getExternalFilesDir(null)?.absolutePath,
            ),
        )

    private fun stat(file: File): Map<String, Long> {
        val fs = StatFs(file.absolutePath)
        return mapOf(
            "totalBytes" to fs.totalBytes,
            "availableBytes" to fs.availableBytes,
            "freeBytes" to fs.freeBytes,
        )
    }

    private fun memoryInfo(context: Context): ToolResult {
        val info = ActivityManager.MemoryInfo()
        (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager)
            .getMemoryInfo(info)
        return ToolResults.json(
            mapOf(
                "availableBytes" to info.availMem,
                "totalBytes" to info.totalMem,
                "lowMemory" to info.lowMemory,
                "thresholdBytes" to info.threshold,
            ),
        )
    }

    private fun networkInfo(context: Context): ToolResult {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = manager.activeNetwork
        val caps = network?.let(manager::getNetworkCapabilities)
        return ToolResults.json(
            mapOf(
                "connected" to (caps != null),
                "validated" to (caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true),
                "metered" to manager.isActiveNetworkMetered,
                "wifi" to (caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true),
                "cellular" to (caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true),
                "ethernet" to (caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true),
                "vpn" to (caps?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true),
            ),
        )
    }

    private fun volumeInfo(context: Context): ToolResult {
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        return ToolResults.json(
            mapOf(
                "music" to stream(audio, AudioManager.STREAM_MUSIC),
                "ring" to stream(audio, AudioManager.STREAM_RING),
                "alarm" to stream(audio, AudioManager.STREAM_ALARM),
                "notification" to stream(audio, AudioManager.STREAM_NOTIFICATION),
            ),
        )
    }

    private fun stream(audio: AudioManager, stream: Int): Map<String, Int> =
        mapOf(
            "current" to audio.getStreamVolume(stream),
            "max" to audio.getStreamMaxVolume(stream),
            "min" to if (Build.VERSION.SDK_INT >= 28) audio.getStreamMinVolume(stream) else 0,
        )

    private fun setVolumeTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_set_volume",
            description = "Set an Android audio stream volume.",
            inputSchema = objectSchema(
                "stream" to mapOf(
                    "type" to "string",
                    "enum" to listOf("music", "ring", "alarm", "notification"),
                ),
                "level" to mapOf("type" to "integer", "minimum" to 0),
            ),
        ),
    ) { args ->
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val stream = when (args["stream"] as? String ?: "music") {
            "ring" -> AudioManager.STREAM_RING
            "alarm" -> AudioManager.STREAM_ALARM
            "notification" -> AudioManager.STREAM_NOTIFICATION
            else -> AudioManager.STREAM_MUSIC
        }
        val level = (args["level"] as? Number)?.toInt()
            ?: error("level is required")
        val max = audio.getStreamMaxVolume(stream)
        require(level in 0..max) { "level must be between 0 and $max" }
        audio.setStreamVolume(stream, level, 0)
        ToolResults.json(mapOf("level" to audio.getStreamVolume(stream), "max" to max))
    }

    private fun vibrateTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_vibrate",
            description = "Vibrate the device for a short duration.",
            inputSchema = objectSchema(
                "durationMs" to mapOf(
                    "type" to "integer",
                    "minimum" to 1,
                    "maximum" to 5000,
                ),
            ),
        ),
    ) { args ->
        val duration = ((args["durationMs"] as? Number)?.toLong() ?: 250L)
            .coerceIn(1L, 5_000L)
        val vibrator = if (Build.VERSION.SDK_INT >= 31) {
            context.getSystemService(VibratorManager::class.java).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        vibrator.vibrate(
            VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE),
        )
        ToolResults.json(mapOf("vibrated" to true, "durationMs" to duration))
    }

    private fun openUrlTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_open_url",
            description = "Open a URL with the Android activity selected by the owner.",
            inputSchema = objectSchema(
                "url" to mapOf("type" to "string", "minLength" to 1),
            ),
        ),
    ) { args ->
        val url = args["url"] as? String ?: error("url is required")
        val uri = Uri.parse(url)
        require(uri.scheme in setOf("http", "https", "mailto", "tel", "geo")) {
            "Unsupported URL scheme."
        }
        context.startActivity(
            Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        ToolResults.json(mapOf("opened" to true, "url" to url))
    }

    private fun openSettingsTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_open_settings",
            description = "Open a system Settings page on the device.",
            inputSchema = objectSchema(
                "page" to mapOf(
                    "type" to "string",
                    "enum" to listOf(
                        "main", "wifi", "bluetooth", "display", "sound",
                        "location", "accessibility", "apps",
                    ),
                ),
            ),
        ),
    ) { args ->
        val action = when (args["page"] as? String ?: "main") {
            "wifi" -> Settings.ACTION_WIFI_SETTINGS
            "bluetooth" -> Settings.ACTION_BLUETOOTH_SETTINGS
            "display" -> Settings.ACTION_DISPLAY_SETTINGS
            "sound" -> Settings.ACTION_SOUND_SETTINGS
            "location" -> Settings.ACTION_LOCATION_SOURCE_SETTINGS
            "accessibility" -> Settings.ACTION_ACCESSIBILITY_SETTINGS
            "apps" -> Settings.ACTION_APPLICATION_SETTINGS
            else -> Settings.ACTION_SETTINGS
        }
        context.startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        ToolResults.json(mapOf("opened" to true, "page" to (args["page"] ?: "main")))
    }

    private fun sensorInfo(context: Context): ToolResult {
        val manager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val sensors = manager.getSensorList(Sensor.TYPE_ALL).map {
            mapOf(
                "name" to it.name,
                "vendor" to it.vendor,
                "type" to it.type,
                "stringType" to it.stringType,
                "version" to it.version,
                "maxRange" to it.maximumRange,
                "resolution" to it.resolution,
            )
        }
        return ToolResults.json(mapOf("count" to sensors.size, "sensors" to sensors))
    }

    private fun orientationInfo(context: Context): ToolResult {
        val orientation = when (context.resources.configuration.orientation) {
            Configuration.ORIENTATION_LANDSCAPE -> "landscape"
            Configuration.ORIENTATION_PORTRAIT -> "portrait"
            else -> "undefined"
        }
        return ToolResults.json(mapOf("orientation" to orientation))
    }

    private fun bluetoothInfo(context: Context): ToolResult {
        val manager = context.getSystemService(BluetoothManager::class.java)
        val adapter = manager?.adapter
        val payload = linkedMapOf<String, Any?>(
            "supported" to (adapter != null),
            "enabled" to (adapter?.isEnabled == true),
        )
        if (
            adapter != null &&
            Build.VERSION.SDK_INT < 31 ||
            context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            runCatching { adapter?.name }.getOrNull()?.let { payload["name"] = it }
        }
        return ToolResults.json(payload)
    }

    private fun emptyObjectSchema(): Map<String, Any?> =
        mapOf("type" to "object", "properties" to emptyMap<String, Any?>())

    private fun objectSchema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))
}
