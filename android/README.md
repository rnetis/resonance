# Resonance for Android

A **native Kotlin + Jetpack Compose client** for the Resonance server API. It is a thin
client on purpose: YouTube search, `yt-dlp` downloads, tagging and transcoding all happen on
the server, which is why the app works with nothing but an address and a username.

```
┌──────────────────────────── Android app ─────────────────────────────┐
│  Compose UI ── Api (OkHttp + org.json) ── SharedPreferences           │
│      │                 │                          │                   │
│      │            /api/*  JSON                    │        offline/   │
│      │                                            │        (filesDir) │
│      └── MediaController ── MediaSessionService ── ExoPlayer ─────────┘
│                                       │
└───────────────────────────────────────┼──────────────────────────────┘
                                        ↓
                       GET /api/stream  |  GET /api/playlist (HLS)
                       server.js + yt-dlp + ffmpeg
```

## What it does

- **First run** — enter the address the server prints (`192.168.1.20:3130`; `http://` is
  implied), tap *Test connection* (`GET /api/health`), pick an existing username or create a
  new one (`GET/POST /api/users`). Server URL + username are saved in SharedPreferences.
- **Search** — `GET /api/search?q=` with thumbnail, channel and length; `+` starts a server
  download (`POST /api/download`) into *your* library and reports the returned job phase.
- **Downloads** — `GET /api/jobs` polled every 1.5 s while the screen is visible, progress bar
  from `progress.percent`, speed/ETA, cancel or remove with `DELETE /api/jobs/:id`. A finished
  job can be played immediately (its `file` is the library-relative path).
- **Library** — `GET /api/tracks?recursive=1` with folder navigation, cover art
  (`GET /api/cover`, 404 falls back to a music-note placeholder), `m:ss` durations and a
  *Mine / Shared* scope switch (the shared area is read-only, so destructive menu entries
  disappear there). Tapping a track plays the whole visible list from that row.
  Track menu (⋮ or long-press): **Share with…** (dialog over `GET /api/users` plus *Everyone*,
  posted to `POST /api/share`), **Save offline** (streams `url` into `filesDir/offline/<sha1>`
  with OkHttp and records it in SharedPreferences) and **Delete** (`DELETE /api/track`, own
  library only).
- **Shared** — two tabs over `GET /api/shares`: *Shared with me* (Play / Save to my library /
  Dismiss) and *I shared* (Revoke). Shares whose file is gone (`available: false`) show
  *file is gone* and cannot be played.
- **Playback** — a Media3 `MediaSessionService` owns an `ExoPlayer` with the full track list
  queued; a persistent bottom bar expands into a full Now Playing screen with seek, shuffle
  and repeat. Chunked (HLS) playback is preferred: any track with an `hls` field is built as an
  explicit `HlsMediaSource` (the playlist URL has no `.m3u8` suffix, so extension sniffing is
  not used); when the playlist is unavailable the service falls back to the progressive
  `url`. Offline copies play from their `file://` path. MediaSession metadata (title, artist,
  artwork URI) drives the notification and lock screen.
- **Settings** — change server/username later, see the full `/api/health` diagnostics, inspect
  the player connection and clear the offline copies from the device.

## Layout

| File | Role |
| --- | --- |
| `MainActivity.kt` | `ComponentActivity`, hosts the Compose tree |
| `ResonanceApp.kt` | `Application`: `Prefs`, `Api`, `OfflineStore` |
| `data/Models.kt` | plain data classes mirroring the JSON + parsing helpers + formatters |
| `data/Api.kt` | handwritten REST client (OkHttp + platform `org.json`) |
| `data/Prefs.kt` | server URL, username, offline index, address normalisation |
| `data/OfflineStore.kt` | "save offline" streaming download into `filesDir/offline/` |
| `player/PlaybackService.kt` | `MediaSessionService` + `ExoPlayer` + chunk-aware `MediaSource.Factory` |
| `player/PlayerConnection.kt` | UI-side `MediaController`, queue building, state mirror |
| `ui/AppRoot.kt` | setup gate, scaffold, bottom navigation, now-playing overlay |
| `ui/SetupScreen.kt`, `ui/SettingsScreen.kt` | first-run and settings |
| `ui/LibraryScreen.kt`, `ui/SearchScreen.kt`, `ui/DownloadsScreen.kt`, `ui/SharedScreen.kt` | the four data screens |
| `ui/NowPlayingBar.kt`, `ui/NowPlayingScreen.kt` | mini player and full player |
| `ui/Theme.kt` | Material 3 dark scheme (purple `#7C5CFF`), shared `CoverArt` |

