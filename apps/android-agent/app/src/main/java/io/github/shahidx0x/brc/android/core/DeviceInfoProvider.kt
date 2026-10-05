package io.github.shahidx0x.brc.android.core

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import io.github.shahidx0x.brc.android.protocol.BrcProtocol
import io.github.shahidx0x.brc.android.protocol.DeviceInfo

class DeviceInfoProvider(
    context: Context,
    private val identityStore: DeviceIdentityStore,
) {
    private val appContext = context.applicationContext

    fun snapshot(): DeviceInfo = DeviceInfo(
        deviceId = identityStore.getOrCreateDeviceId(),
        name = identityStore.deviceLabel(),
        platform = BrcProtocol.PLATFORM,
        arch = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown",
        hostname = Build.DEVICE.ifBlank { Build.MODEL },
        agentVersion = installedVersion(),
        coreVersion = BrcProtocol.VERSION.toString(),
    )

    @Suppress("DEPRECATION")
    private fun installedVersion(): String =
        if (Build.VERSION.SDK_INT >= 33) {
            appContext.packageManager.getPackageInfo(
                appContext.packageName,
                PackageManager.PackageInfoFlags.of(0),
            ).versionName ?: "unknown"
        } else {
            appContext.packageManager.getPackageInfo(
                appContext.packageName,
                0,
            ).versionName ?: "unknown"
        }
}
