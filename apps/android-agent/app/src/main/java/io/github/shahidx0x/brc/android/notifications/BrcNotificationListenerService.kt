package io.github.shahidx0x.brc.android.notifications

import android.app.Notification
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

class BrcNotificationListenerService : NotificationListenerService() {
    override fun onListenerConnected() {
        instance = this
    }

    override fun onListenerDisconnected() {
        if (instance === this) instance = null
        requestRebind(
            android.content.ComponentName(
                this,
                BrcNotificationListenerService::class.java,
            ),
        )
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    fun snapshots(
        packageFilter: String? = null,
        limit: Int = 100,
    ): List<Map<String, Any?>> =
        activeNotifications
            .orEmpty()
            .asSequence()
            .filter { packageFilter.isNullOrBlank() || it.packageName == packageFilter }
            .sortedByDescending(StatusBarNotification::getPostTime)
            .take(limit.coerceIn(1, 500))
            .map(::snapshot)
            .toList()

    fun open(key: String) {
        val sbn = requireNotification(key)
        val pending = sbn.notification.contentIntent
            ?: error("Notification has no content action.")
        pending.send()
    }

    fun invokeAction(key: String, actionIndex: Int) {
        val action = action(key, actionIndex)
        action.actionIntent.send()
    }

    fun reply(key: String, actionIndex: Int?, text: String) {
        val sbn = requireNotification(key)
        val actions = sbn.notification.actions.orEmpty()
        val index = actionIndex ?: actions.indexOfFirst { !it.remoteInputs.isNullOrEmpty() }
        require(index in actions.indices) { "No reply-capable notification action found." }
        val action = actions[index]
        val inputs = action.remoteInputs.orEmpty()
        require(inputs.isNotEmpty()) { "Selected action does not accept remote input." }

        val results = Bundle()
        inputs.forEach { input -> results.putCharSequence(input.resultKey, text) }
        val fillIn = Intent()
        RemoteInput.addResultsToIntent(inputs, fillIn, results)
        action.actionIntent.send(this, 0, fillIn)
    }

    fun dismiss(key: String) {
        requireNotification(key)
        cancelNotification(key)
    }

    private fun requireNotification(key: String): StatusBarNotification =
        activeNotifications.orEmpty().firstOrNull { it.key == key }
            ?: error("Notification not found or no longer active.")

    private fun action(key: String, index: Int): Notification.Action {
        val actions = requireNotification(key).notification.actions.orEmpty()
        require(index in actions.indices) { "Invalid notification action index." }
        return actions[index]
    }

    private fun snapshot(sbn: StatusBarNotification): Map<String, Any?> {
        val notification = sbn.notification
        val extras = notification.extras
        return linkedMapOf(
            "key" to sbn.key,
            "package" to sbn.packageName,
            "id" to sbn.id,
            "tag" to sbn.tag,
            "postTime" to sbn.postTime,
            "ongoing" to sbn.isOngoing,
            "clearable" to sbn.isClearable,
            "groupKey" to sbn.groupKey,
            "category" to notification.category,
            "title" to extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
            "text" to extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
            "subText" to extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString(),
            "bigText" to extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString(),
            "hasContentIntent" to (notification.contentIntent != null),
            "actions" to notification.actions.orEmpty().mapIndexed { index, action ->
                mapOf(
                    "index" to index,
                    "title" to action.title?.toString(),
                    "hasRemoteInput" to !action.remoteInputs.isNullOrEmpty(),
                )
            },
        )
    }

    companion object {
        @Volatile
        var instance: BrcNotificationListenerService? = null
            private set

        val connected: Boolean
            get() = instance != null
    }
}
