package io.github.shahidx0x.brc.android.privilege

import android.content.Context
import android.os.Process
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object PrivilegeToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val app = context.applicationContext
        val deviceOwner = DeviceOwnerManager(app)

        registry
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_privilege_status",
                        description = "Return BRC Android privilege modes: app sandbox, Device Owner, Shizuku/Sui, and root availability.",
                        inputSchema = emptySchema(),
                    ),
                ) {
                    ToolResults.json(
                        linkedMapOf(
                            "normalUid" to Process.myUid(),
                            "devicePolicy" to deviceOwner.status(),
                            "shizukuBinder" to ShizukuBridge.binderAvailable(),
                            "shizukuPermission" to ShizukuBridge.permissionGranted(),
                            "shizukuVersion" to ShizukuBridge.version(),
                            "shizukuBackendUid" to ShizukuBridge.backendUid(),
                            "rootInstalled" to ShellExecutor.rootInstalled(),
                        ),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_shizuku_request_permission",
                        description = "Request Shizuku/Sui permission through its owner-visible authorization UI.",
                        inputSchema = emptySchema(),
                    ),
                ) {
                    val already = ShizukuBridge.permissionGranted()
                    val granted = if (already) true else ShizukuBridge.requestPermission()
                    ToolResults.json(
                        mapOf(
                            "binderAvailable" to ShizukuBridge.binderAvailable(),
                            "alreadyGranted" to already,
                            "grantedNow" to granted,
                            "requested" to (!already),
                        ),
                    )
                },
            )
            .register(shellTool(app))
            .register(
                ownerTool(
                    "android_device_owner_status",
                    "Return Device Owner/Profile Owner provisioning status.",
                ) {
                    ToolResults.json(deviceOwner.status())
                },
            )
            .register(
                ownerTool(
                    "android_device_owner_lock",
                    "Immediately lock the managed device when BRC is Device Owner.",
                ) {
                    deviceOwner.lockNow()
                    ToolResults.json(mapOf("locked" to true))
                },
            )
            .register(
                ownerTool(
                    "android_device_owner_reboot",
                    "Reboot the managed device when BRC is Device Owner.",
                ) {
                    deviceOwner.reboot()
                    ToolResults.json(mapOf("rebootRequested" to true))
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_device_owner_set_global_setting",
                        description = "Set a DevicePolicyManager-supported global setting when BRC is Device Owner.",
                        inputSchema = objectSchema(
                            "key" to mapOf("type" to "string", "minLength" to 1),
                            "value" to mapOf("type" to "string"),
                        ),
                    ),
                ) { args ->
                    val key = requireString(args, "key")
                    val value = args["value"]?.toString() ?: ""
                    deviceOwner.setGlobalSetting(key, value)
                    ToolResults.json(
                        mapOf("set" to true, "key" to key, "value" to value),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_device_owner_set_user_restriction",
                        description = "Enable or clear an Android UserManager restriction when BRC is Device Owner.",
                        inputSchema = objectSchema(
                            "key" to mapOf("type" to "string", "minLength" to 1),
                            "enabled" to mapOf("type" to "boolean"),
                        ),
                    ),
                ) { args ->
                    val key = requireString(args, "key")
                    val enabled = args["enabled"] as? Boolean
                        ?: error("enabled is required")
                    deviceOwner.setUserRestriction(key, enabled)
                    ToolResults.json(
                        mapOf("key" to key, "enabled" to enabled),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_device_owner_set_camera_disabled",
                        description = "Disable or re-enable camera use through DevicePolicyManager.",
                        inputSchema = boolSchema("disabled"),
                    ),
                ) { args ->
                    val disabled = requireBoolean(args, "disabled")
                    deviceOwner.setCameraDisabled(disabled)
                    ToolResults.json(mapOf("cameraDisabled" to disabled))
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_device_owner_set_status_bar_disabled",
                        description = "Disable or re-enable status-bar expansion through DevicePolicyManager.",
                        inputSchema = boolSchema("disabled"),
                    ),
                ) { args ->
                    val disabled = requireBoolean(args, "disabled")
                    ToolResults.json(
                        mapOf(
                            "disabled" to disabled,
                            "applied" to deviceOwner.setStatusBarDisabled(disabled),
                        ),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_device_owner_set_keyguard_disabled",
                        description = "Disable or re-enable the keyguard when Device Owner policy permits it.",
                        inputSchema = boolSchema("disabled"),
                    ),
                ) { args ->
                    val disabled = requireBoolean(args, "disabled")
                    ToolResults.json(
                        mapOf(
                            "disabled" to disabled,
                            "applied" to deviceOwner.setKeyguardDisabled(disabled),
                        ),
                    )
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_device_owner_set_lock_screen_info",
                        description = "Set Device Owner information displayed on the lock screen.",
                        inputSchema = objectSchema(
                            "text" to mapOf("type" to "string"),
                        ),
                    ),
                ) { args ->
                    val text = (args["text"] as? String)?.takeIf { it.isNotBlank() }
                    deviceOwner.setLockScreenInfo(text)
                    ToolResults.json(mapOf("set" to true, "text" to text))
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_device_owner_set_permission",
                        description = "Grant or deny another app runtime permission through DevicePolicyManager.",
                        inputSchema = objectSchema(
                            "package" to mapOf("type" to "string", "minLength" to 1),
                            "permission" to mapOf("type" to "string", "minLength" to 1),
                            "grant" to mapOf("type" to "boolean"),
                        ),
                    ),
                ) { args ->
                    val packageName = requireString(args, "package")
                    val permission = requireString(args, "permission")
                    val grant = requireBoolean(args, "grant")
                    ToolResults.json(
                        mapOf(
                            "package" to packageName,
                            "permission" to permission,
                            "grant" to grant,
                            "applied" to deviceOwner.setPermissionGrant(
                                packageName,
                                permission,
                                grant,
                            ),
                        ),
                    )
                },
            )
    }

    private fun shellTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_shell",
            description = "Run a shell command at app, Shizuku/Sui, or root privilege. Root and Shizuku require explicit owner authorization.",
            inputSchema = objectSchema(
                "command" to mapOf("type" to "string", "minLength" to 1),
                "level" to mapOf(
                    "type" to "string",
                    "enum" to listOf("auto", "normal", "shizuku", "root"),
                ),
                "timeoutMs" to mapOf(
                    "type" to "integer",
                    "minimum" to 1000,
                    "maximum" to 120000,
                ),
                "maxOutputBytes" to mapOf(
                    "type" to "integer",
                    "minimum" to 1024,
                    "maximum" to 262144,
                ),
            ),
        ),
    ) { args ->
        val command = requireString(args, "command")
        val requested = args["level"] as? String ?: "auto"
        val timeout = ((args["timeoutMs"] as? Number)?.toLong() ?: 30_000L)
            .coerceIn(1_000L, 120_000L)
        val maxOutput = ((args["maxOutputBytes"] as? Number)?.toInt() ?: 65_536)
            .coerceIn(1_024, 262_144)
        val result = when (requested) {
            "normal" -> ShellExecutor.normal(command, timeout, maxOutput)
            "shizuku" -> ShizukuBridge.execute(
                context,
                command,
                timeout,
                maxOutput,
            )
            "root" -> ShellExecutor.root(command, timeout, maxOutput)
            "auto" -> if (ShizukuBridge.permissionGranted()) {
                ShizukuBridge.execute(context, command, timeout, maxOutput)
            } else {
                ShellExecutor.normal(command, timeout, maxOutput)
            }
            else -> error("Unsupported shell level.")
        }
        ToolResults.json(result.toMap())
    }

    private fun ownerTool(
        name: String,
        description: String,
        handler: () -> io.github.shahidx0x.brc.android.protocol.ToolResult,
    ) = FunctionTool(
        ToolDefinition(
            name = name,
            description = description,
            inputSchema = emptySchema(),
        ),
    ) { handler() }

    private fun requireString(args: Map<String, Any?>, key: String): String =
        (args[key] as? String)?.takeIf { it.isNotBlank() }
            ?: error("$key is required")

    private fun requireBoolean(args: Map<String, Any?>, key: String): Boolean =
        args[key] as? Boolean ?: error("$key is required")

    private fun boolSchema(key: String): Map<String, Any?> =
        objectSchema(key to mapOf("type" to "boolean"))

    private fun emptySchema(): Map<String, Any?> =
        mapOf("type" to "object", "properties" to emptyMap<String, Any?>())

    private fun objectSchema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))
}
