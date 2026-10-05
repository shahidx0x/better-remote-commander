package io.github.shahidx0x.brc.android.capture

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Size
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

data class CameraImage(
    val bytes: ByteArray,
    val width: Int,
    val height: Int,
    val cameraId: String,
    val lensFacing: Int?,
    val sensorOrientation: Int?,
)

class CameraCaptureEngine(private val context: Context) {
    private val manager =
        context.getSystemService(Context.CAMERA_SERVICE) as CameraManager

    fun cameras(): List<Map<String, Any?>> =
        manager.cameraIdList.map { id ->
            val c = manager.getCameraCharacteristics(id)
            val map = c.get(
                CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP,
            )
            val jpeg = map?.getOutputSizes(ImageFormat.JPEG)
                ?.sortedByDescending { it.width.toLong() * it.height }
                .orEmpty()
            mapOf(
                "cameraId" to id,
                "lensFacing" to lensFacingName(
                    c.get(CameraCharacteristics.LENS_FACING),
                ),
                "sensorOrientation" to
                    c.get(CameraCharacteristics.SENSOR_ORIENTATION),
                "jpegSizes" to jpeg.take(12).map {
                    mapOf("width" to it.width, "height" to it.height)
                },
            )
        }

    fun capture(
        facing: String?,
        maxWidth: Int,
        maxHeight: Int,
        timeoutMs: Long = 12_000L,
    ): CameraImage {
        val cameraId = selectCamera(facing)
        val characteristics = manager.getCameraCharacteristics(cameraId)
        val lensFacing = characteristics.get(CameraCharacteristics.LENS_FACING)
        val sensorOrientation =
            characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION)
        val size = chooseSize(
            characteristics,
            maxWidth.coerceIn(320, 4096),
            maxHeight.coerceIn(240, 4096),
        )

        val thread = HandlerThread("brc-camera").apply { start() }
        val handler = Handler(thread.looper)
        val imageReader = ImageReader.newInstance(
            size.width,
            size.height,
            ImageFormat.JPEG,
            2,
        )
        var device: CameraDevice? = null
        var session: CameraCaptureSession? = null
        val deviceLatch = CountDownLatch(1)
        val sessionLatch = CountDownLatch(1)
        val imageLatch = CountDownLatch(1)
        val error = AtomicReference<Throwable?>()
        val imageBytes = AtomicReference<ByteArray?>()

        imageReader.setOnImageAvailableListener({ reader ->
            val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
            image.use {
                val buffer = it.planes[0].buffer
                val bytes = ByteArray(buffer.remaining())
                buffer.get(bytes)
                imageBytes.compareAndSet(null, bytes)
                imageLatch.countDown()
            }
        }, handler)

        try {
            manager.openCamera(
                cameraId,
                object : CameraDevice.StateCallback() {
                    override fun onOpened(camera: CameraDevice) {
                        device = camera
                        deviceLatch.countDown()
                    }

                    override fun onDisconnected(camera: CameraDevice) {
                        error.compareAndSet(
                            null,
                            IllegalStateException("Camera disconnected."),
                        )
                        camera.close()
                        deviceLatch.countDown()
                    }

                    override fun onError(camera: CameraDevice, code: Int) {
                        error.compareAndSet(
                            null,
                            IllegalStateException("Camera error code: $code"),
                        )
                        camera.close()
                        deviceLatch.countDown()
                    }
                },
                handler,
            )

            require(deviceLatch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                "Timed out opening the camera."
            }
            error.get()?.let { throw it }
            val opened = device ?: error("Camera failed to open.")

            @Suppress("DEPRECATION")
            opened.createCaptureSession(
                listOf(imageReader.surface),
                object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(created: CameraCaptureSession) {
                        session = created
                        sessionLatch.countDown()
                    }

                    override fun onConfigureFailed(created: CameraCaptureSession) {
                        error.compareAndSet(
                            null,
                            IllegalStateException(
                                "Camera capture session configuration failed.",
                            ),
                        )
                        sessionLatch.countDown()
                    }
                },
                handler,
            )

            require(sessionLatch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                "Timed out configuring the camera."
            }
            error.get()?.let { throw it }
            val captureSession = session
                ?: error("Camera capture session is unavailable.")

            val request = opened.createCaptureRequest(
                CameraDevice.TEMPLATE_STILL_CAPTURE,
            ).apply {
                addTarget(imageReader.surface)
                set(
                    CaptureRequest.CONTROL_AF_MODE,
                    CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE,
                )
            }.build()

            captureSession.capture(
                request,
                object : CameraCaptureSession.CaptureCallback() {},
                handler,
            )

            require(imageLatch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                "Timed out waiting for camera image."
            }
            val bytes = imageBytes.get()
                ?: error("Camera returned no image data.")
            return CameraImage(
                bytes = bytes,
                width = size.width,
                height = size.height,
                cameraId = cameraId,
                lensFacing = lensFacing,
                sensorOrientation = sensorOrientation,
            )
        } finally {
            runCatching { session?.close() }
            runCatching { device?.close() }
            runCatching { imageReader.close() }
            thread.quitSafely()
            runCatching { thread.join(1500) }
        }
    }

    private fun selectCamera(requestedFacing: String?): String {
        val requested = when (requestedFacing?.lowercase()) {
            null, "", "back" -> CameraCharacteristics.LENS_FACING_BACK
            "front" -> CameraCharacteristics.LENS_FACING_FRONT
            "external" -> CameraCharacteristics.LENS_FACING_EXTERNAL
            else -> error("facing must be back, front, or external.")
        }
        return manager.cameraIdList.firstOrNull { id ->
            manager.getCameraCharacteristics(id)
                .get(CameraCharacteristics.LENS_FACING) == requested
        } ?: manager.cameraIdList.firstOrNull()
        ?: error("No camera is available on this device.")
    }

    private fun chooseSize(
        characteristics: CameraCharacteristics,
        maxWidth: Int,
        maxHeight: Int,
    ): Size {
        val sizes = characteristics.get(
            CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP,
        )?.getOutputSizes(ImageFormat.JPEG).orEmpty()
        require(sizes.isNotEmpty()) { "Camera does not expose JPEG capture sizes." }
        val fitting = sizes.filter {
            it.width <= maxWidth && it.height <= maxHeight
        }
        return (fitting.ifEmpty { sizes.toList() })
            .maxByOrNull { it.width.toLong() * it.height }
            ?: sizes.first()
    }

    companion object {
        fun lensFacingName(value: Int?): String = when (value) {
            CameraCharacteristics.LENS_FACING_FRONT -> "front"
            CameraCharacteristics.LENS_FACING_BACK -> "back"
            CameraCharacteristics.LENS_FACING_EXTERNAL -> "external"
            else -> "unknown"
        }
    }
}
