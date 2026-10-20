package com.rnetis.resonance.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.rnetis.resonance.ResonanceApp
import com.rnetis.resonance.player.PlayerConnection

/**
 * Screens that change the library (a finished download, an import, a deleted track) bump this
 * so the library reloads the next time it is composed.
 */
object LibraryRefresh {
    var version by mutableStateOf(0)

    fun bump() {
        version += 1
    }
}

private enum class Destination(val label: String, val icon: String) {
    Library("Library", "🎵"),
    Search("Search", "🔍"),
    Downloads("Downloads", "⬇"),
    Shared("Shared", "🤝"),
    Settings("Settings", "⚙")
}

@Composable
fun AppRoot() {
    val context = LocalContext.current
    val app = context.applicationContext as ResonanceApp

    var baseUrl by remember { mutableStateOf(app.prefs.serverUrl) }
    var username by remember { mutableStateOf(app.prefs.username) }
    var destination by remember { mutableStateOf(Destination.Library) }
    var nowPlayingOpen by remember { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }

    // The media notification only shows on Android 13+ if this permission is granted.
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* playback works either way; the notification just stays hidden */ }

    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    // Bind to the MediaSessionService once; the connection survives every recomposition.
    LaunchedEffect(Unit) { PlayerConnection.connect(context) }

    ResonanceTheme {
        Box(modifier = Modifier.fillMaxSize()) {
            val configured = baseUrl.isNotBlank() && username.isNotBlank()

            if (!configured) {
                SetupScreen(
                    app = app,
                    onReady = { server, user ->
                        baseUrl = server
                        username = user
                        destination = Destination.Library
                    }
                )
            } else {
                Scaffold(
                    containerColor = MaterialTheme.colorScheme.background,
                    snackbarHost = { SnackbarHost(hostState = snackbarHostState) },
                    bottomBar = {
                        Column {
                            NowPlayingBar(onExpand = { nowPlayingOpen = true })
                            NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceVariant) {
                                Destination.entries.forEach { entry ->
                                    NavigationBarItem(
                                        selected = destination == entry,
                                        onClick = { destination = entry },
                                        icon = { Text(text = entry.icon, fontSize = 17.sp) },
                                        label = { Text(text = entry.label, fontSize = 11.sp) }
                                    )
                                }
                            }
                        }
                    }
                ) { innerPadding ->
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(innerPadding)
                    ) {
                        when (destination) {
                            Destination.Library -> LibraryScreen(
                                app = app,
                                baseUrl = baseUrl,
                                username = username,
                                snackbarHostState = snackbarHostState
                            )

                            Destination.Search -> SearchScreen(
                                app = app,
                                baseUrl = baseUrl,
                                username = username,
                                snackbarHostState = snackbarHostState
                            )

                            Destination.Downloads -> DownloadsScreen(
                                app = app,
                                baseUrl = baseUrl,
                                username = username,
                                snackbarHostState = snackbarHostState
                            )

                            Destination.Shared -> SharedScreen(
                                app = app,
                                baseUrl = baseUrl,
                                username = username,
                                snackbarHostState = snackbarHostState
                            )

                            Destination.Settings -> SettingsScreen(
                                app = app,
                                baseUrl = baseUrl,
                                username = username,
                                onApplied = { server, user ->
                                    baseUrl = server
                                    username = user
                                    LibraryRefresh.bump()
                                }
                            )
                        }
                    }
                }
            }

            if (nowPlayingOpen && PlayerConnection.hasItem) {
                NowPlayingScreen(onCollapse = { nowPlayingOpen = false })
            }
        }
    }
}
