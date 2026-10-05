package io.github.shahidx0x.brc.android.core

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.app.role.RoleManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import io.github.shahidx0x.brc.android.accessibility.BrcAccessibilityService
import io.github.shahidx0x.brc.android.files.FileTransferManager
import io.github.shahidx0x.brc.android.protocol.BrcProtocol
import io.github.shahidx0x.brc.android.privilege.ShellExecutor
import io.github.shahidx0x.brc.android.privilege.ShizukuBridge
import io.github.shahidx0x.brc.android.storage.AgentPreferences

data class CapabilitySnapshot(
    val platform: String,
    val androidApi: Int,
    val protocolVersion: Int,
    val capabilities: Map<String, Any?>,
)

class CapabilityManager(private val context: Context) {
    fun snapshot(): CapabilitySnapshot = CapabilitySnapshot(
        platform = BrcProtocol.PLATFORM,
        androidApi = Build.VERSION.SDK_INT,
        protocolVersion = BrcProtocol.VERSION,
        capabilities = linkedMapOf(
            "relay" to true,
            "foregroundService" to AgentPreferences(context).agentEnabled,
            "bootStart" to true,
            "deviceIdentity" to true,
            "toolDispatch" to true,
            "accessibility" to accessibilityEnabled(),
            "accessibilityConnected" to BrcAccessibilityService.isConnected,
            "screenCapture" to (
                Build.VERSION.SDK_INT >= 30 &&
                    accessibilityEnabled()
                ),
            "notificationAccess" to notificationAccessEnabled(),
            "overlay" to Settings.canDrawOverlays(context),
            "writeSettings" to Settings.System.canWrite(context),
            "batteryUnrestricted" to batteryUnrestricted(),
            "allFilesAccess" to allFilesAccess(),
            "encryptedFileTransfer" to FileTransferManager.cryptoAvailable(),
            "camera" to has(Manifest.permission.CAMERA),
            "microphone" to has(Manifest.permission.RECORD_AUDIO),
            "location" to has(Manifest.permission.ACCESS_FINE_LOCATION),
            "contactsRead" to has(Manifest.permission.READ_CONTACTS),
            "contactsWrite" to has(Manifest.permission.WRITE_CONTACTS),
            "phone" to has(Manifest.permission.CALL_PHONE),
            "phoneState" to has(Manifest.permission.READ_PHONE_STATE),
            "callLogRead" to has(Manifest.permission.READ_CALL_LOG),
            "callLogWrite" to has(Manifest.permission.WRITE_CALL_LOG),
            "smsRead" to has(Manifest.permission.READ_SMS),
            "smsSend" to has(Manifest.permission.SEND_SMS),
            "defaultSmsRole" to defaultSmsRole(),
            "bluetooth" to bluetoothPermission(),
            "deviceOwner" to deviceOwner(),
            "shizuku" to ShizukuBridge.binderAvailable(),
            "shizukuPermission" to ShizukuBridge.permissionGranted(),
            "root" to ShellExecutor.rootInstalled(),
        ),
    )

    private fun has(permission: String): Boolean =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun accessibilityEnabled(): Boolean {
        val target = ComponentName(context, BrcAccessibilityService::class.java)
            .flattenToString()
        val enabled = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ).orEmpty()
        return enabled.split(':').any { it.equals(target, ignoreCase = true) }
    }

    private fun notificationAccessEnabled(): Boolean =
        Settings.Secure.getString(
            context.contentResolver,
            "enabled_notification_listeners",
        ).orEmpty().contains(context.packageName)

    private fun batteryUnrestricted(): Boolean =
        (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .isIgnoringBatteryOptimizations(context.packageName)

    private fun allFilesAccess(): Boolean =
        if (Build.VERSION.SDK_INT >= 30) {
            Environment.isExternalStorageManager()
        } else {
            has(Manifest.permission.READ_EXTERNAL_STORAGE)
        }

    private fun bluetoothPermission(): Boolean =
        if (Build.VERSION.SDK_INT >= 31) {
            has(Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            true
        }

    private fun defaultSmsRole(): Boolean =
        if (Build.VERSION.SDK_INT >= 29) {
            val roles = context.getSystemService(RoleManager::class.java)
            roles?.isRoleHeld(RoleManager.ROLE_SMS) == true
        } else {
            false
        }

    private fun deviceOwner(): Boolean =
        (context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager)
            .isDeviceOwnerApp(context.packageName)

}
