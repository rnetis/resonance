package com.rnetis.resonance.player

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.drm.DrmSessionManagerProvider
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.rnetis.resonance.MainActivity

/**
 * The playback engine: an ExoPlayer plus a MediaSession, hosted by a foreground service so
 * audio survives the app being backgrounded. The UI never touches the player directly; it
 * talks to this session through a `MediaController` (see PlayerConnection).
 *
 * Note on media3's `UnstableApi`: it is marked with androidx.annotation.RequiresOptIn, which
 * is enforced by Android Lint rather than the Kotlin compiler. The lint check is switched off
 * in app/build.gradle.kts, so the code below compiles without extra opt-in annotations.
 *
 * The HTTP data source deliberately does NOT send `X-Resonance-User`: the server gives the
 * header priority over `?user=`, and every media URL already carries the right user/scope, so
 * sending the header would break playback of a queue built under a different username.
 */
class PlaybackService : MediaSessionService() {

    private var player: ExoPlayer? = null
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()

        val dataSourceFactory = buildDataSourceFactory()
        val exoPlayer = ExoPlayer.Builder(this)
            .setMediaSourceFactory(ChunkAwareMediaSourceFactory(dataSourceFactory))
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ true
            )
            .setHandleAudioBecomingNoisy(true)
            .build()

        exoPlayer.addListener(hlsFallbackListener)

        player = exoPlayer
        session = MediaSession.Builder(this, exoPlayer)
            .setSessionActivity(sessionActivity())
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val exoPlayer = player
        if (exoPlayer == null || !exoPlayer.playWhenReady || exoPlayer.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        player?.release()
        session?.release()
        player = null
        session = null
        super.onDestroy()
    }

    /**
     * The default datasource falls back to FileDataSource for `file://`, which is what the
     * offline copies use; everything http goes through DefaultHttpDataSource.
     */
    private fun buildDataSourceFactory(): DataSource.Factory {
        val http = DefaultHttpDataSource.Factory()
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(30_000)
            .setAllowCrossProtocolRedirects(true)
            .setUserAgent("Resonance-Android/1.0.0")
        return DefaultDataSource.Factory(this, http)
    }

    private fun sessionActivity(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    /**
     * Chunked playback is preferred, but the server returns 503/504 when ffmpeg is missing or
     * the first segment is not written yet. When an HLS item fails, the same track is put back
     * with its progressive `url` (kept in the item's mediaId) and playback resumes in place.
     */
    private val hlsFallbackListener = object : Player.Listener {
        override fun onPlayerError(error: PlaybackException) {
            val exoPlayer = player ?: return
            val index = exoPlayer.currentMediaItemIndex
            val item = exoPlayer.currentMediaItem ?: return
            val uri = item.localConfiguration?.uri?.toString().orEmpty()
            if (!uri.contains("/api/playlist")) return

            val progressive = item.mediaId
            if (!progressive.startsWith("http://") && !progressive.startsWith("https://")) return

            val position = exoPlayer.currentPosition.coerceAtLeast(0L)
            val fixed = item.buildUpon().setUri(Uri.parse(progressive)).build()
            exoPlayer.replaceMediaItem(index, fixed)
            exoPlayer.prepare()
            exoPlayer.seekTo(index, position)
        }
    }
}

/**
 * Picks the right MediaSource per item: the playlist route is matched by path (not by
 * extension, so a server that serves it without the `.m3u8` suffix still works) - anything
 * whose URI contains `/api/playlist` is
 * built as an explicit HlsMediaSource, everything else (progressive audio, offline files)
 * goes through the ordinary factory.
 */
private class ChunkAwareMediaSourceFactory(dataSourceFactory: DataSource.Factory) : MediaSource.Factory {

    private val hls = HlsMediaSource.Factory(dataSourceFactory)
    private val progressive = DefaultMediaSourceFactory(dataSourceFactory)

    override fun setDrmSessionManagerProvider(drmSessionManagerProvider: DrmSessionManagerProvider): MediaSource.Factory {
        hls.setDrmSessionManagerProvider(drmSessionManagerProvider)
        progressive.setDrmSessionManagerProvider(drmSessionManagerProvider)
        return this
    }

    override fun setLoadErrorHandlingPolicy(loadErrorHandlingPolicy: LoadErrorHandlingPolicy): MediaSource.Factory {
        hls.setLoadErrorHandlingPolicy(loadErrorHandlingPolicy)
        progressive.setLoadErrorHandlingPolicy(loadErrorHandlingPolicy)
        return this
    }

    override fun getSupportedTypes(): IntArray = intArrayOf(C.CONTENT_TYPE_OTHER, C.CONTENT_TYPE_HLS)

    override fun createMediaSource(mediaItem: MediaItem): MediaSource {
        val uri = mediaItem.localConfiguration?.uri?.toString().orEmpty()
        return if (uri.contains("/api/playlist")) {
            hls.createMediaSource(mediaItem)
        } else {
            progressive.createMediaSource(mediaItem)
        }
    }
}
