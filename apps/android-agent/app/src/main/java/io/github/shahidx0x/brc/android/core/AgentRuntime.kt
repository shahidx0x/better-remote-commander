package io.github.shahidx0x.brc.android.core

import android.content.Context
import io.github.shahidx0x.brc.android.protocol.BrcProtocol
import io.github.shahidx0x.brc.android.protocol.CallMessage
import io.github.shahidx0x.brc.android.protocol.HelloMessage
import io.github.shahidx0x.brc.android.protocol.ResultMessage
import io.github.shahidx0x.brc.android.storage.AgentPreferences
import io.github.shahidx0x.brc.android.storage.DeviceCredentials
import io.github.shahidx0x.brc.android.storage.SecureCredentialStore
import io.github.shahidx0x.brc.android.tools.CapabilityTool
import io.github.shahidx0x.brc.android.tools.PingTool
import io.github.shahidx0x.brc.android.tools.ToolDispatcher
import io.github.shahidx0x.brc.android.tools.ToolRegistry

class AgentRuntime(context: Context) {
    val appContext: Context = context.applicationContext
    val preferences = AgentPreferences(appContext)
    val credentials = SecureCredentialStore(appContext)
    val identity = DeviceIdentityStore(appContext)
    val capabilities = CapabilityManager(appContext)

    val registry: ToolRegistry = ToolRegistry()
        .register(PingTool())
        .register(CapabilityTool(appContext))

    private val dispatcher = ToolDispatcher(registry)

    fun hello(credentials: DeviceCredentials): HelloMessage = HelloMessage(
        protocol = BrcProtocol.VERSION,
        device = DeviceInfoProvider(identity).snapshot().copy(
            deviceId = credentials.deviceId,
            name = credentials.name,
        ),
        tools = registry.definitions(),
    )

    fun dispatch(call: CallMessage): ResultMessage = dispatcher.dispatch(call)
}
