import AVFoundation
import Foundation

/// Keeps the audio session in playback mode so the web player keeps playing when
/// the app is backgrounded or the screen is locked. Pair with UIBackgroundModes
/// `audio` in Info.plist.
final class AudioSessionController {
    static let shared = AudioSessionController()

    private var observing = false

    private init() {}

    func activate() {
        let session = AVAudioSession.sharedInstance()

        do {
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
        } catch {
            // Non-fatal: playback still works while the app is in the foreground.
            print("AudioSession setup failed: \(error.localizedDescription)")
        }

        observeInterruptions(session)
    }

    private func observeInterruptions(_ session: AVAudioSession) {
        guard !observing else { return }
        observing = true

        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { notification in
            guard
                let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                let type = AVAudioSession.InterruptionType(rawValue: raw)
            else { return }

            switch type {
            case .began:
                break
            case .ended:
                // The system dropped the session (call, Siri…): take it back so the
                // web player can resume from the lock screen.
                try? session.setActive(true)
            @unknown default:
                break
            }
        }
    }
}
