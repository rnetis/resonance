# Resonance for iOS

A thin, native iOS shell around the Resonance web player. It is a SwiftUI app hosting a
`WKWebView` that loads **your own music server** — the point of this app is the native
packaging (home-screen icon, background audio, lock-screen playback), not a second
implementation of the player.

```
 ┌─────────────────────────────── iOS app ───────────────────────────────┐
 │  SwiftUI: setup / settings / error state                              │
 │  ┌────────────────────── WKWebView ──────────────────────┐            │
 │  │  the same PWA that runs in a browser                  │            │
 │  │  (service worker, offline audio cache, Media Session)  │            │
 │  └───────────────────────────────────────────────────────┘            │
 │  AVAudioSession .playback  +  UIBackgroundModes: audio                │
 └───────────────────────────────────────────────────────────────────────┘
                              ↓ http(s)
                    server.js (+ yt-dlp, ffmpeg)
```

Why a shell and not a standalone app: downloads and streaming are produced by `yt-dlp` /
`ffmpeg` on the machine running `server.js`, which cannot run inside an iOS sandbox. The
app therefore needs a reachable server address (LAN, Tailscale, VPN or public HTTPS).

## Files

| Path | Purpose |
| --- | --- |
| `project.yml` | XcodeGen spec — the `.xcodeproj` is generated, never committed |
| `Resonance/ResonanceApp.swift` | `@main` entry point, audio session bootstrap |
| `Resonance/ContentView.swift` | routing: setup vs. player, error overlay |
| `Resonance/SetupView.swift` | server address form, self-signed toggle, data clearing |
| `Resonance/WebViewScreen.swift` | player screen + native "can't reach server" state |
| `Resonance/ResonanceWebView.swift` | the `WKWebView`: bridge, navigation policy, TLS, storage |
| `Resonance/AppModel.swift` | `UserDefaults`-backed state, URL normalisation |
| `Resonance/AudioSessionController.swift` | background/interruption-safe audio session |
| `Resonance/Info.plist` | ATS exception, background audio, dark UI, launch colour |
| `Resonance/Assets.xcassets` | app icon (1024, opaque) and launch background |
| `build-ipa.sh` | local macOS build → unsigned `Resonance.ipa` |

## Building

**GitHub Actions (no Mac needed)** — `.github/workflows/ios-ipa.yml`:

- runs on every push that touches `ios/**` or the workflow itself,
- can be started manually (Actions → *iOS IPA* → *Run workflow*, optional version override),
- attaches the IPA to a GitHub Release when a `v*` tag is pushed.

Download `resonance-ios-unsigned-ipa` from the run's **Artifacts** section.

**Local macOS:**

```bash
brew install xcodegen
./ios/build-ipa.sh          # writes build/Resonance.ipa
```

The archive is built with `CODE_SIGNING_ALLOWED=NO`, so the IPA has no signature — that is
the normal input for sideloading tools (AltStore, Sideloadly, TrollStore), which re-sign it
with your own Apple ID or certificate.

### Adding a signed build (optional)

If you want a permanently signed IPA, add these repository secrets and a signing step:
`BUILD_CERTIFICATE_BASE64` (a `.p12`), `P12_PASSWORD`, `PROVISIONING_PROFILE_BASE64`,
`KEYCHAIN_PASSWORD` and `TEAM_ID`; then replace `CODE_SIGNING_ALLOWED=NO` with the usual
`xcodebuild -exportArchive` flow. Unsigned + sideload is simpler for personal use.

## First run

1. Launch the app — it shows **Connect your server**.
2. Enter the address printed by `node server.js`, e.g. `192.168.1.20:3130`
   (the scheme defaults to `http://`; include the port).
3. Tap **Connect**. The player loads; tapping a track starts playback, which keeps going
   with the screen locked or the app in the background.

Change the server later with the sliders button in the app's top bar (it only appears
inside the native shell) → **Server settings**, which also offers *Clear cached website
data* and *Forget server address*.

## Behaviour details

- **One origin.** The web app is loaded from your server, so API calls, audio `Range`
  requests and cover art are all same-origin — exactly as verified in the browser.
- **Offline features need HTTPS.** Service workers and the Cache Storage API require a
  secure context. Over plain `http://` the app searches, downloads and streams normally,
  but "Save offline" is disabled (the button reads *Offline needs HTTPS*) and the shell is
  not cached. Put the server behind HTTPS (Caddy, nginx, a tunnel, or Tailscale certs) to
  get offline playback inside the app. `Trust self-signed certificate` makes a self-signed
  HTTPS server usable.
- **Background audio** is the shell's job: `UIBackgroundModes: audio` in `Info.plist`
  plus a single `AVAudioSession` setup (`.playback` + `setActive(true)`) **at launch**.
  The session is never reconfigured while the page is playing — changing the category of
  a live session interrupts WebKit's audio pipeline and makes it stop the element, which
  looks like "playback pauses by itself". WebKit activates the session for HTML media on
  its own; the shell only adds the lock-screen entry: the page reports state through
  `window.__resonanceNative.onPlayback(...)` and remote buttons come back in through
  `window.__resonanceRemote.command('next' | 'previous' | 'play' | 'pause' | 'seek' …)`.
  The Diagnostics panel shows `setups:` — it must stay `1` while you play; anything
  higher means the session is being touched during playback.
- **No Web Audio in this app.** The page's spectrum visualiser would re-route the
  `<audio>` element through an `AudioContext`, which iOS suspends when the app is
  backgrounded — playback goes silent while the track keeps running. The shell injects
  `visualizer: false`, so pure media playback keeps going when the screen locks.
- **External links** (e.g. *Open on YouTube* in a track's menu) open in Safari instead of
  navigating the shell. Only the configured server host loads inside the web view.
- **Storage** uses the default `WKWebsiteDataStore`, so the service worker, offline tracks
  and playback state survive relaunches. *Clear cached website data* wipes them.
- **App Transport Security** is relaxed (`NSAllowsArbitraryLoads`) because home servers
  usually speak plain HTTP. Remove that key if you only ever use HTTPS.
- **Debug builds** are inspectable: attach Safari → Develop → your device → Resonance
  (iOS 16.4+ enables `isInspectable`).

- **No cover art on the lock screen** → the page reports an absolute artwork URL; if your
  server is HTTPS with a self-signed certificate, enable *Trust self-signed certificate*.
- **Playback stops when the screen locks** → open the app's sliders button →
  *Diagnostics*: after starting a track it should read `session active: yes` and
  `page playing: yes`, and the lock screen should show the title. Long-press the
  lock-screen entry to make sure the app is the active media app rather than another
  player. Note that starting playback *from the lock screen* right after a cold launch
  cannot work (the page has not reported a playable track yet) — start the first track in
  the app.

## Housekeeping

- Bundle identifier: `com.rnetis.resonance` (`project.yml`).
- Version: `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in `project.yml`.
- App icon: `python3 tools/make-ios-icon.py` (same artwork as the PWA icons).
- The generated `ios/Resonance.xcodeproj` is git-ignored; run `xcodegen generate` in `ios/`.
