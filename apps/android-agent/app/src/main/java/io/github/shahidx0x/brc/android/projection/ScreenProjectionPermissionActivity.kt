package io.github.shahidx0x.brc.android.projection

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle

class ScreenProjectionPermissionActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE)
            as MediaProjectionManager
        startActivityForResult(
            manager.createScreenCaptureIntent(),
            REQUEST_PROJECTION,
        )
    }

    @Deprecated("Deprecated in Android framework but retained for API 26 compatibility.")
    override fun onActivityResult(
        requestCode: Int,
        resultCode: Int,
        data: Intent?,
    ) {
        super.onActivityResult(requestCode, resultCode, data)
        if (
            requestCode == REQUEST_PROJECTION &&
            resultCode == RESULT_OK &&
            data != null
        ) {
            ScreenProjectionService.startAuthorized(
                this,
                resultCode,
                data,
            )
        }
        finish()
    }

    companion object {
        private const val REQUEST_PROJECTION = 4801
    }
}
