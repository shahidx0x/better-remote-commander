package io.github.shahidx0x.brc.android.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import io.github.shahidx0x.brc.android.core.AgentRuntime
import io.github.shahidx0x.brc.android.protocol.CallMessage
import io.github.shahidx0x.brc.android.transport.BrcJsonCodec

class DebugToolReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val tool = intent.getStringExtra("tool")
            ?: return setResultData("""{"error":"tool is required"}""")
        val extras = intent.extras
        val args = extras?.keySet()
            ?.filter { it != "tool" }
            ?.associateWith { key -> extras.get(key) }
            .orEmpty()
        val result = AgentRuntime(context).dispatch(
            CallMessage(
                id = "adb-debug",
                tool = tool,
                args = args,
            ),
        )
        setResultData(BrcJsonCodec.encode(result))
    }
}
