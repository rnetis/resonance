package com.rnetis.resonance.data

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/* ------------------------------------------------------------------ JSON helpers */

/**
 * The server omits fields it does not know (null covers, null durations, ...), so every
 * accessor below tolerates a missing key, an explicit null or a stringified number.
 */
fun JSONObject.stringOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    val value = optString(key, "").trim()
    return value.ifEmpty { null }
}

fun JSONObject.doubleOrNull(key: String): Double? {
    if (!has(key) || isNull(key)) return null
    val value = optDouble(key, Double.NaN)
    return if (value.isNaN() || value.isInfinite()) null else value
}

fun JSONObject.longOr(key: String, fallback: Long = 0L): Long {
    if (!has(key) || isNull(key)) return fallback
    return optLong(key, fallback)
}

fun JSONObject.intOr(key: String, fallback: Int = 0): Int {
    if (!has(key) || isNull(key)) return fallback
    return optInt(key, fallback)
}

fun JSONObject.boolOr(key: String, fallback: Boolean = false): Boolean {
    if (!has(key) || isNull(key)) return fallback
    return optBoolean(key, fallback)
}

fun JSONObject.objects(key: String): List<JSONObject> {
    val array: JSONArray = optJSONArray(key) ?: return emptyList()
    val out = ArrayList<JSONObject>(array.length())
    for (i in 0 until array.length()) {
        val item = array.optJSONObject(i)
        if (item != null) out.add(item)
    }
    return out
}

fun jsonObjectArray(text: String): List<JSONObject> {
    val array = JSONArray(text)
    val out = ArrayList<JSONObject>(array.length())
    for (i in 0 until array.length()) {
        val item = array.optJSONObject(i)
        if (item != null) out.add(item)
    }
    return out
}

/* --------------------------------------------------------------------- formatting */

/** `m:ss`, or `h:mm:ss` for long tracks; `--:--` when the server does not know. */
fun formatDuration(seconds: Double?): String {
    if (seconds == null || seconds <= 0.0) return "--:--"
    val total = seconds.toLong()
    val hours = total / 3600
    val minutes = (total % 3600) / 60
    val secs = total % 60
    return if (hours > 0) {
        String.format(Locale.US, "%d:%02d:%02d", hours, minutes, secs)
    } else {
        String.format(Locale.US, "%d:%02d", minutes, secs)
    }
}

/** `m:ss` for millisecond positions, used by the player UI. */
fun formatMillis(millis: Long): String {
    if (millis <= 0L) return "0:00"
    return formatDuration(millis / 1000.0)
}

fun formatBytes(bytes: Long): String {
    if (bytes <= 0L) return "0 B"
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    var value = bytes.toDouble()
    var index = 0
    while (value >= 1024.0 && index < units.size - 1) {
        value /= 1024.0
        index += 1
    }
    return if (index == 0) "$bytes B" else String.format(Locale.US, "%.1f %s", value, units[index])
}

fun formatSpeed(bytesPerSecond: Double?): String? {
    if (bytesPerSecond == null || bytesPerSecond <= 0.0) return null
    return formatBytes(bytesPerSecond.toLong()) + "/s"
}

fun formatEta(seconds: Double?): String? {
    if (seconds == null || seconds <= 0.0) return null
    val total = seconds.toLong()
    return if (total < 60) "${total}s" else "${total / 60}m ${total % 60}s"
}

/* ------------------------------------------------------------------------ models */

/** `GET /api/health` */
data class Health(
    val ok: Boolean,
    val musicDir: String?,
    val defaultUser: String?,
    val user: String?,
    val users: Int,
    val shares: Int,
    val format: String?,
    val ytDlp: Boolean,
    val ffprobe: Boolean,
    val ffmpeg: Boolean,
    val chunked: Boolean,
    val segmentSeconds: Int,
    val activeDownloads: Int,
    val queued: Int
) {
    /** Label/value pairs for the settings diagnostics list. */
    fun diagnostics(): List<Pair<String, String>> = listOf(
        "Reachable" to if (ok) "yes" else "no",
        "Library folder" to (musicDir ?: "unknown"),
        "Default user" to (defaultUser ?: "unknown"),
        "User seen by server" to (user ?: "unknown"),
        "Users / shares" to "$users / $shares",
        "yt-dlp" to yesNo(ytDlp),
        "ffprobe" to yesNo(ffprobe),
        "ffmpeg" to yesNo(ffmpeg),
        "Chunked playback" to (if (chunked) "yes (${segmentSeconds}s segments)" else "no - mixes stay on http"),
        "Active downloads" to activeDownloads.toString(),
        "Queued downloads" to queued.toString(),
        "Preferred format" to (format ?: "unknown")
    )

    private fun yesNo(value: Boolean) = if (value) "available" else "missing"

    companion object {
        fun from(o: JSONObject) = Health(
            ok = o.boolOr("ok", true),
            musicDir = o.stringOrNull("musicDir"),
            defaultUser = o.stringOrNull("defaultUser"),
            user = o.stringOrNull("user"),
            users = o.intOr("users"),
            shares = o.intOr("shares"),
            format = o.stringOrNull("format"),
            ytDlp = o.boolOr("ytDlp"),
            ffprobe = o.boolOr("ffprobe"),
            ffmpeg = o.boolOr("ffmpeg"),
            chunked = o.boolOr("chunked"),
            segmentSeconds = o.intOr("segmentSeconds", 4),
            activeDownloads = o.intOr("activeDownloads"),
            queued = o.intOr("queued")
        )
    }
}