## Building

There is **no Gradle wrapper jar in the repository on purpose** (no binary blobs): CI installs
Gradle itself. On a GitHub Actions `ubuntu-latest` runner with JDK 17 and the Android SDK
preinstalled:

```bash
cd android
gradle assembleDebug            # Gradle 8.9, AGP 8.5.2, Kotlin 1.9.24
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

Exact versions: Gradle 8.9 · AGP 8.5.2 · Kotlin 1.9.24 · Compose BOM `2024.06.00`
(`kotlinCompilerExtensionVersion = 1.5.14`) · compileSdk/targetSdk 34, minSdk 24, JVM 17 ·
androidx.media3 1.3.1 (`media3-exoplayer`, `media3-exoplayer-hls`, `media3-session`,
`media3-ui`) · OkHttp 4.12.0 · Coil 2.6.0 · kotlinx-coroutines-android 1.8.1 (for
`Dispatchers.Main`/`IO`). JSON is parsed with the platform's `org.json`; settings use plain
`SharedPreferences` — no Retrofit, no kotlinx.serialization, no DataStore.

The APK is **debug-signed** (`assembleDebug`), i.e. installable with `adb install -r
app-debug.apk` or by copying it to the device. It is not a Play Store artifact.

## How it talks to the server

| Method | Endpoint | Used for |
| --- | --- | --- |
| `GET` | `/api/health` | *Test connection*, settings diagnostics |
| `GET` | `/api/users` | user picker, "Share with…" dialog |
| `POST` | `/api/users` | create a username |
| `GET` | `/api/search?q=` | YouTube search |
| `POST` | `/api/download` | queue a download into your library |
| `GET` | `/api/jobs` | download progress (1.5 s poll) |
| `DELETE` | `/api/jobs/:id` | cancel / remove |
| `GET` | `/api/tracks?path=&recursive=1&scope=` | library and shared-area browser |
| `GET` | `/api/stream`, `/api/playlist`, `/api/cover` | progressive audio, chunked audio, artwork |
| `DELETE` | `/api/track?path=` | delete a track from your own library |
| `GET` | `/api/shares` | shared-with-me / I-shared |
| `POST` | `/api/share` | share a track (username or `*`) |
| `DELETE` | `/api/shares/:id` | dismiss (recipient) or revoke (sender) |
| `POST` | `/api/shares/:id/import` | copy a shared track into your own library |

Every JSON request carries `X-Resonance-User: <username>`, which is how the server picks the
library to answer with. Media URLs are used exactly as the API returns them (they already carry
`?user=` / `?scope=` / `?share=`), **without** that header, because the server gives the header
priority over the query string.

### Chunked playback

`GET /api/playlist` returns an HLS media playlist whose segment lines are rewritten as
server-relative paths (`/api/chunk?key=…&name=seg00000.ts`) and which has no `.m3u8` suffix
in the URL. The app therefore:

1. expands the server's `hls` field to an absolute URL (`http://host:port/api/playlist?path=…`),
2. builds that item with an explicit `HlsMediaSource` (via `HlsMediaSource.Factory`), never by
   sniffing the extension, and
3. lets ExoPlayer resolve the segment URIs against the absolute playlist URL — media3's
   `HlsMediaChunk` resolves them with `UriUtil.resolveToUri` (RFC 3986), so a rooted
   `/api/chunk…` reference resolves to `http://host:port/api/chunk…` correctly.

If the playlist request fails (the server answers 503 when ffmpeg is missing, or 504 while the
first segment is still being written) the service swaps that item for its progressive `url` and
resumes at the same position.

## Notes and limits

- **No authentication by design.** A username is an identity for choosing a library, not a
  credential: do not expose the server to the internet.
- **Plain `http://` on the LAN**: `usesCleartextTraffic="true"` plus a network security config
  that also trusts user-installed CAs (so a self-signed HTTPS server works for the API and for
  artwork).
- The app needs the server for search, downloads and streaming; offline copies play without it.
- Notifications on Android 13+ need the `POST_NOTIFICATIONS` permission, which the app asks for
  on first launch.
- Search results cannot be streamed from YouTube directly — the server has to download them
  first, which is why `+` starts a job instead of playing.
