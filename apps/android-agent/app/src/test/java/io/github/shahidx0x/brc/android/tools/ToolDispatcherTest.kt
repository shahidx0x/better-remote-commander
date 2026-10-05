package io.github.shahidx0x.brc.android.tools

import io.github.shahidx0x.brc.android.protocol.CallMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class ToolDispatcherTest {
    private val registry = ToolRegistry().register(PingTool())
    private val dispatcher = ToolDispatcher(registry)

    @Test
    fun dispatchesRegisteredTool() {
        val result = dispatcher.dispatch(
            CallMessage(id = "request-1", tool = "android_ping"),
        )

        assertNull(result.error)
        assertNotNull(result.result)
        assertEquals("result", result.type)
    }

    @Test
    fun rejectsUnknownTool() {
        val result = dispatcher.dispatch(
            CallMessage(id = "request-2", tool = "missing"),
        )

        assertEquals("TOOL_NOT_FOUND", result.error?.code)
        assertNull(result.result)
    }
}
