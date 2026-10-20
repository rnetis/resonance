package com.rnetis.resonance.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rnetis.resonance.ResonanceApp
import com.rnetis.resonance.data.DownloadJob
import com.rnetis.resonance.data.Track
import com.rnetis.resonance.data.formatBytes
import com.rnetis.resonance.data.formatEta
import com.rnetis.resonance.data.formatSpeed
import com.rnetis.resonance.player.PlayerConnection
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.net.URLEncoder

/**
 * Live view of the server's download queue: `GET /api/jobs` is polled every 1.5s while the
 * screen is visible, progress comes from `progress.percent`, and DELETE cancels a running job
 * (or drops a finished one from the history).
 */
@Composable
fun DownloadsScreen(
    app: ResonanceApp,
    baseUrl: String,
    username: String,
    snackbarHostState: SnackbarHostState
) {
    val scope = rememberCoroutineScope()

    var jobs by remember { mutableStateOf<List<DownloadJob>>(emptyList()) }
    var active by remember { mutableStateOf(0) }
    var queued by remember { mutableStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var knownCompleted by remember { mutableStateOf<Set<String>>(emptySet()) }
    var firstPoll by remember { mutableStateOf(true) }

    LaunchedEffect(baseUrl, username) {
        while (true) {
            try {
                val page = app.api.jobs(baseUrl, username)
                jobs = page.jobs
                active = page.active
                queued = page.queued
                error = null

                val completed = page.jobs.filter { it.status == "completed" }.map { it.id }.toSet()
                if (firstPoll) {
                    knownCompleted = completed
                    firstPoll = false
                } else if (completed.size > knownCompleted.size) {
                    knownCompleted = completed
                    LibraryRefresh.bump()
                    // Do not block the polling loop on the snackbar's timeout.
                    scope.launch {
                        snackbarHostState.showSnackbar("Download finished - your library was refreshed")
                    }
                }
            } catch (e: Exception) {
                error = e.message ?: "Could not load the download queue"
            }
            delay(1500L)
        }
    }

    fun cancel(job: DownloadJob) {
        scope.launch {
            try {
                app.api.deleteJob(baseUrl, username, job.id)
                jobs = jobs.filter { it.id != job.id }
            } catch (e: Exception) {
                snackbarHostState.showSnackbar(e.message ?: "Could not cancel that job")
            }
        }
    }

    fun playFinished(job: DownloadJob) {
        val file = job.file
        if (file.isNullOrBlank()) {
            scope.launch { snackbarHostState.showSnackbar("The server did not report a file for that job") }
            return
        }
        val encoded = URLEncoder.encode(file, "UTF-8")
        val track = Track(
            path = file,
            name = file.substringAfterLast('/'),
            title = job.title ?: job.displayTitle,
            artist = job.channel,
            album = null,
            duration = job.duration,
            size = 0L,
            hasCover = false,
            user = username,
            scope = "library",
            url = "/api/stream?path=$encoded&user=" + URLEncoder.encode(username, "UTF-8"),
            cover = "/api/cover?path=$encoded&user=" + URLEncoder.encode(username, "UTF-8"),
            hls = "/api/playlist?path=$encoded&user=" + URLEncoder.encode(username, "UTF-8")
        )
        PlayerConnection.playTrack(app.api, baseUrl, track, app.offline.localPath(username, file))
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(text = "Downloads", color = TextPrimary, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Text(text = "$active running · $queued waiting", color = TextSecondary, fontSize = 12.sp)
        }

        error?.let { message ->
            Text(
                text = message,
                color = ErrorRed,
                fontSize = 13.sp,
                modifier = Modifier.padding(horizontal = 14.dp)
            )
        }

        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            items(jobs, key = { job -> job.id }) { job ->
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text(
                            text = job.displayTitle,
                            color = TextPrimary,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = buildString {
                                append(job.status)
                                job.phase?.let { append("  ·  "); append(it) }
                            },
                            color = if (job.status == "failed") ErrorRed else TextSecondary,
                            fontSize = 12.sp
                        )

                        if (job.isRunning) {
                            Spacer(Modifier.height(8.dp))
                            LinearProgressIndicator(
                                progress = job.progress.fraction,
                                modifier = Modifier.fillMaxWidth().height(4.dp)
                            )
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = buildString {
                                    append(job.progress.percent.toInt())
                                    append("%")
                                    job.progress.totalBytes?.let { total ->
                                        append("  ·  ")
                                        append(formatBytes(job.progress.downloadedBytes))
                                        append(" / ")
                                        append(formatBytes(total))
                                    }
                                    formatSpeed(job.progress.speed)?.let { append("  ·  "); append(it) }
                                    formatEta(job.progress.eta)?.let { append("  ·  eta "); append(it) }
                                },
                                color = TextSecondary,
                                fontSize = 11.sp
                            )
                        }

                        job.error?.let { message ->
                            if (job.status == "failed" || job.status == "canceled") {
                                Spacer(Modifier.height(4.dp))
                                Text(text = message, color = ErrorRed, fontSize = 11.sp)
                            }
                        }

                        Spacer(Modifier.height(6.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (job.status == "completed" && !job.file.isNullOrBlank()) {
                                Button(onClick = { playFinished(job) }) { Text("Play") }
                                Spacer(Modifier.width(8.dp))
                                Text(text = "in your library", color = TextSecondary, fontSize = 11.sp)
                                Spacer(Modifier.weight(1f))
                            }
                            TextButton(onClick = { cancel(job) }) {
                                Text(
                                    text = if (job.isRunning) "Cancel" else "Remove",
                                    color = ErrorRed
                                )
                            }
                        }
                    }
                }
            }

            if (jobs.isEmpty()) {
                item {
                    Text(
                        text = "No downloads yet. Search for a song and tap + to start one.",
                        color = TextSecondary,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }
        }
    }
}