/** One entry of `GET /api/users`. */
data class UserInfo(
    val name: String,
    val tracks: Int,
    val bytes: Long,
    val createdAt: String?,
    val isDefault: Boolean
) {
    companion object {
        fun from(o: JSONObject) = UserInfo(
            name = o.stringOrNull("name") ?: "unknown",
            tracks = o.intOr("tracks"),
            bytes = o.longOr("bytes"),
            createdAt = o.stringOrNull("createdAt"),
            isDefault = o.boolOr("isDefault")
        )
    }
}

/** `GET /api/users` */
data class UsersPage(val defaultUser: String?, val users: List<UserInfo>) {
    companion object {
        fun from(o: JSONObject) = UsersPage(
            defaultUser = o.stringOrNull("defaultUser"),
            users = o.objects("users").map { UserInfo.from(it) }
        )
    }
}

/** One entry of `GET /api/search`. */
data class SearchResult(
    val id: String,
    val name: String,
    val url: String,
    val thumbnail: String?,
    val channel: String?,
    val length: String?,
    val views: String?
) {
    companion object {
        fun from(o: JSONObject) = SearchResult(
            id = o.stringOrNull("id") ?: "",
            name = o.stringOrNull("name") ?: "(untitled)",
            url = o.stringOrNull("url") ?: "",
            thumbnail = o.stringOrNull("thumbnail"),
            channel = o.stringOrNull("channel"),
            length = o.stringOrNull("length"),
            views = o.stringOrNull("views")
        )
    }
}

/** `progress` object of a download job. `percent` is 0..100. */
data class JobProgress(
    val percent: Double,
    val downloadedBytes: Long,
    val totalBytes: Long?,
    val speed: Double?,
    val eta: Double?
) {
    /** 0f..1f for a progress bar. */
    val fraction: Float get() = (percent / 100.0).coerceIn(0.0, 1.0).toFloat()

    companion object {
        fun from(o: JSONObject) = JobProgress(
            percent = o.doubleOrNull("percent") ?: 0.0,
            downloadedBytes = o.longOr("downloadedBytes"),
            totalBytes = if (o.has("totalBytes") && !o.isNull("totalBytes")) o.longOr("totalBytes") else null,
            speed = o.doubleOrNull("speed"),
            eta = o.doubleOrNull("eta")
        )
    }
}

/** One entry of `GET /api/jobs`. */
data class DownloadJob(
    val id: String,
    val user: String?,
    val url: String,
    val videoId: String?,
    val status: String,
    val phase: String?,
    val progress: JobProgress,
    val title: String?,
    val channel: String?,
    val file: String?,
    val error: String?,
    val thumbnail: String?,
    val duration: Double?,
    val autoPlay: Boolean
) {
    val isFinished: Boolean get() = status == "completed" || status == "failed" || status == "canceled"
    val isRunning: Boolean get() = status == "queued" || status == "downloading" || status == "processing"
    val displayTitle: String get() = title?.takeIf { it.isNotBlank() } ?: phase ?: url

    companion object {
        fun from(o: JSONObject) = DownloadJob(
            id = o.stringOrNull("id") ?: "",
            user = o.stringOrNull("user"),
            url = o.stringOrNull("url") ?: "",
            videoId = o.stringOrNull("videoId"),
            status = o.stringOrNull("status") ?: "unknown",
            phase = o.stringOrNull("phase"),
            progress = o.optJSONObject("progress")?.let { JobProgress.from(it) } ?: JobProgress(0.0, 0L, null, null, null),
            title = o.stringOrNull("title"),
            channel = o.stringOrNull("channel"),
            file = o.stringOrNull("file"),
            error = o.stringOrNull("error"),
            thumbnail = o.stringOrNull("thumbnail"),
            duration = o.doubleOrNull("duration"),
            autoPlay = o.boolOr("autoPlay")
        )
    }
}

/** `GET /api/jobs` */
data class JobsPage(val jobs: List<DownloadJob>, val active: Int, val queued: Int) {
    companion object {
        fun from(o: JSONObject) = JobsPage(
            jobs = o.objects("jobs").map { DownloadJob.from(it) },
            active = o.intOr("active"),
            queued = o.intOr("queued")
        )
    }
}

