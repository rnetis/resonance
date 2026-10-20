# Resonance — PWA Music Player

An installable, offline-capable music player built on the existing music API in this
project (`new.js`): YouTube search via `youtube-search-api`, downloads via `yt-dlp`,
a tagged local library, and now a full Progressive Web App front end.

```
┌──────────────┐   /api/search    ┌──────────────┐   spawn    ┌─────────┐
│  PWA (public)│ ───────────────▶ │  server.js   │ ─────────▶ │ yt-dlp  │
│  public/js/* │   /api/download  │  Express 5   │            │ ffmpeg  │
│  sw.js       │   /api/tracks    │              │ ◀───────── │ ffprobe │
│              │   /api/stream    │              │            └─────────┘
└──────────────┘   /api/cover     └──────┬───────┘
                                          │ ID3 / M4A tags (lib/id3.js)
                                    /root/music (library)
```

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
own → **⋮** on any track for play next, queue, playlists, save-offline, delete.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for local-only) |
| `MUSIC_DIR` | `~/music` | Library root; all API paths are relative to it |
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
| `GET` | `/api/health` | Server/tooling status |
| `GET` | `/api/search?q=` | YouTube results (id, title, channel, length, thumbnail) |
| `POST` | `/api/download` | `{ url, autoPlay }` → 202 with the job object |
| `GET` | `/api/jobs` | All jobs with live progress |
| `GET` | `/api/jobs/:id` | One job |
| `DELETE` | `/api/jobs/:id` | Cancel a running job (SIGINT + cleanup) or drop a finished one |
| `GET` | `/api/tracks?path=&recursive=1` | Library listing with ID3/M4A tags |
| `GET` | `/api/duration?path=` | `ffprobe` duration, cached |
| `GET` | `/api/stream?path=[&download=1]` | Audio stream, **HTTP Range** support (`206`), ETag, 304 |
| `GET` | `/api/cover?path=` | Embedded APIC art (PNG/JPEG), ffmpeg extraction fallback, cached |
| `DELETE` | `/api/track?path=` | Delete a file from the library |

Every path argument is resolved inside `MUSIC_DIR`; absolute paths and `../` traversal
return `400`.

## Project layout

```
server.js              Express API + static host + PWA fallback
lib/id3.js             ID3v2.2/2.3/2.4 + v1 tag reader (title/artist/album/duration/APIC)
new.js                 original API, kept for reference (`npm run legacy-api`)
public/index.html      app shell + SVG icon sprite + row templates
public/styles.css      dark theme, responsive layout, safe-area aware
public/js/app.js       UI: tabs, search, library, downloads, playlists, PWA wiring
public/js/player.js    audio engine: queue, Media Session, offline source swap, visualiser
public/js/offline.js   Cache Storage audio cache (save/list/remove/blob URL)
public/js/util.js      DOM helpers, formatting, menus, dialogs, toasts
public/sw.js           precache shell, network-first navigations, SWR assets, /api passthrough
public/manifest.webmanifest
public/icons/*         generated icon set (tools/make-icons.py)
tests/api.test.js      API integration tests (node:test)
docs/screenshots/      library / search / now-playing screenshots
ios/                   native iOS shell (SwiftUI + WKWebView) — see ios/README.md
tools/                 icon generators (PWA + iOS)
.github/workflows/     CI: runs the API tests, builds the unsigned iOS IPA
```

## Tests

```bash
npm test        # node --test tests/*.test.js
```

The suite boots `server.js` on port 3399 against a throwaway library built with
`ffmpeg`, then verifies tag parsing, recursive listing, non-audio filtering, Range
semantics (`200`/`206`/suffix/`416`), path-traversal refusal, cover extraction + `404`,
duration probing, download validation + job cancel, track deletion, PWA asset serving,
and the SPA fallback.

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
with live progress, library browsing, playlists, on-device offline copies, and `AVPlayer`
playback with lock-screen controls. Playback keeps going when the screen locks
(`AVAudioSession .playback` configured once at launch + `UIBackgroundModes: audio`), and
"save on device" works over plain HTTP because it does not need a service worker.

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
