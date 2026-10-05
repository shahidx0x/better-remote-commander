package io.github.shahidx0x.brc.android.privilege

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import rikka.shizuku.Shizuku
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

object ShizukuBridge {
    @Volatile
    private var remote: IShizukuShellService? = null

    fun binderAvailable(): Boolean =
        runCatching { Shizuku.pingBinder() }.getOrDefault(false)

    fun permissionGranted(): Boolean =
        binderAvailable() &&
            runCatching {
                Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
            }.getOrDefault(false)

    fun version(): Int? =
        if (!binderAvailable()) null
        else runCatching { Shizuku.getVersion() }.getOrNull()

    fun backendUid(): Int? =
        if (!binderAvailable()) null
        else runCatching { Shizuku.getUid() }.getOrNull()

    fun requestPermission(requestCode: Int = 7001): Boolean {
        require(binderAvailable()) {
            "Shizuku/Sui binder is not available. Start Shizuku or Sui first."
        }
        if (permissionGranted()) return true
        Shizuku.requestPermission(requestCode)
        return false
    }

    fun execute(
        context: Context,
        command: String,
        timeoutMs: Long,
        maxOutputBytes: Int,
    ): ShellExecution {
        require(permissionGranted()) {
            "Shizuku permission is not granted."
        }
        val service = ensureBound(context)
        val result = service.execute(
            command,
            timeoutMs.coerceIn(1_000L, 120_000L).toInt(),
            maxOutputBytes.coerceIn(1_024, 262_144),
        )
        return ShellExecution(
            level = result.getString("level") ?: "shizuku",
            uid = result.getInt("uid", -1).takeIf { it >= 0 },
            exitCode = if (result.getBoolean("hasExitCode")) {
                result.getInt("exitCode")
            } else {
                null
            },
            output = result.getString("output").orEmpty(),
            timedOut = result.getBoolean("timedOut"),
            truncated = result.getBoolean("truncated"),
        )
    }

    @Synchronized
    private fun ensureBound(context: Context): IShizukuShellService {
        remote?.let {
            if (it.asBinder().isBinderAlive) return it
            remote = null
        }

        val latch = CountDownLatch(1)
        var failure: String? = null
        val connection = object : ServiceConnection {
            override fun onServiceConnected(
                name: ComponentName?,
                binder: IBinder?,
            ) {
                if (binder == null) {
                    failure = "Shizuku returned a null UserService binder."
                } else {
                    remote = IShizukuShellService.Stub.asInterface(binder)
                }
                latch.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                remote = null
            }
        }

        val args = Shizuku.UserServiceArgs(
            ComponentName(context, ShizukuShellService::class.java),
        )
            .processNameSuffix("brc_shizuku")
            .daemon(false)
            .tag("brc-shell-v1")
            .version(1)

        runCatching {
            Shizuku.bindUserService(args, connection)
        }.onFailure {
            failure = it.message ?: "Failed to bind Shizuku UserService."
            latch.countDown()
        }

        require(latch.await(10, TimeUnit.SECONDS)) {
            "Timed out binding the Shizuku UserService."
        }
        failure?.let { error(it) }
        return remote ?: error("Shizuku UserService did not connect.")
    }
}
