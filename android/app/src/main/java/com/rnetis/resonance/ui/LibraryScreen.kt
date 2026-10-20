package com.rnetis.resonance.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import com.rnetis.resonance.data.LibraryFolder
import com.rnetis.resonance.data.LibraryPage
import com.rnetis.resonance.data.Track
import com.rnetis.resonance.data.UserInfo
import com.rnetis.resonance.data.formatDuration
import com.rnetis.resonance.player.PlayerConnection
import kotlinx.coroutines.launch

/**
 * Browse the server library: folders, tracks, cover art. Tapping a track plays the whole
 * visible list from that row; long-pressing (or the ⋮ button) opens share / save-offline /
 * delete. The scope chip switches to the read-only shared area, where destructive actions
 * are hidden.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun LibraryScreen(
    app: ResonanceApp,
    baseUrl: String,
    username: String,
    snackbarHostState: SnackbarHostState
) {
    val scope = rememberCoroutineScope()

    var path by remember { mutableStateOf("") }
    var shared by remember { mutableStateOf(false) }
    var page by remember { mutableStateOf<LibraryPage?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var offlinePaths by remember { mutableStateOf<Set<String>>(emptySet()) }
    var savingPath by remember { mutableStateOf<String?>(null) }
    var saveProgress by remember { mutableStateOf(0f) }
    var menuPath by remember { mutableStateOf<String?>(null) }
    var shareTarget by remember { mutableStateOf<Track?>(null) }
    var deleteTarget by remember { mutableStateOf<Track?>(null) }
    val refreshVersion = LibraryRefresh.version

    LaunchedEffect(baseUrl, username, path, shared, refreshVersion) {
        loading = true
        error = null
        try {
            val loaded = app.api.tracks(
                baseUrl = baseUrl,
                user = username,
                path = path,
                scope = if (shared) "shared" else "library",
                recursive = true
            )
            page = loaded
            offlinePaths = loaded.tracks
                .filter { app.offline.isSaved(username, it.path) }
                .map { it.path }
                .toSet()
        } catch (e: Exception) {
            error = e.message ?: "Could not load the library"
        }
        loading = false
    }

    fun saveOffline(track: Track) {
        val url = app.api.absolute(baseUrl, track.url)
        if (url.isNullOrBlank()) {
            scope.launch { snackbarHostState.showSnackbar("That track has no stream URL") }
            return
        }
        savingPath = track.path
        saveProgress = 0f
        scope.launch {
            try {
                app.offline.save(username, track, url) { written, total ->
                    saveProgress = if (total > 0L) {
                        (written.toFloat() / total.toFloat()).coerceIn(0f, 1f)
                    } else {
                        0f
                    }
                }
                offlinePaths += track.path
                snackbarHostState.showSnackbar("Saved \"" + track.displayTitle + "\" for offline playback")
            } catch (e: Exception) {
                snackbarHostState.showSnackbar(e.message ?: "Could not save that track offline")
            }
            savingPath = null
            saveProgress = 0f
        }
    }

    val folders = page?.folders.orEmpty()
    val tracks = page?.tracks.orEmpty()
    val writable = page?.writable ?: !shared

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = if (shared) "Shared area" else "My library",
                color = TextPrimary,
                fontSize = 20.sp,
                fontWeight = FontWeight.Bold
            )
            Spacer(Modifier.weight(1f))
            FilterChip(
                selected = !shared,
                onClick = {
                    shared = false
                    path = ""
                },
                label = { Text("Mine") }
            )
            Spacer(Modifier.width(6.dp))
            FilterChip(
                selected = shared,
                onClick = {
                    shared = true
                    path = ""
                },
                label = { Text("Shared") }
            )
        }

        if (path.isNotBlank()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                TextButton(onClick = { path = page?.parent.orEmpty() }) { Text("⬆ Up") }
                Text(
                    text = path,
                    color = TextSecondary,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }

        when {
            page == null && loading -> Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentAlignment = Alignment.Center
            ) {
                CircularProgressIndicator()
            }

            page == null && error != null -> Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentAlignment = Alignment.Center
            ) {
                Text(text = error.orEmpty(), color = ErrorRed, fontSize = 13.sp)
            }

            else -> LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                items(folders.size, key = { index -> "folder-" + folders[index].path }) { index ->
                    FolderRow(folder = folders[index], onClick = { path = folders[index].path })
                }

                itemsIndexed(tracks, key = { _, item -> "track-" + item.path }) { index, track ->
                    TrackRow(
                        track = track,
                        coverUrl = app.api.absolute(baseUrl, track.cover),
                        offline = offlinePaths.contains(track.path),
                        saving = savingPath == track.path,
                        savingProgress = saveProgress,
                        writable = writable,
                        menuOpen = menuPath == track.path,
                        onPlay = {
                            PlayerConnection.playTracks(app.api, baseUrl, tracks, index) { item ->
                                app.offline.localPath(username, item.path)
                            }
                        },
                        onMenuToggle = { menuPath = if (menuPath == track.path) null else track.path },
                        onShare = {
                            menuPath = null
                            shareTarget = track
                        },
                        onSaveOffline = {
                            menuPath = null
                            saveOffline(track)
                        },
                        onDelete = {
                            menuPath = null
                            deleteTarget = track
                        }
                    )
                }

                if (folders.isEmpty() && tracks.isEmpty() && !loading) {
                    item {
                        Text(
                            text = if (shared) "Nothing has been shared yet." else "This folder is empty.",
                            color = TextSecondary,
                            fontSize = 13.sp,
                            modifier = Modifier.padding(16.dp)
                        )
                    }
                }
            }
        }
    }

    shareTarget?.let { track ->
        ShareDialog(
            app = app,
            baseUrl = baseUrl,
            username = username,
            track = track,
            onDismiss = { shareTarget = null },
            onDone = { message ->
                shareTarget = null
                scope.launch { snackbarHostState.showSnackbar(message) }
            }
        )
    }

    deleteTarget?.let { track ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("Delete from the library?") },
            text = {
                Text(
                    "\"" + track.displayTitle + "\" is removed from the server. " +
                        "A copy saved on this device is kept."
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    deleteTarget = null
                    scope.launch {
                        try {
                            app.api.deleteTrack(baseUrl, username, track.path)
                            snackbarHostState.showSnackbar("Deleted \"" + track.displayTitle + "\"")
                            LibraryRefresh.bump()
                        } catch (e: Exception) {
                            snackbarHostState.showSnackbar(e.message ?: "Could not delete that track")
                        }
                    }
                }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text("Cancel") }
            }
        )
    }
}

@Composable
private fun FolderRow(folder: LibraryFolder, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick() }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text = "📁", fontSize = 16.sp)
        Spacer(Modifier.width(10.dp))
        Text(text = folder.name, color = TextPrimary, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TrackRow(
    track: Track,
    coverUrl: String?,
    offline: Boolean,
    saving: Boolean,
    savingProgress: Float,
    writable: Boolean,
    menuOpen: Boolean,
    onPlay: () -> Unit,
    onMenuToggle: () -> Unit,
    onShare: () -> Unit,
    onSaveOffline: () -> Unit,
    onDelete: () -> Unit
) {
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onPlay, onLongClick = onMenuToggle)
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(10.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                CoverArt(url = coverUrl, size = 46.dp)
                Spacer(Modifier.width(10.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = track.displayTitle,
                        color = TextPrimary,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = buildString {
                            append(track.displayArtist)
                            append("  ·  ")
                            append(formatDuration(track.duration))
                            if (offline) append("  ·  ⬇ offline")
                            if (!writable) append("  ·  read-only")
                        },
                        color = TextSecondary,
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                if (saving) {
                    CircularProgressIndicator(modifier = Modifier.size(22.dp))
                } else {
                    Box {
                        TransportButton(label = "⋮", onClick = onMenuToggle, size = 34.dp)
                        DropdownMenu(expanded = menuOpen, onDismissRequest = onMenuToggle) {
                            DropdownMenuItem(text = { Text("Play now") }, onClick = { onMenuToggle(); onPlay() })
                            if (writable) {
                                DropdownMenuItem(text = { Text("Share with…") }, onClick = onShare)
                                DropdownMenuItem(
                                    text = { Text(if (offline) "Save offline again" else "Save offline") },
                                    onClick = onSaveOffline
                                )
                                DropdownMenuItem(text = { Text("Delete") }, onClick = onDelete)
                            }
                        }
                    }
                }
            }
            if (saving) {
                LinearProgressIndicator(
                    progress = savingProgress,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(2.dp)
                )
            }
        }
    }
}

@Composable
private fun ShareDialog(
    app: ResonanceApp,
    baseUrl: String,
    username: String,
    track: Track,
    onDismiss: () -> Unit,
    onDone: (String) -> Unit
) {
    val scope = rememberCoroutineScope()
    var users by remember { mutableStateOf<List<UserInfo>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(track.path, baseUrl, username) {
        loading = true
        users = try {
            app.api.users(baseUrl, username).users.filter { it.name != username }
        } catch (e: Exception) {
            emptyList()
        }
        loading = false
    }

    fun send(to: String) {
        busy = true
        scope.launch {
            try {
                val share = app.api.share(baseUrl, username, track.path, to, note)
                val who = if (to == "*") "everyone" else to
                onDone("Shared \"" + share.displayTitle + "\" with " + who)
            } catch (e: Exception) {
                onDone(e.message ?: "Could not share that track")
            }
            busy = false
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Share") },
        text = {
            Column(
                modifier = Modifier
                    .heightIn(max = 340.dp)
                    .verticalScroll(rememberScrollState())
            ) {
                Text(
                    text = track.displayTitle,
                    color = TextPrimary,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text("Note (optional)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(10.dp))
                if (loading) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp))
                    Spacer(Modifier.height(8.dp))
                }
                TextButton(onClick = { send("*") }, enabled = !busy) {
                    Text("Everyone")
                }
                users.forEach { user ->
                    TextButton(onClick = { send(user.name) }, enabled = !busy) {
                        Text(user.name + "  ·  " + user.tracks + " tracks")
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        }
    )
}
