package io.github.shahidx0x.brc.android.tools

import android.content.Context
import io.github.shahidx0x.brc.android.accessibility.AccessibilityToolProvider
import io.github.shahidx0x.brc.android.accessibility.ScreenshotToolProvider
import io.github.shahidx0x.brc.android.apps.AppToolProvider
import io.github.shahidx0x.brc.android.files.FileToolProvider
import io.github.shahidx0x.brc.android.files.FileTransferToolProvider
import io.github.shahidx0x.brc.android.settings.SettingsToolProvider

object AndroidToolCatalog {
    fun create(context: Context): ToolRegistry =
        ToolRegistry()
            .register(PingTool())
            .register(CapabilityTool(context.applicationContext))
            .also { DeviceToolProvider.register(context.applicationContext, it) }
            .also { FileToolProvider.register(context.applicationContext, it) }
            .also { FileTransferToolProvider.register(context.applicationContext, it) }
            .also { AccessibilityToolProvider.register(it) }
            .also { ScreenshotToolProvider.register(it) }
            .also { AppToolProvider.register(context.applicationContext, it) }
            .also { SettingsToolProvider.register(context.applicationContext, it) }
}
