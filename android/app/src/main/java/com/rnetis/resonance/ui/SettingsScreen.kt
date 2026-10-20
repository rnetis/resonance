package com.rnetis.resonance.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rnetis.resonance.ResonanceApp
import com.rnetis.resonance.data.Health
import com.rnetis.resonance.data.Prefs
import com.rnetis.resonance.data.UserInfo
import com.rnetis.resonance.data.formatBytes
import com.rnetis.resonance.player.PlayerConnection
import kotlinx.coroutines.launch

/**
 * Change the server or username at any time, and see what `GET /api/health` says about the
 * server (yt-dlp / ffprobe / ffmpeg, chunked playback, queue depth).
 */
@Composable
fun SettingsScreen(
    app: ResonanceApp,
    baseUrl: String,
    username: String,
    onApplied: (String, String) -> Unit
) {
    val scope = rememberCoroutineScope()

    var serverInput by remember { mutableStateOf(baseUrl) }
    var userInput by remember { mutableStateOf(username) }
    var health by remember { mutableStateOf<Health?>(null) }
    var users by remember { mutableStateOf<List<UserInfo>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var offlineFiles by remember { mutableStateOf(app.offline.savedCount()) }
    var offlineBytes by remember { mutableStateOf(app.offline.totalBytes()) }

    fun recheck() {
        val target = Prefs.normalizeServer(serverInput)
        if (target == null) {
            error = "Enter an address like 192.168.1.20:3130"
            return
        }
        busy = true
        error = null
        message = null
        scope.launch {
            try {
                health = app.api.health(target, userInput.ifBlank { null })
                users = app.api.users(target, userInput.ifBlank { null }).users
            } catch (e: Exception) {
                health = null
                users = emptyList()
                error = e.message ?: "Could not reach the server"
            }
            busy = false
        }
    }

    fun save() {
        val target = Prefs.normalizeServer(serverInput)
        if (target == null) {
            error = "Enter an address like 192.168.1.20:3130"
            return
        }
        val name = userInput.trim().lowercase()
        if (name.isEmpty()) {
            error = "Type a username"
            return
        }
        error = null
        app.prefs.serverUrl = target
        app.prefs.username = name
        userInput = name
        serverInput = target
        message = "Saved. The app now uses \"" + name + "\" on " + target + "."
        onApplied(target, name)
    }

    LaunchedEffect(Unit) { recheck() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp)
    ) {
        Text(text = "Settings", color = TextPrimary, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(14.dp))

        Text(text = "Server", color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        OutlinedTextField(
            value = serverInput,
            onValueChange = { serverInput = it },
            label = { Text("Server address") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { recheck() }, enabled = !busy) { Text("Re-check server") }
            if (busy) {
                Spacer(Modifier.width(12.dp))
                CircularProgressIndicator(modifier = Modifier.width(20.dp).height(20.dp))
            }
        }

        error?.let {
            Spacer(Modifier.height(8.dp))
            Text(text = it, color = ErrorRed, fontSize = 13.sp)
        }
        message?.let {
            Spacer(Modifier.height(8.dp))
            Text(text = it, color = ResonancePurple, fontSize = 13.sp)
        }

        health?.let { result ->
            Spacer(Modifier.height(12.dp))
            Text(text = "Server diagnostics", color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            result.diagnostics().forEach { (label, value) ->
                Row(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                    Text(text = label, color = TextSecondary, fontSize = 12.sp, modifier = Modifier.weight(1f))
                    Text(text = value, color = TextPrimary, fontSize = 12.sp)
                }
            }
        }

        Spacer(Modifier.height(20.dp))
        Text(text = "Who you are", color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(4.dp))
        Text(
            text = "The username selects which library you see. There is no password: anyone who can reach the server can pick any name.",
            color = TextSecondary,
            fontSize = 12.sp
        )
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = userInput,
            onValueChange = { userInput = it },
            label = { Text("Username") },
            singleLine = true,
            supportingText = { Text("a-z 0-9 . _ - (1-32 characters)") },
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(8.dp))
        users.forEach { user ->
            val active = user.name == userInput.trim().lowercase()
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 3.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (active) MaterialTheme.colorScheme.primaryContainer else SurfaceRaised)
                    .clickable { userInput = user.name }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = user.name,
                    color = if (active) MaterialTheme.colorScheme.onPrimaryContainer else TextPrimary,
                    fontSize = 14.sp,
                    modifier = Modifier.weight(1f)
                )
                Text(text = user.tracks.toString() + " tracks", color = TextSecondary, fontSize = 12.sp)
            }
        }
        Spacer(Modifier.height(10.dp))
        Button(onClick = { save() }, modifier = Modifier.fillMaxWidth()) { Text("Save settings") }

        Spacer(Modifier.height(22.dp))
        Text(text = "Playback", color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Row(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
            Text(text = "Player service", color = TextSecondary, fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text(
                text = if (PlayerConnection.connected) "connected" else "not connected",
                color = TextPrimary,
                fontSize = 12.sp
            )
        }
        Row(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
            Text(text = "Streaming", color = TextSecondary, fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text(
                text = if (health?.chunked == true) "chunked (hls) preferred" else "progressive http",
                color = TextPrimary,
                fontSize = 12.sp
            )
        }
        PlayerConnection.lastError?.let {
            Spacer(Modifier.height(4.dp))
            Text(text = it, color = ErrorRed, fontSize = 12.sp)
        }

        Spacer(Modifier.height(22.dp))
        Text(text = "Offline storage", color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Row(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
            Text(text = "Saved tracks", color = TextSecondary, fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text(text = offlineFiles.toString() + "  ·  " + formatBytes(offlineBytes), color = TextPrimary, fontSize = 12.sp)
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = {
                app.offline.deleteAll()
                offlineFiles = app.offline.savedCount()
                offlineBytes = app.offline.totalBytes()
                LibraryRefresh.bump()
                message = "Offline copies deleted."
            }) {
                Text("Delete offline copies", color = ErrorRed)
            }
        }
        Spacer(Modifier.height(30.dp))
    }
}
