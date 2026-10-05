package io.github.shahidx0x.brc.android.files

import android.content.Context
import android.util.Base64
import com.google.crypto.tink.subtle.X25519
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class FileTransferManager(context: Context) {
    private val app = context.applicationContext
    private val policy = FileAccessPolicy(app)
    private val random = SecureRandom()
    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(90, TimeUnit.SECONDS)
        .build()
    private val receiveKeys = ConcurrentHashMap<String, ReceiveKey>()

    data class PrepareResult(
        val receiveId: String,
        val recipientPublicKey: String,
        val expiresAt: Long,
    )

    data class SendResult(
        val transferToken: String,
        val size: Long,
        val sha256: String,
        val expiresAt: Long,
    )

    data class ReceiveResult(
        val path: String,
        val size: Long,
        val sha256: String,
    )

    private data class ReceiveKey(
        val privateKey: ByteArray,
        val expiresAt: Long,
    )

    private data class X25519KeyPair(
        val privateKey: ByteArray,
        val publicKey: ByteArray,
    )

    private data class WrappedKey(
        val senderPublicKey: String,
        val wrapSalt: ByteArray,
        val wrapIv: ByteArray,
        val wrapTag: ByteArray,
        val wrappedKey: ByteArray,
    )

    private data class EncryptedFile(
        val file: File,
        val sha256: String,
        val fileTag: ByteArray,
    )

    private data class Envelope(
        val url: String,
        val size: Long,
        val sha256: String,
        val expiresAt: Long,
        val fileIv: ByteArray,
        val fileTag: ByteArray,
        val senderPublicKey: ByteArray,
        val wrapSalt: ByteArray,
        val wrapIv: ByteArray,
        val wrapTag: ByteArray,
        val wrappedKey: ByteArray,
    )

    fun prepare(ttlSeconds: Int = 3600): PrepareResult {
        require(ttlSeconds in 60..7200) { "ttlSeconds must be 60..7200" }
        cleanupExpiredKeys()
        val keyPair = generateX25519()
        val receiveId = randomBytes(16).toHex()
        val expiresAt = System.currentTimeMillis() + ttlSeconds * 1000L
        receiveKeys[receiveId] = ReceiveKey(keyPair.privateKey, expiresAt)
        return PrepareResult(
            receiveId = receiveId,
            recipientPublicKey = b64(encodeX25519Spki(keyPair.publicKey)),
            expiresAt = expiresAt,
        )
    }

    fun send(
        sourcePath: String,
        recipientPublicKey: String,
        expireSeconds: Int = 3600,
    ): SendResult {
        require(expireSeconds in 60..7200) { "expireSeconds must be 60..7200" }
        val source = policy.resolve(sourcePath)
        require(source.isFile) { "sourcePath must be a file" }
        require(source.length() <= MAX_PLAINTEXT_BYTES) {
            "File is too large. Maximum plaintext size is 99 MB."
        }

        val fileKey = randomBytes(32)
        val fileIv = randomBytes(12)
        val wrapped = wrapFileKey(fileKey, recipientPublicKey)
        val encrypted = encryptFile(source, fileKey, fileIv)
        return try {
            val url = uploadEncryptedFile(encrypted.file, expireSeconds)
            val expiresAt = System.currentTimeMillis() + expireSeconds * 1000L
            val json = JSONObject()
                .put("v", 1)
                .put("provider", "tmpfiles.org")
                .put("url", url)
                .put("size", source.length())
                .put("sha256", encrypted.sha256)
                .put("expiresAt", expiresAt)
                .put("fileIv", b64(fileIv))
                .put("fileTag", b64(encrypted.fileTag))
                .put("senderPublicKey", wrapped.senderPublicKey)
                .put("wrapSalt", b64(wrapped.wrapSalt))
                .put("wrapIv", b64(wrapped.wrapIv))
                .put("wrapTag", b64(wrapped.wrapTag))
                .put("wrappedKey", b64(wrapped.wrappedKey))
            SendResult(
                transferToken = Base64.encodeToString(
                    json.toString().toByteArray(Charsets.UTF_8),
                    Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
                ),
                size = source.length(),
                sha256 = encrypted.sha256,
                expiresAt = expiresAt,
            )
        } finally {
            fileKey.fill(0)
            encrypted.file.delete()
        }
    }

    fun receive(
        receiveId: String,
        transferToken: String,
        destinationPath: String,
        overwrite: Boolean,
    ): ReceiveResult {
        cleanupExpiredKeys()
        val receiveKey = receiveKeys[receiveId]
            ?: error("Receive session is missing or expired.")
        require(receiveKey.expiresAt > System.currentTimeMillis()) {
            "Receive session is expired."
        }
        val envelope = decodeToken(transferToken)
        require(envelope.expiresAt > System.currentTimeMillis()) {
            "Transfer token has expired."
        }

        val destination = policy.resolve(destinationPath)
        if (destination.exists() && !overwrite) {
            error("Destination exists. Set overwrite=true to replace it.")
        }
        destination.parentFile?.mkdirs()

        val fileKey = unwrapFileKey(envelope, receiveKey.privateKey)
        val encrypted = downloadEncryptedFile(envelope.url)
        val part = File(
            destination.parentFile,
            destination.name + ".brc-part-" + randomBytes(6).toHex(),
        )
        return try {
            val verified = decryptAndVerify(encrypted, part, fileKey, envelope)
            if (overwrite) destination.delete()
            runCatching {
                Files.move(
                    part.toPath(),
                    destination.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                )
            }.getOrElse {
                Files.move(
                    part.toPath(),
                    destination.toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                )
            }
            receiveKeys.remove(receiveId)
            ReceiveResult(destination.path, verified.first, verified.second)
        } finally {
            fileKey.fill(0)
            encrypted.delete()
            if (part.exists()) part.delete()
        }
    }

    private fun encryptFile(
        source: File,
        fileKey: ByteArray,
        fileIv: ByteArray,
    ): EncryptedFile {
        val encrypted = File.createTempFile("brc-", ".brcx", app.cacheDir)
        val digest = MessageDigest.getInstance("SHA-256")
        val cipher = Cipher.getInstance(AES_GCM)
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(fileKey, "AES"),
            GCMParameterSpec(128, fileIv),
        )
        cipher.updateAAD(FILE_AAD)

        FileInputStream(source).use { input ->
            FileOutputStream(encrypted).use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                    cipher.update(buffer, 0, count)?.let(output::write)
                }
                val final = cipher.doFinal()
                require(final.size >= GCM_TAG_BYTES) { "Invalid AES-GCM final block." }
                val cipherTail = final.size - GCM_TAG_BYTES
                if (cipherTail > 0) output.write(final, 0, cipherTail)
                val tag = final.copyOfRange(cipherTail, final.size)
                return EncryptedFile(encrypted, digest.digest().toHex(), tag)
            }
        }
    }

    private fun wrapFileKey(
        fileKey: ByteArray,
        recipientPublicKey: String,
    ): WrappedKey {
        val recipient = decodeX25519Spki(fromB64(recipientPublicKey))
        val sender = generateX25519()
        val shared = sharedSecret(sender.privateKey, recipient)
        val salt = randomBytes(16)
        val wrappingKey = hkdfSha256(shared, salt, WRAP_INFO, 32)
        val iv = randomBytes(12)
        val cipher = Cipher.getInstance(AES_GCM)
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(wrappingKey, "AES"),
            GCMParameterSpec(128, iv),
        )
        cipher.updateAAD(WRAP_AAD)
        val final = cipher.doFinal(fileKey)
        require(final.size >= fileKey.size + GCM_TAG_BYTES) {
            "Invalid wrapped key output."
        }
        val ciphertextLength = final.size - GCM_TAG_BYTES
        return WrappedKey(
            senderPublicKey = b64(encodeX25519Spki(sender.publicKey)),
            wrapSalt = salt,
            wrapIv = iv,
            wrapTag = final.copyOfRange(ciphertextLength, final.size),
            wrappedKey = final.copyOfRange(0, ciphertextLength),
        ).also {
            shared.fill(0)
            wrappingKey.fill(0)
        }
    }

    private fun unwrapFileKey(
        envelope: Envelope,
        privateKey: ByteArray,
    ): ByteArray {
        val sender = decodeX25519Spki(envelope.senderPublicKey)
        val shared = sharedSecret(privateKey, sender)
        val wrappingKey = hkdfSha256(
            shared,
            envelope.wrapSalt,
            WRAP_INFO,
            32,
        )
        val cipher = Cipher.getInstance(AES_GCM)
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(wrappingKey, "AES"),
            GCMParameterSpec(128, envelope.wrapIv),
        )
        cipher.updateAAD(WRAP_AAD)
        return try {
            cipher.doFinal(envelope.wrappedKey + envelope.wrapTag).also {
                require(it.size == 32) { "Invalid wrapped file key." }
            }
        } finally {
            shared.fill(0)
            wrappingKey.fill(0)
        }
    }

    private fun decryptAndVerify(
        encrypted: File,
        destination: File,
        fileKey: ByteArray,
        envelope: Envelope,
    ): Pair<Long, String> {
        val cipher = Cipher.getInstance(AES_GCM)
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(fileKey, "AES"),
            GCMParameterSpec(128, envelope.fileIv),
        )
        cipher.updateAAD(FILE_AAD)
        val digest = MessageDigest.getInstance("SHA-256")
        var bytes = 0L

        FileInputStream(encrypted).use { input ->
            FileOutputStream(destination).use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    cipher.update(buffer, 0, count)?.let { plaintext ->
                        output.write(plaintext)
                        digest.update(plaintext)
                        bytes += plaintext.size
                    }
                }
                val tail = cipher.doFinal(envelope.fileTag)
                if (tail.isNotEmpty()) {
                    output.write(tail)
                    digest.update(tail)
                    bytes += tail.size
                }
            }
        }

        val sha256 = digest.digest().toHex()
        require(bytes == envelope.size) { "Transfer size verification failed." }
        require(sha256 == envelope.sha256) { "Transfer SHA-256 verification failed." }
        return bytes to sha256
    }

    private fun uploadEncryptedFile(file: File, expireSeconds: Int): String {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "file",
                randomBytes(12).toHex() + ".brcx",
                file.asRequestBody(OCTET_STREAM),
            )
            .addFormDataPart("expire", expireSeconds.toString())
            .build()
        val request = Request.Builder()
            .url(TMPFILES_UPLOAD_URL)
            .post(body)
            .build()
        http.newCall(request).execute().use { response ->
            require(response.isSuccessful) {
                "Temporary-file upload failed with HTTP ${response.code}."
            }
            val json = JSONObject(response.body.string())
            require(json.optString("status") == "success") {
                "Temporary-file provider returned an invalid response."
            }
            val url = json.getJSONObject("data").getString("url")
            validateTmpfilesUrl(url, directOnly = false)
            return url
        }
    }

    private fun downloadEncryptedFile(pageUrl: String): File {
        validateTmpfilesUrl(pageUrl, directOnly = false)
        val downloadUrl = if (URI(pageUrl).path.startsWith("/dl/")) {
            pageUrl
        } else {
            resolveDirectDownloadUrl(pageUrl)
        }
        val request = Request.Builder().url(downloadUrl).get().build()
        val file = File.createTempFile("brc-", ".download.brcx", app.cacheDir)
        try {
            http.newCall(request).execute().use { response ->
                require(response.isSuccessful) {
                    "Temporary-file download failed with HTTP ${response.code}."
                }
                val declared = response.body.contentLength()
                require(declared <= MAX_REMOTE_BYTES || declared < 0) {
                    "Encrypted transfer exceeds 100 MB."
                }
                var count = 0L
                response.body.byteStream().use { input ->
                    FileOutputStream(file).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            count += read
                            require(count <= MAX_REMOTE_BYTES) {
                                "Encrypted transfer exceeds 100 MB."
                            }
                            output.write(buffer, 0, read)
                        }
                    }
                }
            }
            return file
        } catch (error: Throwable) {
            file.delete()
            throw error
        }
    }

    private fun resolveDirectDownloadUrl(pageUrl: String): String {
        val request = Request.Builder().url(pageUrl).get().build()
        http.newCall(request).execute().use { response ->
            require(response.isSuccessful) {
                "Failed to resolve download URL (HTTP ${response.code})."
            }
            val html = response.body.string()
            val match = DOWNLOAD_LINK_REGEX.find(html)
                ?: error("Temporary-file provider did not expose a download link.")
            val resolved = URI(pageUrl).resolve(match.groupValues[1]).toString()
            validateTmpfilesUrl(resolved, directOnly = true)
            return resolved
        }
    }

    private fun decodeToken(token: String): Envelope {
        val json = runCatching {
            JSONObject(
                String(
                    Base64.decode(
                        token,
                        Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
                    ),
                    Charsets.UTF_8,
                ),
            )
        }.getOrElse { error("Invalid BRC file-transfer token.") }

        require(json.optInt("v") == 1) { "Unsupported file-transfer token." }
        require(json.optString("provider") == "tmpfiles.org") {
            "Unsupported transfer provider."
        }
        val url = json.getString("url")
        validateTmpfilesUrl(url, directOnly = false)
        val size = json.getLong("size")
        require(size in 0..MAX_PLAINTEXT_BYTES) { "Invalid transfer size." }
        return Envelope(
            url = url,
            size = size,
            sha256 = json.getString("sha256"),
            expiresAt = json.getLong("expiresAt"),
            fileIv = fromB64(json.getString("fileIv")),
            fileTag = fromB64(json.getString("fileTag")),
            senderPublicKey = fromB64(json.getString("senderPublicKey")),
            wrapSalt = fromB64(json.getString("wrapSalt")),
            wrapIv = fromB64(json.getString("wrapIv")),
            wrapTag = fromB64(json.getString("wrapTag")),
            wrappedKey = fromB64(json.getString("wrappedKey")),
        )
    }

    private fun validateTmpfilesUrl(value: String, directOnly: Boolean) {
        val uri = URI(value)
        require(uri.scheme == "https") { "Transfer URL must use HTTPS." }
        require(uri.host == "tmpfiles.org" || uri.host == "www.tmpfiles.org") {
            "Unsupported transfer host."
        }
        if (directOnly) require(uri.path.startsWith("/dl/")) {
            "Invalid direct download URL."
        }
    }

    private fun generateX25519(): X25519KeyPair {
        val privateKey = X25519.generatePrivateKey()
        val publicKey = X25519.publicFromPrivate(privateKey)
        return X25519KeyPair(privateKey, publicKey)
    }

    private fun encodeX25519Spki(rawPublicKey: ByteArray): ByteArray {
        require(rawPublicKey.size == X25519_KEY_BYTES) {
            "X25519 public key must be 32 bytes."
        }
        return X25519_SPKI_PREFIX + rawPublicKey
    }

    private fun decodeX25519Spki(der: ByteArray): ByteArray {
        require(der.size == X25519_SPKI_PREFIX.size + X25519_KEY_BYTES) {
            "Invalid X25519 public key."
        }
        require(
            der.copyOfRange(0, X25519_SPKI_PREFIX.size)
                .contentEquals(X25519_SPKI_PREFIX),
        ) {
            "Invalid X25519 SPKI key."
        }
        return der.copyOfRange(X25519_SPKI_PREFIX.size, der.size)
    }

    private fun sharedSecret(
        privateKey: ByteArray,
        publicKey: ByteArray,
    ): ByteArray =
        X25519.computeSharedSecret(privateKey, publicKey)

    private fun hkdfSha256(
        inputKeyMaterial: ByteArray,
        salt: ByteArray,
        info: ByteArray,
        length: Int,
    ): ByteArray {
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(salt, "HmacSHA256"))
        val pseudoRandomKey = extract.doFinal(inputKeyMaterial)
        val expand = Mac.getInstance("HmacSHA256")
        expand.init(SecretKeySpec(pseudoRandomKey, "HmacSHA256"))
        val output = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            expand.reset()
            expand.update(previous)
            expand.update(info)
            expand.update(counter.toByte())
            previous = expand.doFinal()
            val copy = minOf(previous.size, length - offset)
            previous.copyInto(output, offset, 0, copy)
            offset += copy
            counter++
        }
        pseudoRandomKey.fill(0)
        previous.fill(0)
        return output
    }

    private fun cleanupExpiredKeys() {
        val now = System.currentTimeMillis()
        receiveKeys.entries.removeIf { it.value.expiresAt <= now }
    }

    private fun randomBytes(size: Int): ByteArray =
        ByteArray(size).also(random::nextBytes)

    private fun b64(data: ByteArray): String =
        Base64.encodeToString(data, Base64.NO_WRAP)

    private fun fromB64(value: String): ByteArray =
        Base64.decode(value, Base64.DEFAULT)

    private fun ByteArray.toHex(): String =
        joinToString("") { "%02x".format(it) }

    companion object {
        private const val TMPFILES_UPLOAD_URL = "https://tmpfiles.org/api/v1/upload"
        private const val MAX_PLAINTEXT_BYTES = 99_000_000L
        private const val MAX_REMOTE_BYTES = 100_000_000L
        private const val AES_GCM = "AES/GCM/NoPadding"
        private const val GCM_TAG_BYTES = 16
        private const val X25519_KEY_BYTES = 32
        private val X25519_SPKI_PREFIX = byteArrayOf(
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03,
            0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
        )
        private val FILE_AAD = "BRCX1:file".toByteArray(Charsets.UTF_8)
        private val WRAP_AAD = "BRCX1:key".toByteArray(Charsets.UTF_8)
        private val WRAP_INFO = "brc-file-transfer-v1".toByteArray(Charsets.UTF_8)
        private val OCTET_STREAM = "application/octet-stream".toMediaType()
        private val DOWNLOAD_LINK_REGEX =
            Regex("""<a[^>]+class=["']download["'][^>]+href=["']([^"']+)["']""", RegexOption.IGNORE_CASE)

        fun cryptoAvailable(): Boolean =
            runCatching {
                val privateKey = X25519.generatePrivateKey()
                val publicKey = X25519.publicFromPrivate(privateKey)
                X25519.computeSharedSecret(privateKey, publicKey)
                Cipher.getInstance(AES_GCM)
            }.isSuccess
    }
}
