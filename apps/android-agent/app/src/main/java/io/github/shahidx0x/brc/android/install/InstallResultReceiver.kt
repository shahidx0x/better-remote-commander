package io.github.shahidx0x.brc.android.install

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build

class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_INSTALL_STATUS) return
        val sessionId = intent.getIntExtra(
            PackageInstaller.EXTRA_SESSION_ID,
            -1,
        )
        val status = intent.getIntExtra(
            PackageInstaller.EXTRA_STATUS,
            PackageInstaller.STATUS_FAILURE,
        )
        val message = intent.getStringExtra(
            PackageInstaller.EXTRA_STATUS_MESSAGE,
        )
        val packageName = intent.getStringExtra(
            PackageInstaller.EXTRA_PACKAGE_NAME,
        )
        val store = InstallStatusStore(context)

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            store.update(
                sessionId,
                status,
                "awaiting_user_action",
                message,
                packageName,
            )
            @Suppress("DEPRECATION")
            val confirmation = if (Build.VERSION.SDK_INT >= 33) {
                intent.getParcelableExtra(
                    Intent.EXTRA_INTENT,
                    Intent::class.java,
                )
            } else {
                intent.getParcelableExtra(Intent.EXTRA_INTENT)
            }
            if (confirmation != null) {
                postConfirmation(context, sessionId, confirmation)
            }
            return
        }

        val state = if (status == PackageInstaller.STATUS_SUCCESS) {
            "success"
        } else {
            "failed"
        }
        store.update(
            sessionId,
            status,
            state,
            message,
            packageName,
        )
        postResult(
            context,
            sessionId,
            success = status == PackageInstaller.STATUS_SUCCESS,
            message = message,
        )
    }

    private fun postConfirmation(
        context: Context,
        sessionId: Int,
        confirmation: Intent,
    ) {
        val manager =
            context.getSystemService(Context.NOTIFICATION_SERVICE)
                as NotificationManager
        ensureChannel(manager)
        confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pending = PendingIntent.getActivity(
            context,
            sessionId,
            confirmation,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        manager.notify(
            NOTIFICATION_BASE + sessionId,
            Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Approve BRC APK install")
                .setContentText("Tap to review Android's package install confirmation.")
                .setAutoCancel(true)
                .setContentIntent(pending)
                .build(),
        )
    }

    private fun postResult(
        context: Context,
        sessionId: Int,
        success: Boolean,
        message: String?,
    ) {
        val manager =
            context.getSystemService(Context.NOTIFICATION_SERVICE)
                as NotificationManager
        ensureChannel(manager)
        manager.notify(
            NOTIFICATION_BASE + sessionId,
            Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(
                    if (success) {
                        android.R.drawable.stat_sys_download_done
                    } else {
                        android.R.drawable.stat_notify_error
                    },
                )
                .setContentTitle(
                    if (success) "APK install completed" else "APK install failed",
                )
                .setContentText(message ?: if (success) "Installed" else "Failed")
                .setAutoCancel(true)
                .build(),
        )
    }

    private fun ensureChannel(manager: NotificationManager) {
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "BRC APK Installs",
                NotificationManager.IMPORTANCE_HIGH,
            ),
        )
    }

    companion object {
        const val ACTION_INSTALL_STATUS =
            "io.github.shahidx0x.brc.android.install.STATUS"
        private const val CHANNEL_ID = "brc_apk_install"
        private const val NOTIFICATION_BASE = 1400
    }
}
