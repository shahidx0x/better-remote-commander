package io.github.shahidx0x.brc.android.projection

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Environment
import android.os.IBinder
import java.io.File
import kotlin.math.roundToInt

class ScreenProjectionService : Service() {
    private var projection: MediaProjection? = null
    private var recorder: MediaRecorder? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var outputFile: File? = null
    private var recordingStartedAtMs: Long? = null
    private var width: Int? = null
    private var height: Int? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
    }

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int,
    ): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                shutdownProjection()
                return START_NOT_STICKY
            }
        }

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Int.MIN_VALUE)
            ?: Int.MIN_VALUE
        @Suppress("DEPRECATION")
        val data = if (Build.VERSION.SDK_INT >= 33) {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA)
        }

        if (resultCode == Int.MIN_VALUE || data == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        startProjectionForeground("Screen sharing authorized")
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE)
            as MediaProjectionManager
        val grantedProjection = manager.getMediaProjection(resultCode, data)
            ?: error("Android did not return a MediaProjection session.")
        grantedProjection.registerCallback(
            object : MediaProjection.Callback() {
                override fun onStop() {
                    cleanupRecording(stopRecorder = true)
                    projection = null
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            },
            null,
        )
        projection = grantedProjection

        authorizedAtMs = System.currentTimeMillis()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        cleanupRecording(stopRecorder = true)
        runCatching { projection?.stop() }
        projection = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    @Synchronized
    fun startRecording(
        maxWidth: Int,
        maxHeight: Int,
        fps: Int,
        bitrate: Int,
    ): Map<String, Any?> {
        require(recorder == null) { "Screen recording is already active." }
        val projection = projection
            ?: error("Screen projection is not authorized.")

        val displayMetrics = resources.displayMetrics
        val bounds = if (Build.VERSION.SDK_INT >= 30) {
            getSystemService(android.view.WindowManager::class.java)
                .currentWindowMetrics.bounds
        } else {
            @Suppress("DEPRECATION")
            android.graphics.Rect(
                0,
                0,
                displayMetrics.widthPixels,
                displayMetrics.heightPixels,
            )
        }
        val target = scaleEven(
            sourceWidth = bounds.width(),
            sourceHeight = bounds.height(),
            maxWidth = maxWidth.coerceIn(320, 3840),
            maxHeight = maxHeight.coerceIn(240, 2160),
        )

        val directory =
            getExternalFilesDir(Environment.DIRECTORY_MOVIES)
                ?: File(filesDir, "recordings")
        directory.mkdirs()
        val file = File(
            directory,
            "brc-screen-" + System.currentTimeMillis() + ".mp4",
        )

        @Suppress("DEPRECATION")
        val mediaRecorder = if (Build.VERSION.SDK_INT >= 31) {
            MediaRecorder(this)
        } else {
            MediaRecorder()
        }

        try {
            mediaRecorder.setVideoSource(MediaRecorder.VideoSource.SURFACE)
            mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            mediaRecorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
            mediaRecorder.setVideoSize(target.first, target.second)
            mediaRecorder.setVideoFrameRate(fps.coerceIn(15, 60))
            mediaRecorder.setVideoEncodingBitRate(
                bitrate.coerceIn(1_000_000, 20_000_000),
            )
            mediaRecorder.setOutputFile(file.absolutePath)
            mediaRecorder.prepare()

            val display = projection.createVirtualDisplay(
                "BRC Screen Recording",
                target.first,
                target.second,
                displayMetrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                mediaRecorder.surface,
                null,
                null,
            )
            mediaRecorder.start()

            recorder = mediaRecorder
            virtualDisplay = display
            outputFile = file
            recordingStartedAtMs = System.currentTimeMillis()
            width = target.first
            height = target.second
            updateNotification("Recording screen")
            return status()
        } catch (error: Throwable) {
            runCatching { mediaRecorder.reset() }
            runCatching { mediaRecorder.release() }
            file.delete()
            throw error
        }
    }

    @Synchronized
    fun stopRecording(): Map<String, Any?> {
        val file = outputFile ?: error("No screen recording is active.")
        val started = recordingStartedAtMs
        cleanupRecording(stopRecorder = true)
        val duration = started?.let {
            (System.currentTimeMillis() - it).coerceAtLeast(0)
        }
        val result = linkedMapOf<String, Any?>(
            "recording" to false,
            "path" to file.absolutePath,
            "bytes" to if (file.exists()) file.length() else 0L,
            "durationMs" to duration,
            "mimeType" to "video/mp4",
            "width" to width,
            "height" to height,
        )
        // Android 14+ projection consent is single-session. Stop it after recording.
        runCatching { projection?.stop() }
        projection = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        return result
    }

    @Synchronized
    fun status(): Map<String, Any?> =
        linkedMapOf(
            "authorized" to (projection != null),
            "authorizedAtMs" to authorizedAtMs,
            "recording" to (recorder != null),
            "path" to outputFile?.absolutePath,
            "recordingStartedAtMs" to recordingStartedAtMs,
            "width" to width,
            "height" to height,
        )

    private fun cleanupRecording(stopRecorder: Boolean) {
        val activeRecorder = recorder
        recorder = null
        if (activeRecorder != null) {
            if (stopRecorder) {
                runCatching { activeRecorder.stop() }
            }
            runCatching { activeRecorder.reset() }
            runCatching { activeRecorder.release() }
        }
        runCatching { virtualDisplay?.release() }
        virtualDisplay = null
        recordingStartedAtMs = null
        updateNotification("Screen sharing authorized")
    }

    private fun shutdownProjection() {
        cleanupRecording(stopRecorder = true)
        runCatching { projection?.stop() }
        projection = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startProjectionForeground(text: String) {
        val notification = notification(text)
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(text: String) {
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIFICATION_ID, notification(text))
    }

    private fun createChannel() {
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
            .createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "BRC Screen Capture",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Visible while BRC has owner-authorized screen projection."
                    setShowBadge(false)
                },
            )
    }

    private fun notification(text: String): Notification {
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, ScreenProjectionService::class.java)
                .setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_slideshow)
            .setContentTitle("BRC Screen Capture")
            .setContentText(text)
            .setOngoing(true)
            .addAction(
                Notification.Action.Builder(null, "Stop", stop).build(),
            )
            .build()
    }

    private fun scaleEven(
        sourceWidth: Int,
        sourceHeight: Int,
        maxWidth: Int,
        maxHeight: Int,
    ): Pair<Int, Int> {
        val scale = minOf(
            1.0,
            maxWidth.toDouble() / sourceWidth,
            maxHeight.toDouble() / sourceHeight,
        )
        fun even(value: Double): Int =
            ((value.roundToInt().coerceAtLeast(2)) / 2) * 2
        return even(sourceWidth * scale) to even(sourceHeight * scale)
    }

    companion object {
        private const val CHANNEL_ID = "brc_screen_projection"
        private const val NOTIFICATION_ID = 1201
        private const val ACTION_STOP =
            "io.github.shahidx0x.brc.android.projection.STOP"
        private const val EXTRA_RESULT_CODE = "result_code"
        private const val EXTRA_RESULT_DATA = "result_data"

        @Volatile
        private var instance: ScreenProjectionService? = null

        @Volatile
        private var authorizedAtMs: Long? = null

        fun startAuthorized(
            context: Context,
            resultCode: Int,
            data: Intent,
        ) {
            val intent = Intent(context, ScreenProjectionService::class.java)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, data)
            context.startForegroundService(intent)
        }

        fun currentStatus(): Map<String, Any?> =
            instance?.status() ?: mapOf(
                "authorized" to false,
                "authorizedAtMs" to null,
                "recording" to false,
            )

        fun startRecording(
            maxWidth: Int,
            maxHeight: Int,
            fps: Int,
            bitrate: Int,
        ): Map<String, Any?> =
            instance?.startRecording(maxWidth, maxHeight, fps, bitrate)
                ?: error(
                    "Screen projection is not authorized. " +
                        "Request owner authorization first.",
                )

        fun stopRecording(): Map<String, Any?> =
            instance?.stopRecording()
                ?: error("Screen projection service is not running.")
    }
}
