package io.github.shahidx0x.brc.android.files

import android.content.Context
import android.os.Build
import android.os.Environment
import java.io.File

class FileAccessPolicy(private val context: Context) {
    fun roots(): List<File> {
        val roots = linkedSetOf(
            context.filesDir,
            context.cacheDir,
        )
        context.getExternalFilesDir(null)?.let(roots::add)
        context.externalCacheDir?.let(roots::add)
        if (hasAllFilesAccess()) {
            roots.add(Environment.getExternalStorageDirectory())
        }
        return roots.map { it.canonicalFile }
    }

    fun resolve(path: String): File {
        require(path.isNotBlank()) { "path is required" }
        val file = File(path).canonicalFile
        require(roots().any { root -> file.isInside(root) }) {
            "Path is outside the storage locations granted to BRC."
        }
        return file
    }

    fun hasAllFilesAccess(): Boolean =
        Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()

    private fun File.isInside(root: File): Boolean {
        val rootPath = root.path.trimEnd(File.separatorChar) + File.separator
        return path == root.path || path.startsWith(rootPath)
    }
}
