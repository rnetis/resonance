package com.rnetis.resonance.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.Player
import com.rnetis.resonance.data.formatMillis
import com.rnetis.resonance.player.PlayerConnection

/** Full-screen player: artwork, scrubbing, transport, shuffle and repeat. */
@Composable
fun NowPlayingScreen(onCollapse: () -> Unit) {
    var dragging by remember { mutableStateOf(false) }
    var dragValue by remember { mutableStateOf(0f) }

    val duration = PlayerConnection.durationMs
    val rangeMax = if (duration > 0L) duration.toFloat() else 1f
    val sliderValue = if (dragging) {
        dragValue
    } else {
        PlayerConnection.positionMs.coerceIn(0L, duration.coerceAtLeast(1L)).toFloat()
    }

    Surface(
        color = MaterialTheme.colorScheme.background,
        modifier = Modifier.fillMaxSize()
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 14.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                TransportButton(label = "⌄", onClick = onCollapse)
                Spacer(Modifier.weight(1f))
                Text(text = "Now playing", color = TextSecondary, fontSize = 13.sp)
                Spacer(Modifier.weight(1f))
                Spacer(Modifier.width(40.dp))
            }

            Spacer(Modifier.height(18.dp))
            Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                CoverArt(url = PlayerConnection.artworkUrl, size = 240.dp, corner = 22.dp)
            }

            Spacer(Modifier.height(20.dp))
            Text(
                text = PlayerConnection.title.ifBlank { "Nothing playing" },
                color = TextPrimary,
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = PlayerConnection.artist.ifBlank { " " },
                color = TextSecondary,
                fontSize = 14.sp,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )

            Spacer(Modifier.height(16.dp))
            Slider(
                value = sliderValue,
                onValueChange = {
                    dragging = true
                    dragValue = it
                },
                onValueChangeFinished = {
                    PlayerConnection.seekTo(dragValue.toLong())
                    dragging = false
                },
                valueRange = 0f..rangeMax,
                modifier = Modifier.fillMaxWidth()
            )
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(
                    text = formatMillis(if (dragging) dragValue.toLong() else PlayerConnection.positionMs),
                    color = TextSecondary,
                    fontSize = 12.sp
                )
                Text(text = formatMillis(duration), color = TextSecondary, fontSize = 12.sp)
            }

            Spacer(Modifier.height(14.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically
            ) {
                TransportButton(label = "⏮", onClick = { PlayerConnection.previous() }, size = 46.dp)
                Spacer(Modifier.width(18.dp))
                TransportButton(
                    label = if (PlayerConnection.isPlaying) "⏸" else "▶",
                    onClick = { PlayerConnection.togglePlayPause() },
                    size = 68.dp
                )
                Spacer(Modifier.width(18.dp))
                TransportButton(label = "⏭", onClick = { PlayerConnection.next() }, size = 46.dp)
            }

            Spacer(Modifier.height(18.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                ModeToggle(
                    label = "🔀 Shuffle",
                    active = PlayerConnection.shuffleEnabled,
                    onClick = { PlayerConnection.setShuffle(!PlayerConnection.shuffleEnabled) }
                )
                ModeToggle(
                    label = repeatLabel(PlayerConnection.repeatMode),
                    active = PlayerConnection.repeatMode != Player.REPEAT_MODE_OFF,
                    onClick = { PlayerConnection.cycleRepeat() }
                )
            }

            Spacer(Modifier.height(16.dp))
            Text(
                text = "${PlayerConnection.queueSize} item(s) in the queue",
                color = TextSecondary,
                fontSize = 12.sp
            )
            PlayerConnection.lastError?.let { message ->
                Spacer(Modifier.height(6.dp))
                Text(text = message, color = ErrorRed, fontSize = 12.sp, textAlign = TextAlign.Center)
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

private fun repeatLabel(mode: Int): String {
    return when (mode) {
        Player.REPEAT_MODE_ONE -> "🔂 Repeat one"
        Player.REPEAT_MODE_ALL -> "🔁 Repeat all"
        else -> "🔁 Repeat off"
    }
}

@Composable
private fun ModeToggle(label: String, active: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(14.dp))
            .background(if (active) MaterialTheme.colorScheme.primaryContainer else SurfaceRaised)
            .clickable { onClick() }
            .padding(horizontal = 16.dp, vertical = 10.dp)
    ) {
        Text(
            text = label,
            color = if (active) MaterialTheme.colorScheme.onPrimaryContainer else TextSecondary,
            fontSize = 13.sp
        )
    }
}
