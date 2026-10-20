package com.rnetis.resonance.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage

/** The palette mirrors the web app: near-black background, purple accent. */
val ResonancePurple = Color(0xFF7C5CFF)
val ResonancePink = Color(0xFFFF4D8D)
val BackgroundDark = Color(0xFF08080C)
val SurfaceDark = Color(0xFF0D0D13)
val SurfaceRaised = Color(0xFF16161F)
val OutlineDark = Color(0xFF262633)
val TextPrimary = Color(0xFFEDEDF5)
val TextSecondary = Color(0xFF9A9AAE)
val ErrorRed = Color(0xFFFF6B6B)

private val ResonanceColorScheme = darkColorScheme(
    primary = ResonancePurple,
    onPrimary = Color.White,
    primaryContainer = Color(0xFF2A2350),
    onPrimaryContainer = Color(0xFFE4DEFF),
    secondary = ResonancePink,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFF3A1B2A),
    onSecondaryContainer = Color(0xFFFFD9E6),
    background = BackgroundDark,
    onBackground = TextPrimary,
    surface = SurfaceDark,
    onSurface = TextPrimary,
    surfaceVariant = SurfaceRaised,
    onSurfaceVariant = TextSecondary,
    outline = OutlineDark,
    error = ErrorRed,
    onError = Color.Black
)

@Composable
fun ResonanceTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = ResonanceColorScheme, content = content)
}

/**
 * Artwork with a music note painted behind it, so a track without cover art (the server
 * answers 404) still looks deliberate rather than broken.
 */
@Composable
fun CoverArt(
    url: String?,
    size: Dp,
    modifier: Modifier = Modifier,
    corner: Dp = 10.dp
) {
    Box(
        modifier = modifier
            .size(size)
            .clip(RoundedCornerShape(corner))
            .background(SurfaceRaised),
        contentAlignment = Alignment.Center
    ) {
        Text(text = "♪", color = TextSecondary, fontSize = (size.value * 0.42f).sp)
        if (!url.isNullOrBlank()) {
            AsyncImage(
                model = url,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize()
            )
        }
    }
}
