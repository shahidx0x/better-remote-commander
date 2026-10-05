package io.github.shahidx0x.brc.android.core

import android.os.Build
import io.github.shahidx0x.brc.android.protocol.BrcProtocol
import io.github.shahidx0x.brc.android.protocol.DeviceInfo

class DeviceInfoProvider(
    private val identityStore: DeviceIdentityStore,
) {
    fun snapshot(): DeviceInfo = DeviceInfo(
        deviceId = identityStore.getOrCreateDeviceId(),
        name = identityStore.deviceLabel(),
        platform = BrcProtocol.PLATFORM,
        arch = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown",
        hostname = Build.DEVICE.ifBlank { Build.MODEL },
        agentVersion = "0.1.0-dev",
        coreVersion = "1",
    )
}
