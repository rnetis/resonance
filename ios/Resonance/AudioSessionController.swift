import AVFoundation
import Foundation

/// Owns the app's audio session.
///
/// The session is activated when the web player *actually starts playing* rather
/// than once at launch. That activation is what tells iOS this app is an audio
/// app, which is what keeps a WKWebView's media pipeline running (and audible)
/// after the screen locks or the app is backgrounded.
final class AudioSessionController {
    static let shared = AudioSessionController()

    /// Called when an interruption ends and playback should continue.
    var onShouldResume: (() -> Void)?

    /// Called after the audio system was rebuilt underneath us.
    var onMediaServicesReset: (() -> Void)?

    private let session = AVAudioSession.sharedInstance()
    private var observing = false
    private var isPlaying = false
    private var wasPlayingBeforeInterruption = false

    private init() {}

    /// One-time setup: category + system notifications. Does not activate yet.
    func prepare() {
        configureCategory()
        observeNotifications()
    }

    /// The page started playing — claim the session so iOS grants background audio.
    func beginPlayback() {
        isPlaying = true
        activate()
    }

    /// The page paused. The session stays active so the lock-screen play button can
    /// still reach the app while it is in the background.
    func markPaused() {
        isPlaying = false
    }

    private func activate() {
        configureCategory()

        do {
            try session.setActive(true)
        } catch {
            print("AudioSession activate failed: \(error.localizedDescription)")
        }
    }

    private func configureCategory() {
        do {
            // `.playback` without mixing is what allows background audio and makes
            // the lock screen show transport controls.
            try session.setCategory(.playback, mode: .default)
        } catch {
            print("AudioSession category failed: \(error.localizedDescription)")
        }
    }

    /// Human-readable state, surfaced in the app's diagnostics panel.
    func snapshot() -> String {
        [
            "category: \(session.category.rawValue)",
            "active: \(session.isActive ? "yes" : "no")",
            "other audio: \(session.isOtherAudioPlaying ? "yes" : "no")",
            "page playing: \(isPlaying ? "yes" : "no")"
        ].joined(separator: " · ")
    }

    private func observeNotifications() {
        guard !observing else { return }
        observing = true

        let center = NotificationCenter.default

        center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { [weak self] notification in
            self?.handleInterruption(notification)
        }

        center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: session,
            queue: .main
        ) { [weak self] _ in
            // The audio system restarted: rebuild the category and re-assert state.
            self?.configureCategory()
            if self?.isPlaying == true {
                self?.activate()
            }
            self?.onMediaServicesReset?()
        }
    }

    private func handleInterruption(_ notification: Notification) {
        guard
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }

        switch type {
        case .began:
            wasPlayingBeforeInterruption = isPlaying
            isPlaying = false

        case .ended:
            let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
            let mayResume = options.contains(.shouldResume) || rawOptions == 0

            if wasPlayingBeforeInterruption && mayResume {
                // WebKit paused the element when the interruption began, so the
                // shell asks the page to carry on where it left off.
                activate()
                onShouldResume?()
            }

            wasPlayingBeforeInterruption = false

        @unknown default:
            break
        }
    }
}
