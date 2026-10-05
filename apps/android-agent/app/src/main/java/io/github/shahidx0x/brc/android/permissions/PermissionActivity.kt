package io.github.shahidx0x.brc.android.permissions

import android.Manifest
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import io.github.shahidx0x.brc.android.core.CapabilityManager

class PermissionActivity : Activity() {
    private lateinit var summary: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
    }

    override fun onResume() {
        super.onResume()
        if (::summary.isInitialized) refresh()
    }

    private fun buildUi(): ScrollView {
        val padding = (20 * resources.displayMetrics.density).toInt()
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
        }

        container.addView(TextView(this).apply {
            text = "BRC Permission Dashboard"
            textSize = 24f
        })
        summary = TextView(this).apply {
            textSize = 15f
            setPadding(0, padding / 2, 0, padding / 2)
        }
        container.addView(summary)

        addButton(container, "Grant runtime permissions") {
            requestRuntimePermissions()
        }
        addButton(container, "Accessibility") {
            PermissionNavigator.open(this, "accessibility")
        }
        addButton(container, "Notification access") {
            PermissionNavigator.open(this, "notifications")
        }
        addButton(container, "Display over other apps") {
            PermissionNavigator.open(this, "overlay")
        }
        addButton(container, "Modify system settings") {
            PermissionNavigator.open(this, "write_settings")
        }
        addButton(container, "All files access") {
            PermissionNavigator.open(this, "all_files")
        }
        addButton(container, "Battery optimization") {
            PermissionNavigator.open(this, "battery")
        }
        addButton(container, "App permission details") {
            PermissionNavigator.open(this, "app")
        }

        return ScrollView(this).apply { addView(container) }
    }

    private fun addButton(
        parent: LinearLayout,
        label: String,
        action: () -> Unit,
    ) {
        parent.addView(Button(this).apply {
            text = label
            setOnClickListener { action() }
        })
    }

    private fun refresh() {
        val snapshot = CapabilityManager(this).snapshot()
        summary.text = buildString {
            appendLine("Android API: ${snapshot.androidApi}")
            snapshot.capabilities.forEach { (key, value) ->
                appendLine("${if (value == true) "✓" else "•"} $key: $value")
            }
        }
    }

    private fun requestRuntimePermissions() {
        val requested = mutableListOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.READ_CONTACTS,
            Manifest.permission.WRITE_CONTACTS,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.WRITE_CALL_LOG,
            Manifest.permission.READ_SMS,
            Manifest.permission.SEND_SMS,
            Manifest.permission.RECEIVE_SMS,
        )
        if (Build.VERSION.SDK_INT >= 31) {
            requested += Manifest.permission.BLUETOOTH_SCAN
            requested += Manifest.permission.BLUETOOTH_CONNECT
        }
        if (Build.VERSION.SDK_INT >= 33) {
            requested += Manifest.permission.POST_NOTIFICATIONS
            requested += Manifest.permission.READ_MEDIA_IMAGES
            requested += Manifest.permission.READ_MEDIA_VIDEO
            requested += Manifest.permission.READ_MEDIA_AUDIO
        }
        requestPermissions(requested.distinct().toTypedArray(), 200)
    }
}