/** One entry of `library.tracks`. */
data class Track(
    val path: String,
    val name: String,
    val title: String,
    val artist: String?,
    val album: String?,
    val duration: Double?,
    val size: Long,
    val hasCover: Boolean,
    val user: String?,
    val scope: String,
    val url: String,
    val cover: String?,
    val hls: String?
) {
    val displayTitle: String get() = title.takeIf { it.isNotBlank() } ?: name
    val displayArtist: String get() = artist?.takeIf { it.isNotBlank() } ?: "Unknown artist"

    companion object {
        fun from(o: JSONObject): Track {
            val name = o.stringOrNull("name") ?: o.stringOrNull("path") ?: "Track"
            return Track(
                path = o.stringOrNull("path") ?: name,
                name = name,
                title = o.stringOrNull("title") ?: name,
                artist = o.stringOrNull("artist"),
                album = o.stringOrNull("album"),
                duration = o.doubleOrNull("duration"),
                size = o.longOr("size"),
                hasCover = o.boolOr("hasCover"),
                user = o.stringOrNull("user"),
                scope = o.stringOrNull("scope") ?: "library",
                url = o.stringOrNull("url") ?: "",
                cover = o.stringOrNull("cover"),
                hls = o.stringOrNull("hls")
            )
        }
    }
}

/** One entry of `library.folders`. */
data class LibraryFolder(val name: String, val path: String) {
    companion object {
        fun from(o: JSONObject) = LibraryFolder(
            name = o.stringOrNull("name") ?: "",
            path = o.stringOrNull("path") ?: ""
        )
    }
}

/** `GET /api/tracks` */
data class LibraryPage(
    val user: String?,
    val scope: String,
    val writable: Boolean,
    val path: String,
    val parent: String?,
    val folders: List<LibraryFolder>,
    val tracks: List<Track>,
    val total: Int
) {
    companion object {
        fun from(o: JSONObject) = LibraryPage(
            user = o.stringOrNull("user"),
            scope = o.stringOrNull("scope") ?: "library",
            writable = o.boolOr("writable", true),
            path = o.stringOrNull("path") ?: "",
            parent = if (o.has("parent") && !o.isNull("parent")) o.stringOrNull("parent") else null,
            folders = o.objects("folders").map { LibraryFolder.from(it) },
            tracks = o.objects("tracks").map { Track.from(it) },
            total = o.intOr("total")
        )
    }
}

/** One entry of `GET /api/shares` (incoming or outgoing). */
data class Share(
    val id: String,
    val from: String,
    val to: String,
    val trackPath: String,
    val title: String,
    val artist: String?,
    val album: String?,
    val duration: Double?,
    val hasCover: Boolean,
    val note: String?,
    val createdAt: String?,
    val available: Boolean,
    val stream: String?,
    val cover: String?,
    val hls: String?
) {
    val displayTitle: String get() = title.takeIf { it.isNotBlank() } ?: trackPath
    val displayArtist: String get() = artist?.takeIf { it.isNotBlank() } ?: "Unknown artist"
    val sharedWithEveryone: Boolean get() = to == "*"

    /** Lets a share be queued like any other track. */
    fun asTrack(): Track = Track(
        path = trackPath,
        name = trackPath.substringAfterLast('/'),
        title = displayTitle,
        artist = artist,
        album = album,
        duration = duration,
        size = 0L,
        hasCover = hasCover,
        user = null,
        scope = "shared",
        url = stream.orEmpty(),
        cover = cover,
        hls = hls
    )

    companion object {
        fun from(o: JSONObject) = Share(
            id = o.stringOrNull("id") ?: "",
            from = o.stringOrNull("from") ?: "",
            to = o.stringOrNull("to") ?: "",
            trackPath = o.stringOrNull("trackPath") ?: "",
            title = o.stringOrNull("title") ?: "",
            artist = o.stringOrNull("artist"),
            album = o.stringOrNull("album"),
            duration = o.doubleOrNull("duration"),
            hasCover = o.boolOr("hasCover"),
            note = o.stringOrNull("note"),
            createdAt = o.stringOrNull("createdAt"),
            available = o.boolOr("available", true),
            stream = o.stringOrNull("stream"),
            cover = o.stringOrNull("cover"),
            hls = o.stringOrNull("hls")
        )
    }
}

/** `GET /api/shares` */
data class SharesPage(val user: String?, val incoming: List<Share>, val outgoing: List<Share>) {
    companion object {
        fun from(o: JSONObject) = SharesPage(
            user = o.stringOrNull("user"),
            incoming = o.objects("incoming").map { Share.from(it) },
            outgoing = o.objects("outgoing").map { Share.from(it) }
        )
    }
}
