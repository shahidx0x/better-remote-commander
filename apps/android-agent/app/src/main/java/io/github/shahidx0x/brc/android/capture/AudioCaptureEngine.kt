package io.github.shahidx0x.brc.android.capture

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.os.Environment
import java.io.File

data class AudioRecording(
    val path: String,
    val bytes: Long,
    val durationMs: Long,
    val mimeType: String,
)

class AudioCaptureEngine(private val context: Context) {
    fun record(
        durationMs: Long,
        audioSource: Int = MediaRecorder.AudioSource.MIC,
    ): AudioRecording {
        val safeDuration = durationMs.coerceIn(500L, 60_000L)
        val directory =
            context.getExternalFilesDir(Environment.DIRECTORY_MUSIC)
                ?: File(context.filesDir, "recordings")
        directory.mkdirs()
        val file = File(
            directory,
            "brc-audio-" + System.currentTimeMillis() + ".m4a",
        )

        @Suppress("DEPRECATION")
        val recorder = if (Build.VERSION.SDK_INT >= 31) {
            MediaRecorder(context)
        } else {
            MediaRecorder()
        }

        try {
            recorder.setAudioSource(audioSource)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setAudioEncodingBitRate(128_000)
            recorder.setAudioSamplingRate(44_100)
            recorder.setOutputFile(file.absolutePath)
            recorder.prepare()
            recorder.start()

            var remaining = safeDuration
            while (remaining > 0) {
                val chunk = minOf(remaining, 500L)
                Thread.sleep(chunk)
                remaining -= chunk
            }

            recorder.stop()
            require(file.exists() && file.length() > 0) {
                "Audio recorder produced no data."
            }
            return AudioRecording(
                path = file.absolutePath,
                bytes = file.length(),
                durationMs = safeDuration,
                mimeType = "audio/mp4",
            )
        } catch (error: Throwable) {
            file.delete()
            throw error
        } finally {
            runCatching { recorder.reset() }
            runCatching { recorder.release() }
        }
    }
}
