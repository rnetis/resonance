# Resonance for iOS

A **native SwiftUI client** for the Resonance server API — no `WKWebView`. The app talks
to the same JSON endpoints the web app uses and plays audio with `AVPlayer`.

```
      ┌─────────────────────────── iOS app ───────────────────────────┐
      │  SwiftUI UI ── APIClient ── AVPlayer ── MPNowPlaying/Remote   │
      │      │             │            │                             │
      │      │        URLCache      device copy (OfflineStore)        │
      └──────┼─────────────┼────────────┼─────────────────────────────┘
             │             │            │
        GET /api/tracks  /api/stream  (file://)
             ↓             ↓
        server.js + yt-dlp + ffmpeg   (search, downloads, tags, Range audio)
```

## Why a native client

The heavy lifting (YouTube search, `yt-dlp` downloads, tagging, transcoding) happens on the
server and cannot run in an iOS sandbox — so the app is a client either way. Doing it
natively instead of in a web view buys:

- **Reliable background audio.** `AVPlayer` + `AVAudioSession .playback` + `UIBackgroundModes: audio`
  keeps playing when the screen locks, instead of fighting WebKit's audio pipeline.
- **Real offline playback over plain HTTP.** Tracks are downloaded into the app's storage,
  which needs no secure context (the web app's offline cache requires HTTPS).
- **Native lock screen**: artwork, scrubber, transport and headset buttons via
  `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter`.
- A UI that behaves like an iOS app rather than a web page.

## Layout

| File | Role |
| --- | --- |
| `ResonanceApp.swift` | `@main`, owns the stores, `RootView` with five tabs + mini player |
| `APIClient.swift` | HTTP client for the server API, self-signed TLS support, error mapping |
| `Models.swift` | Codable mirrors of the API JSON (`Track`, `Job`, `SearchResult`, …) |
| `AudioEngine.swift` | `AVPlayer` queue player, shuffle/repeat, now playing, remote commands |
| `OfflineStore.swift` | downloads tracks onto the device (`/api/stream` → Application Support) |
| `PlaylistStore.swift` | local playlists (the server has no playlist API) |
| `DownloadCenter.swift` | starts and polls server download jobs, surfaces completion |
| `ServerStore.swift` | server address + trust setting, the username, health checks, name list |
| `LibraryView.swift` | folders, recursive "all songs", filter, your library ↔ shared area, share |
| `SearchView.swift` | YouTube search via the server, download-and-play flow |
| `DownloadsView.swift` | live jobs: progress, cancel, retry, play, save on device |
| `PlaylistsView.swift` | playlists + "On this device" |
| `SharedView.swift` | Shared tab (incoming/outgoing, play/import/dismiss/revoke) + share picker |
| `NowPlayingView.swift` | artwork, seek, transport, volume, queue |
| `Components.swift` | rows, artwork loader, shared small views |
| `Support.swift` | formatting helpers, `RemoteImage` |

## Server API used

| Method | Endpoint | Used for |
| --- | --- | --- |
| `GET` | `/api/health` | connection test, yt-dlp/ffprobe status |
| `GET` | `/api/search?q=` | YouTube results |
| `POST` | `/api/download` | start a `yt-dlp` job |
| `GET` | `/api/jobs` | progress and history |
| `DELETE` | `/api/jobs/:id` | cancel, or drop a finished job |
| `GET` | `/api/tracks?path=&recursive=1[&scope=shared]` | library listing (folders + tagged tracks) |
| `GET` | `/api/users`, `POST /api/users` | people on the server; create one |
| `GET` | `/api/shares` | `{ incoming, outgoing }` for your name |
| `POST` | `/api/share` | `{ trackPath, to, note? }` — one person or `"*"` |
| `DELETE` | `/api/shares/:id`, `POST /api/shares/:id/import` | revoke/dismiss, copy into your library |
| `GET` | `/api/playlist.m3u8?path=\|share=` | chunked (HLS) playlist, used for remote playback |
| `GET` | `/api/duration?path=` | ffprobe duration for fresh files |
| `GET` | `/api/stream?path=\|share=` | audio (Range requests; AVPlayer seeks natively) |
| `GET` | `/api/chunk?key=&name=` | one MPEG-TS chunk of a chunked stream |
| `GET` | `/api/cover?path=` | embedded cover art |
| `DELETE` | `/api/track?path=` | delete a file from the library |

## Building

**GitHub Actions (no Mac needed)** — `.github/workflows/ios-ipa.yml` runs on push (when
`ios/**` changes), on demand (Actions → *iOS IPA* → *Run workflow*, optional version
override), and attaches the IPA to a Release when a `v*` tag is pushed.

**Local macOS:**

```bash
brew install xcodegen
./ios/build-ipa.sh          # writes build/Resonance.ipa
```

The archive is built with `CODE_SIGNING_ALLOWED=NO`, so the IPA is unsigned — the normal
input for AltStore / Sideloadly / TrollStore, which re-sign it for your device.

## First run

1. Launch → **Connect your server**.
2. Enter the address `node server.js` prints, e.g. `192.168.1.20:3130` (include the port;
   `http://` is assumed — that is also what allows offline downloads on the device).
3. Tap **Connect**: the app health-checks the address before saving it.
4. Pick **who is listening** — an existing name, or create a new one. Each name gets its own
   library on the server, and that is the name other people share songs with.

Change the address or the name later from the Library's ⋯ menu → *Server settings*
(*Who’s listening* section). Names are not passwords: they only decide which library the
server answers with.

## Using it

- **Search** — tap a result to download it and play it when it lands; the context menu adds
  *Download only*, *Download, then queue* and *Open on YouTube*.
- **Library** — browse folders or switch to **All songs**; the filter narrows the current
  list. The 👥 toolbar button switches to the **shared area** (everyone's songs, read-only)
  and back. Track menu: play, play next, add to queue, add to playlist, **share with…**,
  **save on device**, delete from library.
- **Shared** — *Shared with me* / *I shared*. Incoming rows can be played straight from the
  sender's library, copied into yours (**Save to my library**) or dismissed; outgoing ones can
  be revoked. A share whose file was deleted shows a warning and cannot be played.
- **Sharing** works because the server keeps the file where it is: nothing is duplicated until
  the recipient chooses to copy it.
- **Downloads** — live server progress (percent, speed, ETA), cancel, retry; finished files
  can be played or saved on device.
- **Playlists** — local playlists plus every track saved on the device (with total size).
- **Now playing** — tap the mini player: artwork, scrubbing, shuffle/repeat, volume, queue.

## Notes and limits

- **Search results cannot be streamed directly** — YouTube audio must be downloaded by the
  server first, which is why tapping a result starts a download.
- **The server must be reachable** for search, downloads and streaming. Offline copies play
  without it. The server has no authentication: do not expose it publicly.
- **Plain `http://` is expected** on a LAN, hence `NSAllowsArbitraryLoads`. Self-signed
  HTTPS also works for the API and artwork (enable *Trust self-signed certificate*), but
  `AVPlayer` uses its own network stack and refuses a self-signed certificate — prefer http
  on a trusted network, or a properly trusted certificate (Tailscale, Let's Encrypt).
- **Chunked playback** — remote tracks play from the server's HLS playlist
  (`/api/playlist.m3u8`), so audio starts after the first ~4 s segment instead of after the
  whole file. If that playlist is unavailable (no `ffmpeg` on the server, or it is still
  preparing) the app falls back automatically to the Range stream. Device copies always play
  from the local file.
- **iOS 16 or newer.**
- Offline tracks live in the app's Application Support directory; *Server settings →
  Offline storage* shows the size and can delete them. Deleting the app removes them.

## Troubleshooting

- **"Can't reach the server"** → check the address and that `node server.js` is running;
  *Server settings → Re-check server* shows the library folder and tool availability.
- **A download fails** → usually an age/region-restricted video, or `yt-dlp` missing on the
  server (see `/api/health`). The row shows the server's own error text.
- **Audio stops when the screen locks** → *Server settings → Playback diagnostics* shows the
  session category and player state. The session is configured once at launch and never
  touched again, which is what keeps background audio stable.
- **No cover art on the lock screen** → that file has no embedded art, or artwork could not
  be fetched (see the self-signed note above).
- **A song starts slowly on the first play** → the server is still segmenting that file with
  `ffmpeg`; the next plays of the same track start immediately (the chunks are cached).
- **Someone cannot see a shared song** → confirm they picked their own name (the chip in
  *Server settings → Who’s listening*) rather than browsing as someone else.
