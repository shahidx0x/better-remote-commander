package io.github.shahidx0x.brc.android.core

import android.os.Build
import io.github.shahidx0x.brc.android.protocol.BrcProtocol

enum class Capability(val wireName: String) {
    DEVICE_IDENTITY("device_identity"),
    TOOL_DISPATCH("tool_dispatch"),
}

data class CapabilitySnapshot(
    val platform: String,
    val androidApi: Int,
    val protocolVersion: Int,
    val capabilities: Set<String>,
)

class CapabilityManager {
    fun snapshot(): CapabilitySnapshot = CapabilitySnapshot(
        platform = BrcProtocol.PLATFORM,
        androidApi = Build.VERSION.SDK_INT,
        protocolVersion = BrcProtocol.VERSION,
        capabilities = Capability.entries.mapTo(linkedSetOf()) { it.wireName },
    )
}
