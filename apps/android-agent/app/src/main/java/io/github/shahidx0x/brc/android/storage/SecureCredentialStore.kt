package io.github.shahidx0x.brc.android.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class DeviceCredentials(
    val relayUrl: String,
    val deviceId: String,
    val deviceToken: String,
    val name: String,
    val pairedAt: String,
)

class SecureCredentialStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun save(credentials: DeviceCredentials) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val payload = JSONObject()
            .put("relayUrl", credentials.relayUrl)
            .put("deviceId", credentials.deviceId)
            .put("deviceToken", credentials.deviceToken)
            .put("name", credentials.name)
            .put("pairedAt", credentials.pairedAt)
            .toString()
            .toByteArray(Charsets.UTF_8)

        val ciphertext = cipher.doFinal(payload)
        prefs.edit()
            .putString(KEY_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString(KEY_CIPHERTEXT, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .apply()
    }

    fun load(): DeviceCredentials? = runCatching {
        val iv = Base64.decode(prefs.getString(KEY_IV, null), Base64.NO_WRAP)
        val ciphertext = Base64.decode(prefs.getString(KEY_CIPHERTEXT, null), Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        val json = JSONObject(String(cipher.doFinal(ciphertext), Charsets.UTF_8))
        DeviceCredentials(
            relayUrl = json.getString("relayUrl"),
            deviceId = json.getString("deviceId"),
            deviceToken = json.getString("deviceToken"),
            name = json.getString("name"),
            pairedAt = json.getString("pairedAt"),
        )
    }.getOrNull()

    fun clear() {
        prefs.edit().clear().apply()
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        private const val PREFS_NAME = "brc_secure_credentials"
        private const val KEY_IV = "iv"
        private const val KEY_CIPHERTEXT = "ciphertext"
        private const val KEY_ALIAS = "brc_agent_credentials_v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
