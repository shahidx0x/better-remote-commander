package io.github.shahidx0x.brc.android

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import io.github.shahidx0x.brc.android.core.AgentRuntime
import io.github.shahidx0x.brc.android.protocol.CallMessage
import io.github.shahidx0x.brc.android.service.BrcAgentService
import io.github.shahidx0x.brc.android.transport.PairingChallenge
import io.github.shahidx0x.brc.android.transport.PairingClient
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var runtime: AgentRuntime
    private lateinit var relayUrl: EditText
    private lateinit var deviceName: EditText
    private lateinit var status: TextView
    private lateinit var pairButton: Button
    private val worker = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        runtime = AgentRuntime(this)
        requestNotificationPermission()
        setContentView(buildUi())
        refreshStatus()
    }

    override fun onResume() {
        super.onResume()
        if (::status.isInitialized) refreshStatus()
    }

    override fun onDestroy() {
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun buildUi(): View {
        val density = resources.displayMetrics.density
        val padding = (20 * density).toInt()
        val spacing = (12 * density).toInt()

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
        }

        container.addView(TextView(this).apply {
            text = "BRC Android Agent"
            textSize = 24f
        })

        status = TextView(this).apply {
            textSize = 16f
            setPadding(0, spacing, 0, spacing)
        }
        container.addView(status)

        relayUrl = EditText(this).apply {
            hint = "Relay URL"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(runtime.preferences.relayUrl)
        }
        container.addView(relayUrl)

        val savedName = runtime.preferences.deviceName
        deviceName = EditText(this).apply {
            hint = "Device name"
            setText(savedName.ifBlank { runtime.identity.deviceLabel() })
        }
        container.addView(deviceName)

        pairButton = Button(this).apply {
            text = "Pair / Re-pair"
            setOnClickListener { beginPairing() }
        }
        container.addView(pairButton)

        container.addView(Button(this).apply {
            text = "Start Agent"
            setOnClickListener {
                runtime.preferences.agentEnabled = true
                BrcAgentService.start(this@MainActivity)
                status.postDelayed(::refreshStatus, 500)
            }
        })

        container.addView(Button(this).apply {
            text = "Stop Agent"
            setOnClickListener {
                BrcAgentService.stop(this@MainActivity)
                status.postDelayed(::refreshStatus, 300)
            }
        })

        container.addView(Button(this).apply {
            text = "Refresh Status"
            setOnClickListener { refreshStatus() }
        })

        return ScrollView(this).apply { addView(container) }
    }

    private fun beginPairing() {
        val relay = relayUrl.text.toString().trim()
        val name = deviceName.text.toString().trim()
        if (relay.isBlank() || name.isBlank()) {
            status.text = "Relay URL and device name are required."
            return
        }

        pairButton.isEnabled = false
        status.text = "Starting pairing…"
        worker.execute {
            runCatching {
                PairingClient().pair(
                    relayUrl = relay,
                    name = name,
                    deviceId = runtime.identity.getOrCreateDeviceId(),
                    onChallenge = ::showChallenge,
                )
            }.onSuccess { credentials ->
                runtime.credentials.save(credentials)
                runtime.identity.setDeviceId(credentials.deviceId)
                runtime.preferences.relayUrl = credentials.relayUrl
                runtime.preferences.deviceName = credentials.name
                runtime.preferences.agentEnabled = true
                runOnUiThread {
                    pairButton.isEnabled = true
                    status.text = "Paired. Starting BRC Agent…"
                    BrcAgentService.start(this)
                    status.postDelayed(::refreshStatus, 750)
                }
            }.onFailure { error ->
                runOnUiThread {
                    pairButton.isEnabled = true
                    status.text = "Pairing failed: ${error.message ?: "unknown error"}"
                }
            }
        }
    }

    private fun showChallenge(challenge: PairingChallenge) {
        runOnUiThread {
            status.text = buildString {
                appendLine("Pairing approval required")
                appendLine("Code: ${challenge.userCode}")
                append("Complete pairing in your browser.")
            }
            val target = challenge.verificationUriComplete
                .ifBlank { challenge.verificationUri }
            runCatching {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target)))
            }
        }
    }

    private fun refreshStatus() {
        val credentials = runtime.credentials.load()
        val selfCheck = runtime.dispatch(
            CallMessage(id = "ui-self-check", tool = "android_ping"),
        )
        status.text = buildString {
            appendLine("Stage 2 — Pairing + Relay")
            appendLine("Connection: ${runtime.preferences.connectionStatus}")
            appendLine("Paired: ${credentials != null}")
            appendLine("Enabled: ${runtime.preferences.agentEnabled}")
            appendLine("Device ID: ${runtime.identity.getOrCreateDeviceId()}")
            appendLine("Android API: ${Build.VERSION.SDK_INT}")
            appendLine("Tools: ${runtime.registry.definitions().joinToString { it.name }}")
            append("Self-check: ${if (selfCheck.error == null) "PASS" else "FAIL"}")
        }
    }

    private fun requestNotificationPermission() {
        if (
            Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
        }
    }
}
