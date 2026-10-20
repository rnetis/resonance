package com.rnetis.resonance.player

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.rnetis.resonance.data.Api
import com.rnetis.resonance.data.Track
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

/**
 * The app-side half of playback: connects a MediaController to [PlaybackService] and mirrors
 * the player state into Compose state so any screen can observe it without Flows.
 *
 * MediaItems are built here. Whenever the server offers a `hls` URL it is used as the item
 * URI (chunked playback starts after the first ~4s segment); the progressive `url` is kept in
 * the item's mediaId so PlaybackService can fall back to it if the playlist is unavailable.
 * Offline copies win over both: they play straight from the local file.
 */
object PlayerConnection {

    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var tickerScope: CoroutineScope? = null
    private var ticker: Job? = null
    private var queueDurations: List<Long> = emptyList()

    var controller: MediaController? = null
        private set

    var connected by mutableStateOf(false)
        private set

    var hasItem by mutableStateOf(false)
        private set

    var isPlaying by mutableStateOf(false)
        private set

    var title by mutableStateOf("")
        private set

    var artist by mutableStateOf("")
        private set

    var artworkUrl by mutableStateOf<String?>(null)
        private set

    var durationMs by mutableStateOf(0L)
        private set

    var positionMs by mutableStateOf(0L)
        private set

    var shuffleEnabled by mutableStateOf(false)
        private set

    var repeatMode by mutableStateOf(Player.REPEAT_MODE_OFF)
        private set

    var queueSize by mutableStateOf(0)
        private set

    var lastError by mutableStateOf<String?>(null)
        private set

    fun connect(context: Context) {
        if (controller != null || controllerFuture != null) return
        val appContext = context.applicationContext
        val token = SessionToken(appContext, ComponentName(appContext, PlaybackService::class.java))
        val future = MediaController.Builder(appContext, token).buildAsync()
        controllerFuture = future
        future.addListener(
            {
                val value = runCatching { future.get() }.getOrNull()
                if (value == null) {
                    connected = false
                    lastError = "Could not connect to the playback service"
                    return@addListener
                }
                value.addListener(playerListener)
                controller = value
                connected = true
                refresh(value)
                startTicker()
            },
            ContextCompat.getMainExecutor(appContext)
        )
    }

    fun release() {
        ticker?.cancel()
        ticker = null
        controller?.removeListener(playerListener)
        controller?.release()
        controller = null
        connected = false
        hasItem = false
        isPlaying = false
    }

    /* ------------------------------------------------------------------ queue */

    fun playTracks(
        api: Api,
        baseUrl: String,
        tracks: List<Track>,
        startIndex: Int,
        offlinePath: (Track) -> String?
    ) {
        val player = controller ?: return
        if (tracks.isEmpty()) return
        val items = tracks.map { buildMediaItem(api, baseUrl, it, offlinePath(it)) }
        val index = startIndex.coerceIn(0, items.size - 1)
        queueDurations = tracks.map { track -> ((track.duration ?: 0.0) * 1000.0).toLong() }
        positionMs = 0L
        lastError = null
        player.setMediaItems(items, index, 0L)
        player.prepare()
        player.play()
    }

    fun playTrack(api: Api, baseUrl: String, track: Track, offlinePath: String?) {
        playTracks(api, baseUrl, listOf(track), 0) { offlinePath }
    }

    fun buildMediaItem(api: Api, baseUrl: String, track: Track, offlinePath: String?): MediaItem {
        val streamUrl = api.absolute(baseUrl, track.url).orEmpty()
        val hlsUrl = api.absolute(baseUrl, track.hls)
        val coverUrl = api.absolute(baseUrl, track.cover)

        // mediaId always holds the progressive stream URL: it identifies the track and it is
        // what the service falls back to when the chunked playlist cannot be used.
        val builder = MediaItem.Builder().setMediaId(streamUrl)

        if (!offlinePath.isNullOrBlank()) {
            builder.setUri(Uri.fromFile(File(offlinePath)))
            mimeTypeFor(track.name)?.let { builder.setMimeType(it) }
        } else if (!hlsUrl.isNullOrBlank()) {
            builder.setUri(hlsUrl)
        } else {
            builder.setUri(Uri.parse(streamUrl))
            mimeTypeFor(track.name)?.let { builder.setMimeType(it) }
        }

        val metadata = MediaMetadata.Builder()
            .setTitle(track.displayTitle)
            .setArtist(track.displayArtist)
        if (!track.album.isNullOrBlank()) metadata.setAlbumTitle(track.album)
        if (!coverUrl.isNullOrBlank()) metadata.setArtworkUri(Uri.parse(coverUrl))
        builder.setMediaMetadata(metadata.build())

        return builder.build()
    }

    /* -------------------------------------------------------------- transport */

    fun togglePlayPause() {
        val player = controller ?: return
        if (player.isPlaying) player.pause() else player.play()
    }

    fun next() {
        controller?.seekToNext()
    }

    fun previous() {
        controller?.seekToPrevious()
    }

    fun seekTo(position: Long) {
        controller?.seekTo(position.coerceAtLeast(0L))
    }

    fun setShuffle(enabled: Boolean) {
        controller?.shuffleModeEnabled = enabled
    }

    fun cycleRepeat() {
        val player = controller ?: return
        player.repeatMode = when (player.repeatMode) {
            Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
            Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
            else -> Player.REPEAT_MODE_OFF
        }
    }

    /* ------------------------------------------------------------------ state */

    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            refresh(player)
        }

        override fun onPlayerError(error: PlaybackException) {
            lastError = error.message ?: "Playback failed"
        }
    }

    private fun refresh(player: Player) {
        hasItem = player.currentMediaItem != null
        queueSize = player.mediaItemCount
        isPlaying = player.isPlaying
        shuffleEnabled = player.shuffleModeEnabled
        repeatMode = player.repeatMode

        if (hasItem) {
            val metadata = player.mediaMetadata
            title = metadata.title?.toString().orEmpty()
            artist = metadata.artist?.toString().orEmpty()
            artworkUrl = metadata.artworkUri?.toString()
        } else {
            title = ""
            artist = ""
            artworkUrl = null
            durationMs = 0L
            positionMs = 0L
        }
    }

    private fun startTicker() {
        val coroutineScope = tickerScope ?: CoroutineScope(Dispatchers.Main).also { tickerScope = it }
        ticker?.cancel()
        ticker = coroutineScope.launch {
            while (true) {
                val player = controller
                if (player != null) {
                    positionMs = player.currentPosition.coerceAtLeast(0L)
                    isPlaying = player.isPlaying
                    hasItem = player.currentMediaItem != null
                    val reported = player.duration
                    durationMs = if (reported > 0L && reported != C.TIME_UNSET) {
                        reported
                    } else {
                        queueDurations.getOrElse(player.currentMediaItemIndex) { 0L }
                    }
                }
                delay(500L)
            }
        }
    }

    private fun mimeTypeFor(name: String): String? {
        return when (name.substringAfterLast('.', "").lowercase()) {
            "mp3" -> "audio/mpeg"
            "m4a", "mp4" -> "audio/mp4"
            "aac" -> "audio/aac"
            "flac" -> "audio/flac"
            "ogg", "oga" -> "audio/ogg"
            "opus" -> "audio/opus"
            "wav" -> "audio/raw"
            "webm" -> "audio/webm"
            else -> null
        }
    }
}
