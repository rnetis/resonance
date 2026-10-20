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
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import kotlinx.coroutines.launch

/**
 * First-run gate: point the app at a server, check it answers `/api/health`, then pick an
 * existing username or create a new one. Both values are stored in SharedPreferences.
 */
@Composable
fun SetupScreen(app: ResonanceApp, onReady: (String, String) -> Unit) {
    val scope = rememberCoroutineScope()

    var serverInput by remember { mutableStateOf(app.prefs.serverUrl.ifBlank { "192.168.1.20:3130" }) }
    var normalized by remember { mutableStateOf(app.prefs.serverUrl) }
    var health by remember { mutableStateOf<Health?>(null) }
    var users by remember { mutableStateOf<List<UserInfo>>(emptyList()) }
    var selected by remember { mutableStateOf(app.prefs.username) }
    var newUser by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun checkConnection() {
        val base = Prefs.normalizeServer(serverInput)
        if (base == null) {
            error = "Enter an address like 192.168.1.20:3130"
            return
        }
        busy = true
        error = null
        health = null
        users = emptyList()
        scope.launch {
            try {
                val result = app.api.health(base, selected.ifBlank { null })
                health = result
                normalized = base
                val page = app.api.users(base, selected.ifBlank { null })
                users = page.users
                if (selected.isBlank()) {
                    selected = page.defaultUser.orEmpty().ifBlank { page.users.firstOrNull()?.name.orEmpty() }
                }
            } catch (e: Exception) {
                error = e.message ?: "Could not reach the server"
                health = null
            }
            busy = false
        }
    }

    fun createUser() {
        val base = normalized.ifBlank { Prefs.normalizeServer(serverInput).orEmpty() }
        val name = newUser.trim().lowercase()
        if (base.isBlank()) {
            error = "Test the connection first"
            return
        }
        if (name.isEmpty()) {
            error = "Type a username first"
            return
        }
        busy = true
        error = null
        scope.launch {
            try {
                val created = app.api.createUser(base, null, name)
                users = users.filter { it.name != created.name } + created
                selected = created.name
                newUser = ""
            } catch (e: Exception) {
                error = e.message ?: "Could not create that user"
            }
            busy = false
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(22.dp)
    ) {
        Spacer(Modifier.height(28.dp))
        Text(text = "Resonance", color = ResonancePurple, fontSize = 30.sp, fontWeight = FontWeight.Bold)
        Text(
            text = "Point the app at your music server. The username picks which library you see - there is no password.",
            color = TextSecondary,
            fontSize = 13.sp
        )
        Spacer(Modifier.height(20.dp))

        OutlinedTextField(
            value = serverInput,
            onValueChange = { serverInput = it },
            label = { Text("Server address") },
            placeholder = { Text("192.168.1.20:3130") },
            singleLine = true,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(10.dp))

        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { checkConnection() }, enabled = !busy) {
                Text("Test connection")
            }
            if (busy) {
                Spacer(Modifier.width(12.dp))
                CircularProgressIndicator(modifier = Modifier.width(20.dp).height(20.dp))
            }
        }

        error?.let { message ->
            Spacer(Modifier.height(10.dp))
            Text(text = message, color = ErrorRed, fontSize = 13.sp)
        }

        health?.let { result ->
            Spacer(Modifier.height(14.dp))
            Text(text = "Server", color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            result.diagnostics().forEach { (label, value) ->
                Row(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                    Text(text = label, color = TextSecondary, fontSize = 12.sp, modifier = Modifier.weight(1f))
                    Text(text = value, color = TextPrimary, fontSize = 12.sp)
                }
            }

            Spacer(Modifier.height(18.dp))
            Text(text = "Who are you?", color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            users.forEach { user ->
                val active = user.name == selected
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 3.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(if (active) MaterialTheme.colorScheme.primaryContainer else SurfaceRaised)
                        .clickable { selected = user.name }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = user.name + if (user.isDefault) "  (default)" else "",
                            color = if (active) MaterialTheme.colorScheme.onPrimaryContainer else TextPrimary,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            text = "${user.tracks} tracks",
                            color = TextSecondary,
                            fontSize = 12.sp
                        )
                    }
                    if (active) {
                        Text(text = "✓", color = MaterialTheme.colorScheme.primary, fontSize = 16.sp)
                    }
                }
            }

            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = newUser,
                onValueChange = { newUser = it },
                label = { Text("New username") },
                supportingText = { Text("1-32 characters: a-z 0-9 . _ -") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { createUser() }, enabled = !busy) {
                    Text("Create user")
                }
            }
        }

        Spacer(Modifier.height(22.dp))
        Button(
            onClick = {
                val base = normalized.ifBlank { Prefs.normalizeServer(serverInput).orEmpty() }
                if (base.isBlank() || selected.isBlank()) return@Button
                app.prefs.serverUrl = base
                app.prefs.username = selected
                onReady(base, selected)
            },
            enabled = health != null && selected.isNotBlank(),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Save and start")
        }
        Spacer(Modifier.height(30.dp))
    }
}
