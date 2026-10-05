package io.github.shahidx0x.brc.android.privilege

import android.os.Process
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

data class ShellExecution(
    val level: String,
    val uid: Int?,
    val exitCode: Int?,
    val output: String,
    val timedOut: Boolean,
    val truncated: Boolean,
) {
    fun toMap(): Map<String, Any?> = linkedMapOf(
        "level" to level,
        "uid" to uid,
        "exitCode" to exitCode,
        "timedOut" to timedOut,
        "truncated" to truncated,
        "output" to output,
    )
}

object ShellExecutor {
    fun normal(
        command: String,
        timeoutMs: Long,
        maxOutputBytes: Int,
    ): ShellExecution =
        executeProcess(
            command = listOf("/system/bin/sh", "-c", command),
            timeoutMs = timeoutMs,
            maxOutputBytes = maxOutputBytes,
            level = "normal",
            uid = Process.myUid(),
        )

    fun root(
        command: String,
        timeoutMs: Long,
        maxOutputBytes: Int,
    ): ShellExecution {
        val su = findSu() ?: error("Root binary (su) is not installed.")
        return executeProcess(
            command = listOf(su, "-c", command),
            timeoutMs = timeoutMs,
            maxOutputBytes = maxOutputBytes,
            level = "root",
            uid = 0,
        )
    }

    fun rootInstalled(): Boolean = findSu() != null

    fun executeProcess(
        command: List<String>,
        timeoutMs: Long,
        maxOutputBytes: Int,
        level: String,
        uid: Int?,
    ): ShellExecution {
        val safeTimeout = timeoutMs.coerceIn(1_000L, 120_000L)
        val safeLimit = maxOutputBytes.coerceIn(1_024, 262_144)
        val process = ProcessBuilder(command)
            .redirectErrorStream(true)
            .start()
        val bytes = ByteArrayOutputStream()
        val truncated = AtomicBoolean(false)

        val reader = Thread({
            process.inputStream.use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    val remaining = safeLimit - bytes.size()
                    if (remaining > 0) {
                        bytes.write(buffer, 0, minOf(remaining, count))
                    }
                    if (count > remaining) truncated.set(true)
                }
            }
        }, "brc-shell-output").apply {
            isDaemon = true
            start()
        }

        val finished = process.waitFor(safeTimeout, TimeUnit.MILLISECONDS)
        if (!finished) {
            process.destroy()
            if (!process.waitFor(500, TimeUnit.MILLISECONDS)) {
                process.destroyForcibly()
            }
        }
        reader.join(1_500)

        return ShellExecution(
            level = level,
            uid = uid,
            exitCode = if (finished) process.exitValue() else null,
            output = bytes.toString(StandardCharsets.UTF_8.name()),
            timedOut = !finished,
            truncated = truncated.get(),
        )
    }

    private fun findSu(): String? {
        val candidates = mutableListOf(
            "/system/bin/su",
            "/system/xbin/su",
            "/sbin/su",
            "/su/bin/su",
            "/data/adb/magisk/su",
        )
        System.getenv("PATH")
            .orEmpty()
            .split(File.pathSeparator)
            .filter { it.isNotBlank() }
            .forEach { candidates += File(it, "su").absolutePath }
        return candidates.distinct().firstOrNull {
            runCatching { File(it).exists() && File(it).canExecute() }.getOrDefault(false)
        }
    }
}
