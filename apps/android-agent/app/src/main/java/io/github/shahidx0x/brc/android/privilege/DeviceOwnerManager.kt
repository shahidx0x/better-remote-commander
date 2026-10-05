package io.github.shahidx0x.brc.android.privilege

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context

class DeviceOwnerManager(context: Context) {
    private val app = context.applicationContext
    private val policy = app.getSystemService(Context.DEVICE_POLICY_SERVICE)
        as DevicePolicyManager
    val admin = ComponentName(app, BrcDeviceAdminReceiver::class.java)

    val isDeviceOwner: Boolean
        get() = policy.isDeviceOwnerApp(app.packageName)

    val isProfileOwner: Boolean
        get() = policy.isProfileOwnerApp(app.packageName)

    val isAdminActive: Boolean
        get() = policy.isAdminActive(admin)

    fun status(): Map<String, Any?> = linkedMapOf(
        "deviceOwner" to isDeviceOwner,
        "profileOwner" to isProfileOwner,
        "adminActive" to isAdminActive,
        "component" to admin.flattenToString(),
        "adbProvisionCommand" to
            "adb shell dpm set-device-owner " + admin.flattenToString(),
    )

    fun lockNow() {
        requireOwner()
        policy.lockNow()
    }

    fun reboot() {
        requireOwner()
        policy.reboot(admin)
    }

    fun setGlobalSetting(key: String, value: String) {
        requireOwner()
        policy.setGlobalSetting(admin, key, value)
    }

    fun setUserRestriction(key: String, enabled: Boolean) {
        requireOwner()
        if (enabled) {
            policy.addUserRestriction(admin, key)
        } else {
            policy.clearUserRestriction(admin, key)
        }
    }

    fun setCameraDisabled(disabled: Boolean) {
        requireOwner()
        policy.setCameraDisabled(admin, disabled)
    }

    fun setStatusBarDisabled(disabled: Boolean): Boolean {
        requireOwner()
        return policy.setStatusBarDisabled(admin, disabled)
    }

    fun setKeyguardDisabled(disabled: Boolean): Boolean {
        requireOwner()
        return policy.setKeyguardDisabled(admin, disabled)
    }

    fun setLockScreenInfo(info: String?) {
        requireOwner()
        policy.setDeviceOwnerLockScreenInfo(admin, info)
    }

    fun setPermissionGrant(
        packageName: String,
        permission: String,
        grant: Boolean,
    ): Boolean {
        requireOwner()
        return policy.setPermissionGrantState(
            admin,
            packageName,
            permission,
            if (grant) {
                DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
            } else {
                DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED
            },
        )
    }

    private fun requireOwner() {
        require(isDeviceOwner) {
            "BRC is not provisioned as Android Device Owner."
        }
    }
}
