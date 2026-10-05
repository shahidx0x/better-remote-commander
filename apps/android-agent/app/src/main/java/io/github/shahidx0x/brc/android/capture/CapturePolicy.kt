package io.github.shahidx0x.brc.android.capture

import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import io.github.shahidx0x.brc.android.privilege.DeviceOwnerManager

object CapturePolicy {
    fun requirePermissionAndVisibility(
        context: Context,
        permission: String,
        capability: String,
    ) {
        require(
            context.checkSelfPermission(permission) ==
                PackageManager.PERMISSION_GRANTED,
        ) {
            "Android permission not granted: $permission"
        }

        if (DeviceOwnerManager(context).isDeviceOwner) return
        require(hasVisibleActivity()) {
            "$capability requires the BRC app to be visible on Android 14+ " +
                "unless BRC is provisioned as Device Owner."
        }
    }

    fun hasVisibleActivity(): Boolean {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND ||
            info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
    }
}
