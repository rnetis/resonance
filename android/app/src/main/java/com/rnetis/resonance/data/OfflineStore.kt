package com.rnetis.resonance.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/**
 * "Save offline" copies the audio bytes of a track into `filesDir/offline/<sha1>` and
 * records the mapping in SharedPreferences, so the player can later use the local
 * `file://` URI instead of the network.
 */
class OfflineStore(context: Context, private val prefs: Prefs) {

    private val appContext = context.applicationContext
    private val client = OkHttpClient()

    fun directory(): File {
        val dir = File(appContext.filesDir, "offline")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    /** Absolute path of the on-device copy, or null when it is not saved (or was deleted). */
    fun localPath(user: String, trackPath: String): String? {
        val stored = prefs.offlinePath(Prefs.offlineKey(user, trackPath)) ?: return null
        return if (File(stored).exists()) stored else null
    }

    fun isSaved(user: String, trackPath: String): Boolean = localPath(user, trackPath) != null

    fun savedCount(): Int = prefs.offlineIndex().count { File(it.value).exists() }

    /** Total size of the offline copies on this device. */
    fun totalBytes(): Long {
        var total = 0L
        directory().listFiles()?.forEach { file -> if (file.isFile) total += file.length() }
        return total
    }

    /**
     * Streams [url] into the offline folder. [onProgress] gets (writtenBytes, totalBytes),
     * where totalBytes is -1 when the server does not send a Content-Length.
     */
    suspend fun save(
        user: String,
        track: Track,
        url: String,
        onProgress: (Long, Long) -> Unit = { _, _ -> }
    ): String = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(url)
            .header("X-Resonance-User", user)
            .get()
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw ApiException("Could not download the file (HTTP ${response.code})", response.code)
            }
            val body = response.body ?: throw ApiException("The server sent an empty file")
            val extension = track.name.substringAfterLast('.', "mp3").take(5)
            val target = File(directory(), sha1(Prefs.offlineKey(user, track.path)) + "." + extension)
            val total = body.contentLength()
            var written = 0L

            body.byteStream().use { input ->
                FileOutputStream(target).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        written += read
                        onProgress(written, total)
                    }
                    output.flush()
                }
            }

            if (written <= 0L) {
                target.delete()
                throw ApiException("Nothing was downloaded")
            }

            prefs.putOffline(Prefs.offlineKey(user, track.path), target.absolutePath)
            target.absolutePath
        }
    }

    fun delete(user: String, trackPath: String): Boolean {
        val key = Prefs.offlineKey(user, trackPath)
        val stored = prefs.offlinePath(key)
        prefs.removeOffline(key)
        if (stored.isNullOrBlank()) return false
        return File(stored).delete()
    }

    /** Removes every offline copy; returns how many files were deleted. */
    fun deleteAll(): Int {
        var removed = 0
        directory().listFiles()?.forEach { file -> if (file.isFile && file.delete()) removed += 1 }
        prefs.clearOfflineIndex()
        return removed
    }

    private fun sha1(value: String): String {
        val digest = MessageDigest.getInstance("SHA-1").digest(value.toByteArray(Charsets.UTF_8))
        val builder = StringBuilder(digest.size * 2)
        for (byte in digest) {
            val unsigned = byte.toInt() and 0xFF
            builder.append(HEX[unsigned ushr 4]).append(HEX[unsigned and 0x0F])
        }
        return builder.toString()
    }

    private companion object {
        val HEX = "0123456789abcdef".toCharArray()
    }
}
