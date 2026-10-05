package io.github.shahidx0x.brc.android.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.IBinder
import android.os.PowerManager
import io.github.shahidx0x.brc.android.MainActivity
import io.github.shahidx0x.brc.android.core.AgentRuntime
import io.github.shahidx0x.brc.android.protocol.CallMessage
import io.github.shahidx0x.brc.android.protocol.ResultMessage
import io.github.shahidx0x.brc.android.transport.RelayWebSocketClient

class BrcAgentService : Service(), RelayWebSocketClient.Listener {
    private lateinit var runtime: AgentRuntime
    private var relay: RelayWebSocketClient? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        runtime = AgentRuntime(this)
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, notification("Starting"))
        registerNetworkCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action ?: ACTION_START) {
            ACTION_STOP -> {
                runtime.preferences.agentEnabled = false
                relay?.stop()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_RECONNECT -> relay?.reconnectNow()
            else -> startAgent()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        relay?.stop()
        relay = null
        networkCallback?.let {
            runCatching {
                (getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager)
                    .unregisterNetworkCallback(it)
            }
        }
        networkCallback = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStatus(status: String) {
        runtime.preferences.connectionStatus = status
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIFICATION_ID, notification(status))
    }

    override fun onUnauthorized() {
        runtime.credentials.clear()
        runtime.preferences.agentEnabled = false
    }

    private fun startAgent() {
        val credentials = runtime.credentials.load()
        if (credentials == null) {
            onStatus("Pairing required")
            return
        }

        runtime.preferences.agentEnabled = true
        if (relay != null) return
        relay = RelayWebSocketClient(
            credentials = credentials,
            helloProvider = { runtime.hello(credentials) },
            callHandler = ::executeToolCall,
            listener = this,
        ).also { it.start() }
    }

    private fun executeToolCall(call: CallMessage): ResultMessage {
        val power = getSystemService(POWER_SERVICE) as PowerManager
        val wakeLock = power.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "BRC:remote-tool-call",
        )
        val requested = call.timeoutMs ?: 120_000L
        wakeLock.acquire(requested.coerceIn(5_000L, 180_000L))
        return try {
            runtime.dispatch(call)
        } finally {
            if (wakeLock.isHeld) wakeLock.release()
        }
    }

    private fun registerNetworkCallback() {
        val manager = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                relay?.reconnectNow()
            }
        }
        manager.registerDefaultNetworkCallback(callback)
        networkCallback = callback
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "BRC Agent",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Keeps the owner-authorized BRC agent connected."
                setShowBadge(false)
            },
        )
    }

    private fun notification(status: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this,
            2,
            Intent(this, BrcAgentService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("BRC Agent")
            .setContentText(status)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .addAction(
                Notification.Action.Builder(
                    null,
                    "Stop",
                    stopIntent,
                ).build(),
            )
            .build()
    }

    companion object {
        const val ACTION_START = "io.github.shahidx0x.brc.android.action.START"
        const val ACTION_STOP = "io.github.shahidx0x.brc.android.action.STOP"
        const val ACTION_RECONNECT = "io.github.shahidx0x.brc.android.action.RECONNECT"
        private const val CHANNEL_ID = "brc_agent_connection"
        private const val NOTIFICATION_ID = 1001

        fun start(context: Context) {
            val intent = Intent(context, BrcAgentService::class.java)
                .setAction(ACTION_START)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, BrcAgentService::class.java)
                .setAction(ACTION_STOP)
            context.startService(intent)
        }
    }
}
