import AVFoundation
import Foundation

/// Owns the app's audio session.
///
/// Rule of this class: the session is configured and activated **once**, at launch,
/// before any media exists — and then never touched again while the page is
/// playing. Re-configuring a live `AVAudioSession` (especially `setCategory`)
/// interrupts WebKit's audio pipeline and makes it stop the `<audio>` element, so
/// the player appears to pause by itself.
///
/// WebKit activates the session itself for HTML media, which is why a launch-time
/// category plus `UIBackgroundModes: audio` is all background playback needs.
final class AudioSessionController {
    static let shared = AudioSessionController()

    /// Called when an interruption ends and playback should continue.
    var onShouldResume: (() -> Void)?

    /// Called after the audio system was rebuilt underneath us.
    var onMediaServicesReset: (() -> Void)?

    private let session = AVAudioSession.sharedInstance()
    private var observing = false
    private var isPlaying = false
    private var lastPlayingAt = Date.distantPast
    private var wasPlayingBeforeInterruption = false
    private var activationSucceeded: Bool?
    private var activationError: String?

    /// Diagnostics: how many times the session was configured. Stays at 1 unless
    /// the system resets the audio services.
    private(set) var sessionSetupCount = 0

    private init() {}

    /// Called once at launch, before any media exists.
    func prepare() {
        configureSession()
        observeNotifications()
    }

    /// The page started playing. Deliberately does NOT touch the audio session —
    /// doing that mid-playback is what stops WebKit's playback.
    func beginPlayback() {
        isPlaying = true
        lastPlayingAt = Date()
    }

    /// The page paused.
    func markPaused() {
        isPlaying = false
    }

    private func configureSession() {
        do {
            // `.playback` (no mixing) allows background audio and makes the lock
            // screen show transport controls.
            try session.setCategory(.playback, mode: .default, options: [])
        } catch {
            print("AudioSession category failed: \(error.localizedDescription)")
        }

        do {
            try session.setActive(true)
            activationSucceeded = true
            activationError = nil
        } catch {
            activationSucceeded = false
            activationError = error.localizedDescription
            print("AudioSession activate failed: \(error.localizedDescription)")
        }

        sessionSetupCount += 1
    }

    /// Human-readable state, surfaced in the app's diagnostics panel.
    func snapshot() -> String {
        let claimed: String

        switch activationSucceeded {
        case .some(true): claimed = "yes"
        case .some(false): claimed = "failed (\(activationError ?? "unknown"))"
        case .none: claimed = "not activated yet"
        }

        return [
            "category: \(session.category.rawValue)",
            "session active: \(claimed)",
            "setups: \(sessionSetupCount)",
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
            // The audio system restarted from scratch: nothing of WebKit's is
            // alive right now, so re-configuring is safe.
            self?.configureSession()
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
            // WebKit pauses the element when this arrives, so the "paused" report
            // from the page can race this notification — treat a play in the last
            // few seconds as "we were playing" too.
            wasPlayingBeforeInterruption = isPlaying || Date().timeIntervalSince(lastPlayingAt) < 5
            isPlaying = false

        case .ended:
            let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
            let mayResume = options.contains(.shouldResume) || rawOptions == 0

            // The session is left alone here on purpose: WebKit re-activates it when
            // the page resumes, and touching it now would stop that playback.
            if wasPlayingBeforeInterruption && mayResume {
                onShouldResume?()
            }

            wasPlayingBeforeInterruption = false

        @unknown default:
            break
        }
    }
}
