package io.github.shahidx0x.brc.android.transport

import android.os.Build
import io.github.shahidx0x.brc.android.storage.DeviceCredentials
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit

data class PairingChallenge(
    val verificationUri: String,
    val verificationUriComplete: String,
    val userCode: String,
    val expiresInSeconds: Int,
)

class PairingClient(
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build(),
) {
    fun pair(
        relayUrl: String,
        name: String,
        deviceId: String,
        onChallenge: (PairingChallenge) -> Unit,
    ): DeviceCredentials {
        val base = normalizeRelayUrl(relayUrl)
        val start = post(
            "$base/device/start",
            JSONObject().put("client_name", name),
        )
        if (start.status != 200 || start.json.optString("device_code").isBlank()) {
            error("Relay rejected pairing start (HTTP ${start.status}).")
        }

        val deviceCode = start.json.getString("device_code")
        val expiresIn = start.json.optInt("expires_in", 600)
        val challenge = PairingChallenge(
            verificationUri = start.json.getString("verification_uri"),
            verificationUriComplete = start.json.optString("verification_uri_complete"),
            userCode = start.json.getString("user_code"),
            expiresInSeconds = expiresIn,
        )
        onChallenge(challenge)

        var intervalMs = maxOf(2, start.json.optInt("interval", 5)) * 1000L
        val deadline = System.currentTimeMillis() + expiresIn * 1000L
        while (System.currentTimeMillis() < deadline) {
            Thread.sleep(intervalMs)
            val poll = post(
                "$base/device/poll",
                JSONObject()
                    .put("device_code", deviceCode)
                    .put("device_id", deviceId)
                    .put("name", name)
                    .put(
                        "platform",
                        "android/${Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"}",
                    ),
            )

            val token = poll.json.optString("device_token")
            val pairedDeviceId = poll.json.optString("device_id")
            if (token.isNotBlank() && pairedDeviceId.isNotBlank()) {
                return DeviceCredentials(
                    relayUrl = base,
                    deviceId = pairedDeviceId,
                    deviceToken = token,
                    name = name,
                    pairedAt = Instant.now().toString(),
                )
            }

            when (poll.json.optString("error")) {
                "authorization_pending" -> Unit
                "slow_down" -> intervalMs += 5_000
                "access_denied" -> error("Pairing denied by the relay owner.")
                "expired_token" -> error("Pairing code expired.")
                else -> error(
                    "Pairing failed: ${poll.json.optString("error", "unknown error")}",
                )
            }
        }

        error("Pairing code expired.")
    }

    private fun post(url: String, json: JSONObject): JsonResponse {
        val body = json.toString().toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder().url(url).post(body).build()
        http.newCall(request).execute().use { response ->
            val payload = response.body.string()
            return JsonResponse(
                response.code,
                runCatching { JSONObject(payload) }.getOrDefault(JSONObject()),
            )
        }
    }

    data class JsonResponse(val status: Int, val json: JSONObject)

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        fun normalizeRelayUrl(value: String): String {
            val trimmed = value.trim().trimEnd('/')
            require(trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
                "Relay URL must start with https:// or http://."
            }
            return trimmed
        }
    }
}
