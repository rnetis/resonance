# Resonance — self-hosted music player (PWA · iOS · Android)

One server, three clients: an installable PWA, a native SwiftUI iOS app and a native
Kotlin/Compose Android app. YouTube search via `youtube-search-api`, downloads via
`yt-dlp`, a tagged local library, **a library per person**, **sharing between them**, and
**chunked (HLS) streaming** so a song starts after the first small segment.

```
┌───────────────────┐  /api/search    ┌──────────────┐   spawn    ┌─────────┐
│ PWA   public/js/* │  /api/download  │              │ ─────────▶ │ yt-dlp  │
│ iOS   ios/        │ ──────────────▶ │  server.js   │            │ ffmpeg  │
│ Andr. android/    │  /api/tracks    │  Express 5   │ ◀───────── │ ffprobe │
│                   │  /api/playlist  │              │            └─────────┘
└───────────────────┘  /api/stream    └──────┬───────┘
                                             │ ID3 / M4A tags (lib/id3.js)
                                   MUSIC_DIR ├─ <owner's own library>
                                             ├─ users/<name>/     (per person)
                                             └─ shared/           (read-only, everyone)
```

**Landing page:** <https://rnetis.github.io/resonance/> — a bilingual (English / فارسی) promo
page for this project, with screenshots, the feature tour, install links and the API summary.
Source: [`docs/index.html`](docs/index.html) — one self-contained file (GitHub Pages serves it
from `/docs`; open it directly or drop it on any static host).

## Highlights

- **Installable PWA** — web manifest, service worker app-shell cache, maskable icons,
  shortcuts, offline shell, update prompt.
- **Search → download → play** in one flow: tap a YouTube result, watch live progress
  (percent, speed, ETA, "converting audio"), and it starts playing when it lands.
- **Real library management** — folder browsing, recursive "All songs" mode, filter,
  play all / shuffle, delete, download to disk, cover art (embedded ID3 APIC, ffmpeg
  fallback).
- **Proper playback** — queue with play-next/add-to-queue, shuffle, repeat (off/all/one),
  seek, volume, keyboard shortcuts, and **Media Session** integration so lock-screen /
  headset / car controls work.
- **Offline audio** — "Save offline" stores the whole track in Cache Storage; playback
  transparently switches to the cached copy (blob URL) when the network is gone.
- **Playlists** (local) plus an automatic "Offline library" collection.
- **Live spectrum visualiser** in the Now Playing panel (WebAudio).
- **A library per person** — pick a name once per device and the server answers only
  with that person's folder. The library that already lives in `MUSIC_DIR` belongs to
  the server owner, so an existing install keeps working untouched.
- **Sharing** — send a song to one person or to everyone. The file stays in the sender's
  library; the recipient can play it in place or copy it into their own.
- **Seamless starts (chunked playback)** — the server segments a track with `ffmpeg`
  into ~4 s MPEG-TS chunks and serves an HLS playlist (`/api/playlist.m3u8`). The iOS and
  Android players start as soon as the first chunk arrives, and fall back automatically
  to the whole-file Range stream (which is what the web player uses, since Chrome has no
  native HLS).

## Quick start

```bash
bun install                 # or: npm install
PORT=3130 node server.js    # avoid :3000 if something else already listens there
# open http://127.0.0.1:3130
```

Requirements: Node 20+, `yt-dlp`, `ffmpeg`/`ffprobe` on `PATH`.

The server prints the listening URL, the library directory and every LAN URL it can
reach, e.g.:

```
Music PWA listening on http://0.0.0.0:3130
Library directory: /root/music
  LAN: http://192.168.1.20:3130  (eth0)
```

Then: **Search** → tap a result (downloads and plays) → **Library** to browse what you
own → **⋮** on any track for play next, queue, playlists, save-offline, **share with…**,
delete.

On first load the web app asks **who is listening** (the user chip in the header switches
later). Every name gets its own library on the server; `users/` and `shared/` are server
structure and never show up as folders in anyone's library.

> Usernames are **not authentication** — they only select which library you see. This is a
> home/LAN server: do not expose it to the internet without putting auth in front of it.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for local-only) |
| `MUSIC_DIR` | `~/music` | Library root; the owner's library, plus `users/`, `shared/`, `.data/`, `.cache/` |
| `DEFAULT_USER` | OS username | Who owns the files already in `MUSIC_DIR` |
| `HLS_SEGMENT_SECONDS` | `4` | Chunk length for chunked (HLS) playback |
| `HLS_MAX_BYTES` / `HLS_MAX_ENTRIES` | `2 GB` / `300` | Chunk-cache limit (oldest evicted) |
| `PUBLIC_BASE_URL` | – | Force the host used in HLS segment URLs (behind a proxy) |
| `AUDIO_FORMAT` | `mp3` | `yt-dlp -x --audio-format` target |
| `AUDIO_QUALITY` | `0` | `yt-dlp --audio-quality` |
| `MAX_CONCURRENT_DOWNLOADS` | `2` | Parallel `yt-dlp` processes |
| `MAX_QUEUED_DOWNLOADS` | `25` | Reject new jobs beyond this queue depth |
| `TLS_CERT` / `TLS_KEY` | – | Serve HTTPS (required for PWA install off-localhost) |

