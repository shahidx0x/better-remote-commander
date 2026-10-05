package io.github.shahidx0x.brc.android.apps

import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object AppToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val app = context.applicationContext
        registry
            .register(listAppsTool(app))
            .register(appInfoTool(app))
            .register(openAppTool(app))
            .register(openActivityTool(app))
            .register(openAppSettingsTool(app))
            .register(closeAppTool(app))
            .register(uninstallAppTool(app))
            .register(openIntentTool(app))
    }

    private fun listAppsTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_list_apps",
            description = "List applications installed on the Android device.",
            inputSchema = objectSchema(
                "includeSystem" to mapOf("type" to "boolean"),
                "limit" to mapOf("type" to "integer", "minimum" to 1, "maximum" to 1000),
            ),
        ),
    ) { args ->
        val includeSystem = args["includeSystem"] as? Boolean ?: false
        val limit = ((args["limit"] as? Number)?.toInt() ?: 300).coerceIn(1, 1000)
        val pm = context.packageManager
        val apps = installedApplications(pm)
            .asSequence()
            .filter {
                includeSystem || (it.flags and ApplicationInfo.FLAG_SYSTEM) == 0
            }
            .sortedBy { pm.getApplicationLabel(it).toString().lowercase() }
            .take(limit)
            .map { info ->
                mapOf(
                    "package" to info.packageName,
                    "label" to pm.getApplicationLabel(info).toString(),
                    "system" to ((info.flags and ApplicationInfo.FLAG_SYSTEM) != 0),
                    "enabled" to info.enabled,
                    "targetSdk" to info.targetSdkVersion,
                )
            }
            .toList()
        ToolResults.json(mapOf("count" to apps.size, "apps" to apps))
    }

    private fun appInfoTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_app_info",
            description = "Return package metadata for an installed Android app.",
            inputSchema = objectSchema(
                "package" to mapOf("type" to "string", "minLength" to 1),
            ),
        ),
    ) { args ->
        val packageName = requireString(args, "package")
        val pm = context.packageManager
        val info = packageInfo(pm, packageName)
        val app = info.applicationInfo ?: error("Package has no application info.")
        ToolResults.json(
            linkedMapOf(
                "package" to packageName,
                "label" to pm.getApplicationLabel(app).toString(),
                "versionName" to info.versionName,
                "versionCode" to if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else
                    @Suppress("DEPRECATION") info.versionCode.toLong(),
                "targetSdk" to app.targetSdkVersion,
                "minSdk" to if (Build.VERSION.SDK_INT >= 24) app.minSdkVersion else null,
                "system" to ((app.flags and ApplicationInfo.FLAG_SYSTEM) != 0),
                "enabled" to app.enabled,
                "sourceDir" to app.sourceDir,
                "launchable" to (pm.getLaunchIntentForPackage(packageName) != null),
            ),
        )
    }

    private fun openAppTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_open_app",
            description = "Launch an installed Android application by package name.",
            inputSchema = objectSchema(
                "package" to mapOf("type" to "string", "minLength" to 1),
            ),
        ),
    ) { args ->
        val packageName = requireString(args, "package")
        val intent = context.packageManager.getLaunchIntentForPackage(packageName)
            ?: error("App is not installed or has no launchable activity.")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        ToolResults.json(mapOf("opened" to true, "package" to packageName))
    }

    private fun openActivityTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_open_activity",
            description = "Launch an exported Android activity by package/class, optionally with an action and URI.",
            inputSchema = objectSchema(
                "package" to mapOf("type" to "string", "minLength" to 1),
                "className" to mapOf("type" to "string", "minLength" to 1),
                "action" to mapOf("type" to "string"),
                "data" to mapOf("type" to "string"),
            ),
        ),
    ) { args ->
        val packageName = requireString(args, "package")
        val className = requireString(args, "className")
        val intent = Intent(args["action"] as? String ?: Intent.ACTION_VIEW)
            .setComponent(ComponentName(packageName, className))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        (args["data"] as? String)?.takeIf { it.isNotBlank() }?.let {
            intent.data = Uri.parse(it)
        }
        context.startActivity(intent)
        ToolResults.json(
            mapOf("opened" to true, "package" to packageName, "className" to className),
        )
    }

    private fun openAppSettingsTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_open_app_settings",
            description = "Open Android's system app-info page for a package.",
            inputSchema = objectSchema(
                "package" to mapOf("type" to "string", "minLength" to 1),
            ),
        ),
    ) { args ->
        val packageName = requireString(args, "package")
        context.startActivity(
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:$packageName"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        ToolResults.json(mapOf("opened" to true, "package" to packageName))
    }

    private fun closeAppTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_close_app",
            description = "Request Android to kill background processes for a package. Android may ignore this for protected or foreground apps.",
            inputSchema = objectSchema(
                "package" to mapOf("type" to "string", "minLength" to 1),
            ),
        ),
    ) { args ->
        val packageName = requireString(args, "package")
        (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager)
            .killBackgroundProcesses(packageName)
        ToolResults.json(
            mapOf(
                "requested" to true,
                "package" to packageName,
                "note" to "Android decides whether the process is actually stopped.",
            ),
        )
    }

    private fun uninstallAppTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_uninstall_app",
            description = "Open Android's owner-visible uninstall confirmation for a package.",
            inputSchema = objectSchema(
                "package" to mapOf("type" to "string", "minLength" to 1),
            ),
        ),
    ) { args ->
        val packageName = requireString(args, "package")
        context.startActivity(
            Intent(Intent.ACTION_DELETE, Uri.parse("package:$packageName"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        ToolResults.json(
            mapOf("prompted" to true, "package" to packageName),
        )
    }

    private fun openIntentTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_open_intent",
            description = "Launch an owner-authorized Android intent using an action, optional URI/package, and primitive extras.",
            inputSchema = objectSchema(
                "action" to mapOf("type" to "string", "minLength" to 1),
                "data" to mapOf("type" to "string"),
                "package" to mapOf("type" to "string"),
                "extras" to mapOf("type" to "object"),
            ),
        ),
    ) { args ->
        val action = requireString(args, "action")
        val intent = Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        (args["data"] as? String)?.takeIf { it.isNotBlank() }?.let {
            intent.data = Uri.parse(it)
        }
        (args["package"] as? String)?.takeIf { it.isNotBlank() }?.let {
            intent.setPackage(it)
        }
        @Suppress("UNCHECKED_CAST")
        (args["extras"] as? Map<String, Any?>).orEmpty().forEach { (key, value) ->
            when (value) {
                is String -> intent.putExtra(key, value)
                is Boolean -> intent.putExtra(key, value)
                is Int -> intent.putExtra(key, value)
                is Long -> intent.putExtra(key, value)
                is Double -> intent.putExtra(key, value)
                is Number -> intent.putExtra(key, value.toDouble())
            }
        }
        context.startActivity(intent)
        ToolResults.json(mapOf("opened" to true, "action" to action))
    }

    @Suppress("DEPRECATION")
    private fun installedApplications(pm: PackageManager): List<ApplicationInfo> =
        if (Build.VERSION.SDK_INT >= 33) {
            pm.getInstalledApplications(PackageManager.ApplicationInfoFlags.of(0))
        } else {
            pm.getInstalledApplications(0)
        }

    @Suppress("DEPRECATION")
    private fun packageInfo(pm: PackageManager, packageName: String) =
        if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
            pm.getPackageInfo(packageName, 0)
        }

    private fun requireString(args: Map<String, Any?>, key: String): String =
        (args[key] as? String)?.takeIf { it.isNotBlank() }
            ?: error("$key is required")

    private fun objectSchema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))
}
