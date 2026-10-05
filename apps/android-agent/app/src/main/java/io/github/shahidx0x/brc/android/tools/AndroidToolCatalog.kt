package io.github.shahidx0x.brc.android.tools

import android.content.Context

object AndroidToolCatalog {
    fun create(context: Context): ToolRegistry =
        ToolRegistry()
            .register(PingTool())
            .register(CapabilityTool(context.applicationContext))
            .also { DeviceToolProvider.register(context.applicationContext, it) }
}
