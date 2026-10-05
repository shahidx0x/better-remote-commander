package io.github.shahidx0x.brc.android.transport

import io.github.shahidx0x.brc.android.protocol.BrcProtocol
import io.github.shahidx0x.brc.android.protocol.CallMessage
import io.github.shahidx0x.brc.android.protocol.ErrorMessage
import io.github.shahidx0x.brc.android.protocol.HelloMessage
import io.github.shahidx0x.brc.android.protocol.PingMessage
import io.github.shahidx0x.brc.android.protocol.PongMessage
import io.github.shahidx0x.brc.android.protocol.WelcomeMessage
import io.github.shahidx0x.brc.android.protocol.ResultMessage
import io.github.shahidx0x.brc.android.storage.DeviceCredentials
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.min

class RelayWebSocketClient(
    private val credentials: DeviceCredentials,
    private val helloProvider: () -> HelloMessage,
    private val callHandler: (CallMessage) -> ResultMessage,
    private val listener: Listener,
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .build(),
) {
    interface Listener {
        fun onStatus(status: String)
        fun onUnauthorized()
    }

    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val callExecutor = Executors.newSingleThreadExecutor()
    private var socket: WebSocket? = null
    private var reconnectFuture: ScheduledFuture<*>? = null
    private var watchdogFuture: ScheduledFuture<*>? = null
    @Volatile private var stopped = true
    private var backoffMs = RECONNECT_MIN_MS

    fun start() {
        if (!stopped) return
        stopped = false
        connect()
    }

    fun stop() {
        stopped = true
        reconnectFuture?.cancel(false)
        watchdogFuture?.cancel(false)
        socket?.close(1000, "agent stopped")
        socket = null
        listener.onStatus("Stopped")
    }

    fun reconnectNow() {
        if (stopped) return
        reconnectFuture?.cancel(false)
        socket?.cancel()
        socket = null
        scheduler.execute(::connect)
    }

    private fun connect() {
        if (stopped || socket != null) return
        listener.onStatus("Connecting")
        val request = Request.Builder()
            .url(toWebSocketUrl(credentials.relayUrl))
            .header("Authorization", "Bearer ${credentials.deviceToken}")
            .header("X-BRC-Protocol", BrcProtocol.VERSION.toString())
            .build()
        socket = http.newWebSocket(request, SocketListener())
    }

    private inner class SocketListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (stopped) {
                webSocket.close(1000, "agent stopped")
                return
            }
            backoffMs = RECONNECT_MIN_MS
            listener.onStatus("Connected")
            send(helloProvider())
            armWatchdog()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val message = BrcJsonCodec.decodeRelay(text) ?: return
            when (message) {
                is WelcomeMessage -> {
                    if (message.protocol != BrcProtocol.VERSION) {
                        listener.onStatus("Protocol mismatch")
                        webSocket.close(4400, "protocol mismatch")
                    } else {
                        listener.onStatus("Online")
                    }
                }

                is PingMessage -> {
                    armWatchdog()
                    send(PongMessage(message.ts))
                }

                is CallMessage -> callExecutor.execute {
                    val result = runCatching { callHandler(message) }.getOrElse {
                        ResultMessage(
                            id = message.id,
                            error = io.github.shahidx0x.brc.android.protocol.ResultError(
                                "AGENT_ERROR",
                                it.message ?: "Tool execution failed.",
                            ),
                        )
                    }
                    send(result)
                }

                is ErrorMessage -> {
                    listener.onStatus("Relay error: ${message.code}")
                    if (message.fatal) stop()
                }
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            socket = null
            watchdogFuture?.cancel(false)
            if (code == 4401 || code == 4403) {
                handleUnauthorized()
            } else {
                scheduleReconnect("Disconnected")
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            socket = null
            watchdogFuture?.cancel(false)
            if (response?.code == 401 || response?.code == 403) {
                handleUnauthorized()
            } else {
                scheduleReconnect("Connection failed")
            }
        }
    }

    @Synchronized
    private fun send(message: io.github.shahidx0x.brc.android.protocol.AgentMessage) {
        socket?.send(BrcJsonCodec.encode(message))
    }

    private fun armWatchdog() {
        watchdogFuture?.cancel(false)
        watchdogFuture = scheduler.schedule({
            if (!stopped) {
                listener.onStatus("Heartbeat timeout")
                socket?.cancel()
            }
        }, PONG_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }

    private fun scheduleReconnect(status: String) {
        if (stopped) return
        listener.onStatus("$status; retrying")
        val delay = backoffMs
        backoffMs = min(backoffMs * 2, RECONNECT_MAX_MS)
        reconnectFuture?.cancel(false)
        reconnectFuture = scheduler.schedule(::connect, delay, TimeUnit.MILLISECONDS)
    }

    private fun handleUnauthorized() {
        stopped = true
        listener.onStatus("Pairing required")
        listener.onUnauthorized()
    }

    companion object {
        private const val PONG_TIMEOUT_MS = 45_000L
        private const val RECONNECT_MIN_MS = 1_000L
        private const val RECONNECT_MAX_MS = 30_000L

        fun toWebSocketUrl(relayUrl: String): String {
            val base = PairingClient.normalizeRelayUrl(relayUrl)
            val withWsPath = if (base.endsWith("/ws")) base else "$base/ws"
            return when {
                withWsPath.startsWith("https://") ->
                    "wss://" + withWsPath.removePrefix("https://")
                withWsPath.startsWith("http://") ->
                    "ws://" + withWsPath.removePrefix("http://")
                else -> error("Unsupported relay URL.")
            }
        }
    }
}
