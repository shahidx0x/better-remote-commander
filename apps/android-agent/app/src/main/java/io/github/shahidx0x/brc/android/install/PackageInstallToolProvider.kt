package io.github.shahidx0x.brc.android.install

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.provider.Settings
import io.github.shahidx0x.brc.android.files.FileAccessPolicy
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object PackageInstallToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val app = context.applicationContext
        registry
            .register(installTool(app))
            .register(statusTool(app))
    }

    private fun installTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_install_apk",
            description = "Submit an APK through Android PackageInstaller. Android may require an owner-visible confirmation notification.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "path" to mapOf("type" to "string", "minLength" to 1),
                ),
                "required" to listOf("path"),
            ),
        ),
    ) { args ->
        require(context.packageManager.canRequestPackageInstalls()) {
            "Install unknown apps access is not granted. Open the unknown_sources settings page first."
        }
        val rawPath = (args["path"] as? String)?.takeIf { it.isNotBlank() }
            ?: error("path is required")
        val file = FileAccessPolicy(context).resolve(rawPath)
        require(file.isFile && file.extension.equals("apk", ignoreCase = true)) {
            "path must be an accessible APK file."
        }

        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(
            PackageInstaller.SessionParams.MODE_FULL_INSTALL,
        ).apply {
            setSize(file.length())
        }
        val sessionId = installer.createSession(params)
        val store = InstallStatusStore(context)
        try {
            installer.openSession(sessionId).use { session ->
                file.inputStream().use { input ->
                    session.openWrite("base.apk", 0, file.length()).use { output ->
                        input.copyTo(output)
                        session.fsync(output)
                    }
                }
                val callback = PendingIntent.getBroadcast(
                    context,
                    sessionId,
                    Intent(context, InstallResultReceiver::class.java)
                        .setAction(InstallResultReceiver.ACTION_INSTALL_STATUS),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
                )
                store.update(
                    sessionId,
                    null,
                    "submitted",
                    packageName = null,
                )
                session.commit(callback.intentSender)
            }
        } catch (error: Throwable) {
            runCatching { installer.abandonSession(sessionId) }
            store.update(
                sessionId,
                PackageInstaller.STATUS_FAILURE,
                "failed",
                error.message,
            )
            throw error
        }

        ToolResults.json(
            mapOf(
                "sessionId" to sessionId,
                "state" to "submitted",
                "path" to file.absolutePath,
                "bytes" to file.length(),
            ),
        )
    }

    private fun statusTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_install_status",
            description = "Return recent BRC PackageInstaller session status.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "sessionId" to mapOf("type" to "integer", "minimum" to 0),
                ),
            ),
        ),
    ) { args ->
        val store = InstallStatusStore(context)
        val sessionId = (args["sessionId"] as? Number)?.toInt()
        ToolResults.json(
            if (sessionId != null) {
                mapOf(
                    "session" to store.get(sessionId),
                    "canRequestPackageInstalls" to
                        context.packageManager.canRequestPackageInstalls(),
                )
            } else {
                mapOf(
                    "latest" to store.latest(),
                    "sessions" to store.list(),
                    "canRequestPackageInstalls" to
                        context.packageManager.canRequestPackageInstalls(),
                )
            },
        )
    }
}
