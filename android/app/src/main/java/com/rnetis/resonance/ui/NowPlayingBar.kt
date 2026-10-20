package com.rnetis.resonance.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rnetis.resonance.player.PlayerConnection

/** A round text/emoji button - the app deliberately avoids a vector icon dependency. */
@Composable
fun TransportButton(label: String, onClick: () -> Unit, size: Dp = 40.dp) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .clickable { onClick() },
        contentAlignment = Alignment.Center
    ) {
        Text(text = label, color = TextPrimary, fontSize = (size.value * 0.5f).sp)
    }
}

/**
 * The persistent bottom bar above the navigation: cover, title, artist and the two buttons
 * people use most. Tapping it expands the full Now Playing screen.
 */
@Composable
fun NowPlayingBar(onExpand: () -> Unit) {
    if (!PlayerConnection.hasItem) return

    val duration = PlayerConnection.durationMs
    val progress = if (duration > 0L) {
        (PlayerConnection.positionMs.toFloat() / duration.toFloat()).coerceIn(0f, 1f)
    } else {
        0f
    }

    Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth()) {
            LinearProgressIndicator(
                progress = progress,
                modifier = Modifier.fillMaxWidth().height(2.dp)
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onExpand() }
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                CoverArt(url = PlayerConnection.artworkUrl, size = 42.dp, corner = 8.dp)
                Spacer(Modifier.width(10.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = PlayerConnection.title.ifBlank { "Now playing" },
                        color = TextPrimary,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = PlayerConnection.artist.ifBlank { " " },
                        color = TextSecondary,
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                TransportButton(
                    label = if (PlayerConnection.isPlaying) "⏸" else "▶",
                    onClick = { PlayerConnection.togglePlayPause() }
                )
                TransportButton(label = "⏭", onClick = { PlayerConnection.next() })
            }
        }
    }
}