### Installing on a phone

Service workers (and therefore install + offline) require a **secure context**:
`http://localhost` / `http://127.0.0.1` qualify, a plain `http://192.168.x.x` does not.
To install on a phone, expose the server over HTTPS (Caddy/nginx/Tailscale Funnel/cloud
tunnel) or pass `TLS_CERT`/`TLS_KEY` with a certificate the device trusts.

## API

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | Server/tooling status (incl. `defaultUser`, `users`, `chunked`) |
| `GET` | `/api/users` | Everyone on the server, with track counts |
| `POST` | `/api/users` | `{ name }` → create a person (and their library) |
| `GET` | `/api/me` | The library the current identity resolves to |
| `GET` | `/api/shares` | `{ incoming, outgoing }` shares for that identity |
| `POST` | `/api/share` | `{ trackPath, to, note? }` → share with a name or `"*"` (everyone) |
| `DELETE` | `/api/shares/:id` | Sender revokes, recipient dismisses |
| `POST` | `/api/shares/:id/import` | Copy a shared track into your own library |
| `GET` | `/api/playlist[.m3u8]?path=\|share=` | Chunked (HLS) playlist: starts after the first segment |
| `GET` | `/api/search?q=` | YouTube results (id, title, channel, length, thumbnail) |
| `POST` | `/api/download` | `{ url, autoPlay }` → 202 with the job object |
| `GET` | `/api/jobs` | All jobs with live progress |
| `GET` | `/api/jobs/:id` | One job |
| `DELETE` | `/api/jobs/:id` | Cancel a running job (SIGINT + cleanup) or drop a finished one |
| `GET` | `/api/tracks?path=&recursive=1[&scope=shared]` | Library listing with ID3/M4A tags |
| `GET` | `/api/duration?path=` | `ffprobe` duration, cached |
| `GET` | `/api/stream?path=\|share=[&download=1]` | Audio stream, **HTTP Range** support (`206`), ETag, 304 |
| `GET` | `/api/chunk?key=&name=` | One MPEG-TS chunk of a chunked stream |
| `GET` | `/api/cover?path=` | Embedded APIC art (PNG/JPEG), ffmpeg extraction fallback, cached |
| `DELETE` | `/api/track?path=` | Delete a file from the library |

Every path argument is resolved inside the caller's library root; absolute paths and `../`
traversal return `400`.

**Identity**: send `X-Resonance-User: <name>` on API calls. Media URLs (audio, cover,
playlist) carry `?user=<name>` instead, because `<audio>`, `<img>`, AVPlayer and ExoPlayer
do not send custom headers. Share URLs (`?share=<id>&user=<name>`) are already scoped to
whoever asked for them.

## Project layout

```
server.js              Express API + static host + PWA fallback
lib/id3.js             ID3v2.2/2.3/2.4 + v1 tag reader (title/artist/album/duration/APIC)
new.js                 original API, kept for reference (`npm run legacy-api`)
public/index.html      app shell + SVG icon sprite + row templates
public/styles.css      dark theme, responsive layout, safe-area aware
public/js/app.js       UI: tabs, search, library, downloads, shared, playlists, PWA wiring
public/js/social.js    identity (username), user list, sharing, chooser dialogs
public/js/player.js    audio engine: queue, Media Session, offline source swap, visualiser
public/js/offline.js   Cache Storage audio cache (save/list/remove/blob URL)
public/js/util.js      DOM helpers, formatting, menus, dialogs, toasts
public/sw.js           precache shell, network-first navigations, SWR assets, /api passthrough
public/manifest.webmanifest
public/icons/*         generated icon set (tools/make-icons.py)
tests/api.test.js      API integration tests: library, streaming, covers, jobs, PWA (node:test)
tests/multiuser.test.js  users, per-person isolation, sharing, chunked (HLS) streaming
docs/index.html        bilingual promo / landing page (English + Persian), GitHub Pages entry
docs/screenshots/      library / search / now-playing screenshots
ios/                   native SwiftUI client — see ios/README.md
android/               native Kotlin/Compose client — see android/README.md
tools/                 icon generators (PWA + iOS)
.github/workflows/     CI: API tests, unsigned iOS IPA, debug Android APK
```

