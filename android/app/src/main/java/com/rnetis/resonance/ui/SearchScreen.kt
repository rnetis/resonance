package com.rnetis.resonance.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.rnetis.resonance.ResonanceApp
import com.rnetis.resonance.data.SearchResult
import kotlinx.coroutines.launch

/**
 * YouTube search through the server. Nothing can be streamed straight from YouTube, so the
 * "+" button asks the server to download the audio into *your* library and reports the job
 * phase it got back.
 */
@Composable
fun SearchScreen(
    app: ResonanceApp,
    baseUrl: String,
    username: String,
    snackbarHostState: SnackbarHostState
) {
    val scope = rememberCoroutineScope()

    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<SearchResult>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var queuedIds by remember { mutableStateOf<Set<String>>(emptySet()) }

    fun runSearch() {
        val text = query.trim()
        if (text.isEmpty()) return
        searching = true
        error = null
        scope.launch {
            try {
                results = app.api.search(baseUrl, username, text)
            } catch (e: Exception) {
                results = emptyList()
                error = e.message ?: "Search failed"
            }
            searching = false
        }
    }

    fun download(result: SearchResult) {
        scope.launch {
            try {
                val job = app.api.download(baseUrl, username, result.url, false)
                queuedIds += result.id
                val phase = job.phase ?: job.status
                snackbarHostState.showSnackbar("Queued: $phase - " + (job.title ?: result.name))
            } catch (e: Exception) {
                snackbarHostState.showSnackbar(e.message ?: "Could not start the download")
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                label = { Text("Search YouTube") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { runSearch() }),
                modifier = Modifier.weight(1f)
            )
            Spacer(Modifier.width(8.dp))
            Button(onClick = { runSearch() }, enabled = !searching) {
                Text("Go")
            }
        }

        error?.let { message ->
            Text(
                text = message,
                color = ErrorRed,
                fontSize = 13.sp,
                modifier = Modifier.padding(horizontal = 14.dp)
            )
        }

        if (searching) {
            Box(modifier = Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        }

        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            items(results, key = { item -> item.id }) { result ->
                Card(
                    shape = androidx.compose.foundation.shape.RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(
                            modifier = Modifier.size(84.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(text = "🎬", color = TextSecondary, fontSize = 16.sp)
                            if (!result.thumbnail.isNullOrBlank()) {
                                AsyncImage(
                                    model = result.thumbnail,
                                    contentDescription = null,
                                    modifier = Modifier.size(84.dp)
                                )
                            }
                        }
                        Spacer(Modifier.width(10.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = result.name,
                                color = TextPrimary,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis
                            )
                            Text(
                                text = buildString {
                                    append(result.channel ?: "Unknown channel")
                                    result.length?.let { append("  ·  "); append(it) }
                                    result.views?.let { append("  ·  "); append(it) }
                                },
                                color = TextSecondary,
                                fontSize = 12.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            if (queuedIds.contains(result.id)) {
                                Text(text = "Queued in Downloads", color = ResonancePurple, fontSize = 11.sp)
                            }
                        }
                        Text(
                            text = "+",
                            color = MaterialTheme.colorScheme.primary,
                            fontSize = 26.sp,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier
                                .size(40.dp)
                                .clickable { download(result) }
                                .padding(start = 12.dp)
                        )
                    }
                }
            }

            if (results.isEmpty() && !searching) {
                item {
                    Text(
                        text = "Search for a song and tap + to download it into your library.",
                        color = TextSecondary,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }
        }
    }
}
