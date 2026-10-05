package io.github.shahidx0x.brc.android.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import io.github.shahidx0x.brc.android.service.BrcAgentService
import io.github.shahidx0x.brc.android.storage.AgentPreferences
import io.github.shahidx0x.brc.android.storage.SecureCredentialStore

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val supported = intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_MY_PACKAGE_REPLACED
        if (!supported) return

        val enabled = runCatching {
            AgentPreferences(context).agentEnabled &&
                SecureCredentialStore(context).load() != null
        }.getOrDefault(false)

        if (enabled) {
            runCatching { BrcAgentService.start(context) }
        }
    }
}
