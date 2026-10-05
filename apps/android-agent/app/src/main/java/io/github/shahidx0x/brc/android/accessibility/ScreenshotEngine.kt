package io.github.shahidx0x.brc.android.accessibility

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.os.Build
import android.view.Display
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

data class ScreenshotFrame(
    val png: ByteArray,
    val width: Int,
    val height: Int,
)

class ScreenshotEngine {
    fun capture(timeoutMs: Long = 8000): ScreenshotFrame {
        require(Build.VERSION.SDK_INT >= 30) {
            "Accessibility screenshots require Android API 30 or newer."
        }
        val service = BrcAccessibilityService.instance
            ?: error("BRC Accessibility Service is not connected.")
        val latch = CountDownLatch(1)
        val frame = AtomicReference<ScreenshotFrame?>()
        val failure = AtomicReference<String?>()
        val executor = Executors.newSingleThreadExecutor()
        try {
            service.takeScreenshot(
                Display.DEFAULT_DISPLAY,
                executor,
                object : AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(
                        screenshot: AccessibilityService.ScreenshotResult,
                    ) {
                        runCatching {
                            val wrapped = Bitmap.wrapHardwareBuffer(
                                screenshot.hardwareBuffer,
                                screenshot.colorSpace,
                            ) ?: error("Android returned an invalid screenshot buffer.")
                            val bitmap = wrapped.copy(Bitmap.Config.ARGB_8888, false)
                                ?: error("Failed to copy screenshot into a software bitmap.")
                            screenshot.hardwareBuffer.close()
                            val bytes = ByteArrayOutputStream().use { output ->
                                require(
                                    bitmap.compress(
                                        Bitmap.CompressFormat.PNG,
                                        100,
                                        output,
                                    ),
                                ) {
                                    "Failed to encode screenshot as PNG."
                                }
                                output.toByteArray()
                            }
                            frame.set(
                                ScreenshotFrame(
                                    png = bytes,
                                    width = bitmap.width,
                                    height = bitmap.height,
                                ),
                            )
                            bitmap.recycle()
                        }.onFailure { error ->
                            failure.set(error.message ?: "Screenshot conversion failed.")
                        }
                        latch.countDown()
                    }

                    override fun onFailure(errorCode: Int) {
                        failure.set(
                            when (errorCode) {
                                AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR ->
                                    "Android screenshot internal error."
                                AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT ->
                                    "Screenshot requested too soon after the previous capture."
                                AccessibilityService.ERROR_TAKE_SCREENSHOT_INVALID_DISPLAY ->
                                    "Screenshot target display is invalid."
                                AccessibilityService.ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS ->
                                    "Accessibility screenshot access is unavailable."
                                AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW ->
                                    "The current window prevents screenshots."
                                else -> "Android screenshot failed with code $errorCode."
                            },
                        )
                        latch.countDown()
                    }
                },
            )
            require(latch.await(timeoutMs.coerceIn(1000, 20_000), TimeUnit.MILLISECONDS)) {
                "Timed out waiting for Android screenshot."
            }
            failure.get()?.let { error(it) }
            return frame.get() ?: error("Android returned no screenshot.")
        } finally {
            executor.shutdownNow()
        }
    }
}
