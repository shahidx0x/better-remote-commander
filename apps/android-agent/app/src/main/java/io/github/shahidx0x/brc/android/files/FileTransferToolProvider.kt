package io.github.shahidx0x.brc.android.files

import android.content.Context
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object FileTransferToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val manager = FileTransferManager(context.applicationContext)
        registry
            .register(FunctionTool(
                ToolDefinition(
                    name = "prepare_file_transfer",
                    description = "Prepare this Android device to securely receive an encrypted BRC file transfer.",
                    inputSchema = schema(
                        "ttlSeconds" to mapOf(
                            "type" to "integer",
                            "minimum" to 60,
                            "maximum" to 7200,
                        ),
                    ),
                ),
            ) { args ->
                val ttl = (args["ttlSeconds"] as? Number)?.toInt() ?: 3600
                val result = manager.prepare(ttl)
                ToolResults.json(
                    mapOf(
                        "receiveId" to result.receiveId,
                        "recipientPublicKey" to result.recipientPublicKey,
                        "expiresAt" to result.expiresAt,
                    ),
                )
            })
            .register(FunctionTool(
                ToolDefinition(
                    name = "send_file_transfer",
                    description = "Encrypt an Android file locally and upload only ciphertext for cross-device BRC transfer.",
                    inputSchema = schema(
                        "sourcePath" to stringSchema(),
                        "recipientPublicKey" to stringSchema(),
                        "expireSeconds" to mapOf(
                            "type" to "integer",
                            "minimum" to 60,
                            "maximum" to 7200,
                        ),
                    ),
                ),
            ) { args ->
                val result = manager.send(
                    sourcePath = args.requireString("sourcePath"),
                    recipientPublicKey = args.requireString("recipientPublicKey"),
                    expireSeconds = (args["expireSeconds"] as? Number)?.toInt() ?: 3600,
                )
                ToolResults.json(
                    mapOf(
                        "transferToken" to result.transferToken,
                        "size" to result.size,
                        "sha256" to result.sha256,
                        "expiresAt" to result.expiresAt,
                    ),
                )
            })
            .register(FunctionTool(
                ToolDefinition(
                    name = "receive_file_transfer",
                    description = "Download and decrypt a BRC encrypted transfer into Android storage.",
                    inputSchema = schema(
                        "receiveId" to stringSchema(),
                        "transferToken" to stringSchema(),
                        "destinationPath" to stringSchema(),
                        "overwrite" to mapOf("type" to "boolean"),
                    ),
                ),
            ) { args ->
                val result = manager.receive(
                    receiveId = args.requireString("receiveId"),
                    transferToken = args.requireString("transferToken"),
                    destinationPath = args.requireString("destinationPath"),
                    overwrite = args["overwrite"] == true,
                )
                ToolResults.json(
                    mapOf(
                        "path" to result.path,
                        "size" to result.size,
                        "sha256" to result.sha256,
                    ),
                )
            })
    }

    private fun Map<String, Any?>.requireString(key: String): String =
        (this[key] as? String)?.takeIf(String::isNotBlank)
            ?: error("$key is required")

    private fun schema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))

    private fun stringSchema(): Map<String, Any?> =
        mapOf("type" to "string", "minLength" to 1)
}
