package io.github.shahidx0x.brc.android.tools

import android.content.Context
import io.github.shahidx0x.brc.android.files.FileToolProvider
import io.github.shahidx0x.brc.android.files.FileTransferToolProvider

object AndroidToolCatalog {
    fun create(context: Context): ToolRegistry =
        ToolRegistry()
            .register(PingTool())
            .register(CapabilityTool(context.applicationContext))
            .also { DeviceToolProvider.register(context.applicationContext, it) }
            .also { FileToolProvider.register(context.applicationContext, it) }
            .also { FileTransferToolProvider.register(context.applicationContext, it) }
}