## Tests

```bash
npm test        # node --test tests/*.test.js
```

The suite boots `server.js` twice against throwaway libraries built with `ffmpeg`:

- `tests/api.test.js` (port 3399) — tag parsing, recursive listing, non-audio filtering,
  Range semantics (`200`/`206`/suffix/`416`), path-traversal refusal, cover extraction +
  `404`, duration probing, download validation + job cancel, track deletion, PWA asset
  serving, SPA fallback.
- `tests/multiuser.test.js` (port 3400) — who owns the pre-existing library, new people
  getting their own (empty) folder, isolation between libraries, the shared area being
  readable but not writable, downloads landing in the requester's folder, sharing
  (create → visible to the recipient, not broadcast, playable, 403 for outsiders →
  import copying the file without clobbering → revoke), and chunked streaming (playlist
  with chunk URIs, chunk fetch with `Range`, traversal refused for chunk references).

29 tests, no external services required.

## How the PWA pieces work

- **App shell** (`sw.js`): precaches HTML/CSS/JS/icons, serves navigations
  network-first with a cached fallback, and uses stale-while-revalidate for assets.
  `/api/*` is never intercepted — media Range requests must reach the network.
- **Offline audio**: `public/js/offline.js` stores whole responses in a
  `resonance-audio-v1` cache keyed by the canonical `/api/stream?path=…` URL. On load the
  player checks that cache first and plays a blob URL, so seeking still works offline.
- **Media Session**: metadata (title/artist/album/artwork) plus play/pause/prev/next/seek
  handlers and position state, so OS-level controls and headset buttons drive the player.
- **State restore**: queue, index, volume, shuffle/repeat and the last position are kept
  in `localStorage` and restored on launch (paused, ready to resume).

## iOS app

`ios/` is a **native SwiftUI client** for the server API (no web view): search, downloads
with live progress, library browsing (your library *and* the shared area), the **Shared**
tab (play / save to my library / dismiss / revoke), playlists, on-device offline copies,
and `AVPlayer` playback with lock-screen controls. Remote playback uses the **chunked
playlist** and falls back to the Range stream if the playlist is unavailable. Playback keeps
going when the screen locks (`AVAudioSession .playback` configured once at launch +
`UIBackgroundModes: audio`), and "save on device" works over plain HTTP because it does not
need a service worker. **Server settings → Who's listening** picks the name (and library)
this device browses.

```bash
# CI (no Mac required): Actions → "iOS IPA" → Run workflow
#   artifact: resonance-ios-unsigned-ipa → Resonance.ipa
# or locally on macOS:
brew install xcodegen && ./ios/build-ipa.sh
```

The IPA is unsigned by design — sideload it with AltStore, Sideloadly or TrollStore, which
re-sign it for your device. On launch, enter the address your server prints (e.g.
`192.168.1.20:3130`). Details, endpoint map and troubleshooting:
[`ios/README.md`](ios/README.md).

## Android app

`android/` is a **native Kotlin + Jetpack Compose client** (Media3 ExoPlayer), with the same
feature set: setup screen (server + your name), search, library with folder browsing and the
shared area, downloads with live progress, the **Shared** tab, offline copies, and
background playback through a `MediaSessionService` so the notification / lock screen
controls work. ExoPlayer gets an explicit `HlsMediaSource` for the chunked playlist
(`/api/playlist…`) and everything else — progressive audio, offline files — goes through the
default media source factory.

```bash
# CI (no Android SDK required): Actions → "Android APK" → Run workflow
#   artifact: resonance-android-apk → resonance-android.apk
# or locally, with JDK 17 + Android SDK 34:
cd android && gradle assembleDebug
```

The APK is **debug-signed**, so it installs by sideloading (allow installs from unknown
sources) and cannot be uploaded to Play. Open the app, enter the server address, tap
*Test connection*, then pick or create your name. Details:
[`android/README.md`](android/README.md).

## Troubleshooting

- **Port already in use** → pick another: `PORT=3130 node server.js`.
- **Downloads fail** → check `yt-dlp --version`; some videos are region/age restricted.
  `GET /api/health` reports `ytDlp`/`ffprobe` availability.
- **No durations** → `ffprobe` missing; the API returns `duration: null` and the UI shows
  `--:--` until a probe succeeds.
- **No cover art** → the file has no embedded picture; the UI falls back to a generated
  gradient placeholder with the track initials.
- **Debug handle** → open `/?debug=1` to expose `window.__app` (`player`, `state`, `api`,
  `offline`) for console inspection on real devices.

## Notes

`yt-dlp` downloads are your responsibility — respect YouTube's terms of service and the
rights of the content owners. Audio is stored locally on the machine running the server.
