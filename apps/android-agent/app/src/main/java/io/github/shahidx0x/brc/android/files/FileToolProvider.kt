package io.github.shahidx0x.brc.android.files

import android.content.Context
import android.util.Base64
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.protocol.ToolResult
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

object FileToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val policy = FileAccessPolicy(context.applicationContext)
        registry
            .register(simple("android_file_roots", "List storage roots currently available to BRC.") {
                ToolResults.json(
                    mapOf(
                        "allFilesAccess" to policy.hasAllFilesAccess(),
                        "roots" to policy.roots().map(File::getAbsolutePath),
                    ),
                )
            })
            .register(listTool(policy))
            .register(readTool(policy))
            .register(writeTool(policy))
            .register(deleteTool(policy))
            .register(copyTool(policy))
            .register(moveTool(policy))
            .register(infoTool(policy))
            .register(searchTool(policy))
    }

    private fun listTool(policy: FileAccessPolicy) = FunctionTool(
        ToolDefinition(
            "android_list_files",
            "List files and directories inside a BRC-accessible Android path.",
            schema("path" to stringSchema()),
        ),
    ) { args ->
        val dir = policy.resolve(args.requireString("path"))
        require(dir.isDirectory) { "path must be a directory" }
        val entries = dir.listFiles().orEmpty()
            .sortedWith(compareBy<File>({ !it.isDirectory }, { it.name.lowercase() }))
            .take(500)
            .map(::fileInfo)
        ToolResults.json(mapOf("path" to dir.path, "entries" to entries))
    }

    private fun readTool(policy: FileAccessPolicy) = FunctionTool(
        ToolDefinition(
            "android_read_file",
            "Read a text or base64-encoded file from Android storage.",
            schema(
                "path" to stringSchema(),
                "encoding" to mapOf("type" to "string", "enum" to listOf("utf8", "base64")),
                "maxBytes" to mapOf("type" to "integer", "minimum" to 1, "maximum" to 5_000_000),
            ),
        ),
    ) { args ->
        val file = policy.resolve(args.requireString("path"))
        require(file.isFile) { "path must be a file" }
        val maxBytes = ((args["maxBytes"] as? Number)?.toLong() ?: 1_000_000L)
            .coerceIn(1L, 5_000_000L)
        require(file.length() <= maxBytes) { "file exceeds maxBytes ($maxBytes)" }
        val bytes = file.readBytes()
        val encoding = args["encoding"] as? String ?: "utf8"
        ToolResults.json(
            mapOf(
                "path" to file.path,
                "size" to bytes.size,
                "encoding" to encoding,
                "content" to if (encoding == "base64") {
                    Base64.encodeToString(bytes, Base64.NO_WRAP)
                } else {
                    String(bytes, StandardCharsets.UTF_8)
                },
            ),
        )
    }

    private fun writeTool(policy: FileAccessPolicy) = FunctionTool(
        ToolDefinition(
            "android_write_file",
            "Write text or base64 data to an Android file.",
            schema(
                "path" to stringSchema(),
                "content" to mapOf("type" to "string"),
                "encoding" to mapOf("type" to "string", "enum" to listOf("utf8", "base64")),
                "append" to mapOf("type" to "boolean"),
            ),
        ),
    ) { args ->
        val file = policy.resolve(args.requireString("path"))
        val content = args["content"] as? String ?: error("content is required")
        val bytes = if ((args["encoding"] as? String) == "base64") {
            Base64.decode(content, Base64.DEFAULT)
        } else {
            content.toByteArray(StandardCharsets.UTF_8)
        }
        file.parentFile?.mkdirs()
        if (args["append"] == true) file.appendBytes(bytes) else file.writeBytes(bytes)
        ToolResults.json(
            mapOf(
                "path" to file.path,
                "size" to file.length(),
                "sha256" to sha256(file),
            ),
        )
    }

    private fun deleteTool(policy: FileAccessPolicy) = FunctionTool(
        ToolDefinition(
            "android_delete_file",
            "Delete an accessible file or directory.",
            schema(
                "path" to stringSchema(),
                "recursive" to mapOf("type" to "boolean"),
            ),
        ),
    ) { args ->
        val file = policy.resolve(args.requireString("path"))
        val deleted = if (file.isDirectory && args["recursive"] == true) {
            file.deleteRecursively()
        } else {
            file.delete()
        }
        require(deleted || !file.exists()) { "delete failed" }
        ToolResults.json(mapOf("deleted" to true, "path" to file.path))
    }

    private fun copyTool(policy: FileAccessPolicy) = FunctionTool(
        ToolDefinition(
            "android_copy_file",
            "Copy a file between BRC-accessible Android paths.",
            schema(
                "source" to stringSchema(),
                "destination" to stringSchema(),
                "overwrite" to mapOf("type" to "boolean"),
            ),
        ),
    ) { args ->
        val source = policy.resolve(args.requireString("source"))
        val destination = policy.resolve(args.requireString("destination"))
        require(source.isFile) { "source must be a file" }
        destination.parentFile?.mkdirs()
        val options = if (args["overwrite"] == true) {
            arrayOf(StandardCopyOption.REPLACE_EXISTING)
        } else {
            emptyArray()
        }
        Files.copy(source.toPath(), destination.toPath(), *options)
        ToolResults.json(mapOf("path" to destination.path, "size" to destination.length()))
    }

    private fun moveTool(policy: FileAccessPolicy) = FunctionTool(
        ToolDefinition(
            "android_move_file",
            "Move or rename a file between BRC-accessible Android paths.",
            schema(
                "source" to stringSchema(),
                "destination" to stringSchema(),
                "overwrite" to mapOf("type" to "boolean"),
            ),
        ),
    ) { args ->
        val source = policy.resolve(args.requireString("source"))
        val destination = policy.resolve(args.requireString("destination"))
        destination.parentFile?.mkdirs()
        val options = if (args["overwrite"] == true) {
            arrayOf(StandardCopyOption.REPLACE_EXISTING)
        } else {
            emptyArray()
        }
        Files.move(source.toPath(), destination.toPath(), *options)
        ToolResults.json(mapOf("path" to destination.path))
    }

    private fun infoTool(policy: FileAccessPolicy) = FunctionTool(
        ToolDefinition(
            "android_file_info",
            "Return metadata for an Android file or directory.",
            schema("path" to stringSchema()),
        ),
    ) { args ->
        val file = policy.resolve(args.requireString("path"))
        require(file.exists()) { "path does not exist" }
        ToolResults.json(fileInfo(file))
    }

    private fun searchTool(policy: FileAccessPolicy) = FunctionTool(
        ToolDefinition(
            "android_search_files",
            "Search names under an Android directory.",
            schema(
                "path" to stringSchema(),
                "query" to stringSchema(),
                "maxResults" to mapOf("type" to "integer", "minimum" to 1, "maximum" to 500),
            ),
        ),
    ) { args ->
        val root = policy.resolve(args.requireString("path"))
        require(root.isDirectory) { "path must be a directory" }
        val query = args.requireString("query").lowercase()
        val max = ((args["maxResults"] as? Number)?.toInt() ?: 100).coerceIn(1, 500)
        val results = mutableListOf<Map<String, Any?>>()
        root.walkTopDown()
            .onEnter { results.size < max }
            .forEach { file ->
                if (file !== root && file.name.lowercase().contains(query) && results.size < max) {
                    results += fileInfo(file)
                }
            }
        ToolResults.json(mapOf("query" to query, "results" to results))
    }

    private fun simple(
        name: String,
        description: String,
        run: () -> ToolResult,
    ) = FunctionTool(
        ToolDefinition(name, description, emptySchema()),
    ) { run() }

    private fun fileInfo(file: File): Map<String, Any?> = linkedMapOf(
        "name" to file.name,
        "path" to file.path,
        "directory" to file.isDirectory,
        "file" to file.isFile,
        "size" to if (file.isFile) file.length() else null,
        "modifiedAt" to file.lastModified(),
        "readable" to file.canRead(),
        "writable" to file.canWrite(),
    )

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun Map<String, Any?>.requireString(key: String): String =
        (this[key] as? String)?.takeIf(String::isNotBlank)
            ?: error("$key is required")

    private fun emptySchema(): Map<String, Any?> =
        mapOf("type" to "object", "properties" to emptyMap<String, Any?>())

    private fun schema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))

    private fun stringSchema(): Map<String, Any?> =
        mapOf("type" to "string", "minLength" to 1)
}
