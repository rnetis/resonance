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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
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
import com.rnetis.resonance.data.Share
import com.rnetis.resonance.data.SharesPage
import com.rnetis.resonance.data.formatDuration
import com.rnetis.resonance.player.PlayerConnection
import kotlinx.coroutines.launch

/**
 * Two tabs over `GET /api/shares`: what other people sent you, and what you sent them.
 * A share whose file has been removed on the sender's side comes back with available=false
 * and is shown as "file is gone" with Play disabled.
 */
@Composable
fun SharedScreen(
    app: ResonanceApp,
    baseUrl: String,
    username: String,
    snackbarHostState: SnackbarHostState
) {
    val scope = rememberCoroutineScope()

    var page by remember { mutableStateOf<SharesPage?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var tab by remember { mutableStateOf(0) }
    var version by remember { mutableStateOf(0) }
    var busyId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(baseUrl, username, version) {
        loading = true
        error = null
        try {
            page = app.api.shares(baseUrl, username)
        } catch (e: Exception) {
            error = e.message ?: "Could not load shares"
        }
        loading = false
    }

    fun notify(message: String) {
        scope.launch { snackbarHostState.showSnackbar(message) }
    }

    fun play(share: Share) {
        PlayerConnection.playTrack(app.api, baseUrl, share.asTrack(), null)
    }

    fun import(share: Share) {
        busyId = share.id
        scope.launch {
            try {
                app.api.importShare(baseUrl, username, share.id)
                LibraryRefresh.bump()
                notify("Copied \"" + share.displayTitle + "\" into your library")
                version += 1
            } catch (e: Exception) {
                notify(e.message ?: "Could not import that share")
            }
            busyId = null
        }
    }

    fun remove(share: Share, message: String) {
        busyId = share.id
        scope.launch {
            try {
                app.api.deleteShare(baseUrl, username, share.id)
                notify(message)
                version += 1
            } catch (e: Exception) {
                notify(e.message ?: "Could not update that share")
            }
            busyId = null
        }
    }

    val incoming = page?.incoming.orEmpty()
    val outgoing = page?.outgoing.orEmpty()

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(text = "Shared", color = TextPrimary, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            if (loading) CircularProgressIndicator(modifier = Modifier.width(20.dp).height(20.dp))
        }

        TabRow(
            selectedTabIndex = tab,
            containerColor = MaterialTheme.colorScheme.surface,
            contentColor = MaterialTheme.colorScheme.primary
        ) {
            Tab(
                selected = tab == 0,
                onClick = { tab = 0 },
                text = { Text("Shared with me") }
            )
            Tab(
                selected = tab == 1,
                onClick = { tab = 1 },
                text = { Text("I shared") }
            )
        }

        error?.let { message ->
            Text(
                text = message,
                color = ErrorRed,
                fontSize = 13.sp,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp)
            )
        }

        val list = if (tab == 0) incoming else outgoing

        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            items(list, key = { share -> share.id }) { share ->
                ShareRow(
                    share = share,
                    coverUrl = app.api.absolute(baseUrl, share.cover),
                    outgoing = tab == 1,
                    busy = busyId == share.id,
                    onPlay = { play(share) },
                    onImport = { import(share) },
                    onDismiss = { remove(share, "Share dismissed") },
                    onRevoke = { remove(share, "Share revoked") }
                )
            }

            if (list.isEmpty() && !loading) {
                item {
                    Text(
                        text = if (tab == 0) {
                            "Nothing has been shared with you yet."
                        } else {
                            "You have not shared anything yet. Use a track's ⋮ menu to send one."
                        },
                        color = TextSecondary,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun ShareRow(
    share: Share,
    coverUrl: String?,
    outgoing: Boolean,
    busy: Boolean,
    onPlay: () -> Unit,
    onImport: () -> Unit,
    onDismiss: () -> Unit,
    onRevoke: () -> Unit
) {
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CoverArt(url = coverUrl, size = 46.dp)
                Spacer(Modifier.width(10.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = share.displayTitle,
                        color = TextPrimary,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = buildString {
                            append(share.displayArtist)
                            append("  ·  ")
                            append(formatDuration(share.duration))
                            append("  ·  ")
                            append(if (outgoing) "to " else "from ")
                            append(if (share.sharedWithEveryone) "everyone" else if (outgoing) share.to else share.from)
                        },
                        color = TextSecondary,
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                if (busy) {
                    CircularProgressIndicator(modifier = Modifier.width(20.dp).height(20.dp))
                }
            }

            if (!share.note.isNullOrBlank()) {
                Spacer(Modifier.height(6.dp))
                Text(text = "\"" + share.note + "\"", color = TextSecondary, fontSize = 12.sp)
            }

            if (!share.available) {
                Spacer(Modifier.height(6.dp))
                Text(text = "file is gone", color = ErrorRed, fontSize = 12.sp)
            }

            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (!outgoing) {
                    TextButton(onClick = onPlay, enabled = share.available && !busy) {
                        Text("Play", color = if (share.available) MaterialTheme.colorScheme.primary else TextSecondary)
                    }
                    TextButton(onClick = onImport, enabled = share.available && !busy) {
                        Text("Save to my library", color = MaterialTheme.colorScheme.primary)
                    }
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = onDismiss, enabled = !busy) {
                        Text("Dismiss", color = ErrorRed)
                    }
                } else {
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = onRevoke, enabled = !busy) {
                        Text("Revoke", color = ErrorRed)
                    }
                }
            }
        }
    }
}
