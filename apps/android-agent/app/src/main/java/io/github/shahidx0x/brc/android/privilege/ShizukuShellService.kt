package io.github.shahidx0x.brc.android.privilege

import android.os.Bundle
import android.os.Process
import kotlin.system.exitProcess

class ShizukuShellService : IShizukuShellService.Stub() {
    override fun execute(
        command: String,
        timeoutMs: Int,
        maxOutputBytes: Int,
    ): Bundle {
        val result = ShellExecutor.executeProcess(
            command = listOf("/system/bin/sh", "-c", command),
            timeoutMs = timeoutMs.toLong(),
            maxOutputBytes = maxOutputBytes,
            level = "shizuku",
            uid = Process.myUid(),
        )
        return Bundle().apply {
            putString("level", result.level)
            putInt("uid", result.uid ?: -1)
            if (result.exitCode != null) putInt("exitCode", result.exitCode)
            putBoolean("hasExitCode", result.exitCode != null)
            putString("output", result.output)
            putBoolean("timedOut", result.timedOut)
            putBoolean("truncated", result.truncated)
        }
    }

    override fun uid(): Int = Process.myUid()

    override fun destroy() {
        exitProcess(0)
    }
}
