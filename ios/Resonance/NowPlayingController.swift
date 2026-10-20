import Foundation
import MediaPlayer
import UIKit

/// What the web player reports about itself.
struct PlaybackReport {
    let isPlaying: Bool
    let isTrackChange: Bool
    let title: String
    let artist: String
    let album: String
    let artworkURL: String
    let duration: Double
    let position: Double

    init?(body: [String: Any]) {
        guard let state = body["state"] as? String else { return nil }

        isPlaying = state == "playing"
        isTrackChange = state == "track"
        title = body["title"] as? String ?? ""
        artist = body["artist"] as? String ?? ""
        album = body["album"] as? String ?? ""
        artworkURL = body["artwork"] as? String ?? ""
        duration = PlaybackReport.number(body["duration"])
        position = PlaybackReport.number(body["position"])
    }

    private static func number(_ value: Any?) -> Double {
        if let number = value as? NSNumber { return number.doubleValue }
        if let double = value as? Double { return double }
        if let int = value as? Int { return Double(int) }
        return 0
    }
}

/// Publishes playback to the lock screen / Control Center / CarPlay and routes
/// the remote control buttons back into the web player.
///
/// Registering remote commands plus a now-playing entry is what makes iOS treat
/// this app as the active media app, which is what keeps a WKWebView playing once
/// the screen is locked.
final class NowPlayingController: NSObject, URLSessionDataDelegate {
    static let shared = NowPlayingController()

    /// Set by the web view coordinator: (command name, optional value) -> Void
    var sendCommand: ((String, Double?) -> Void)?

    var trustSelfSigned = false

    private var artwork: MPMediaItemArtwork?
    private var artworkURL = ""
    private var artworkTask: URLSessionDataTask?
    private var trustedHost: String?
    private var configured = false

    private lazy var artworkSession: URLSession = {
        URLSession(configuration: .default, delegate: self, delegateQueue: .main)
    }()

    private override init() {
        super.init()
    }

    // MARK: - Remote commands

    func configureRemoteCommands(trustedHost host: String? = nil) {
        if let host { trustedHost = host }

        let center = MPRemoteCommandCenter.shared()

        // Re-registering stacks handlers, so clear whatever is there first.
        for command in [
            center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
            center.nextTrackCommand, center.previousTrackCommand,
            center.skipForwardCommand, center.skipBackwardCommand,
            center.changePlaybackPositionCommand, center.stopCommand
        ] {
            command.removeTarget(nil)
            command.isEnabled = true
        }

        center.playCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.send("play")
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.send("pause")
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.send("toggle")
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.send("next")
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.send("previous")
            return .success
        }
        center.stopCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.send("pause")
            return .success
        }

        center.skipForwardCommand.preferredIntervals = [15]
        center.skipBackwardCommand.preferredIntervals = [15]
        center.skipForwardCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.send("seekBy", value: 15)
            return .success
        }
        center.skipBackwardCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.send("seekBy", value: -15)
            return .success
        }

        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard
                let self,
                let positionEvent = event as? MPChangePlaybackPositionCommandEvent
            else { return .commandFailed }

            self.send("seek", value: positionEvent.positionTime)
            return .success
        }

        configured = true
    }

    private func send(_ name: String, value: Double? = nil) {
        sendCommand?(name, value)
    }

    // MARK: - Now playing info

    /// Last state the page reported, for the diagnostics panel.
    private(set) var lastReportSummary = "no report yet"

    var isCommandChannelOpen: Bool { sendCommand != nil }

    func update(with report: PlaybackReport) {
        if !configured { configureRemoteCommands() }

        lastReportSummary = String(
            format: "%@ · %@ · %.0fs / %.0fs · %@",
            report.isPlaying ? "playing" : (report.isTrackChange ? "track change" : "paused"),
            report.title.isEmpty ? "(no title)" : report.title,
            report.position,
            report.duration,
            report.artworkURL.isEmpty ? "no artwork" : "artwork"
        )

        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPMediaItemPropertyTitle] = report.title.isEmpty ? "Resonance" : report.title
        info[MPMediaItemPropertyArtist] = report.artist
        info[MPMediaItemPropertyAlbumTitle] = report.album
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = report.position
        info[MPNowPlayingInfoPropertyPlaybackRate] = report.isPlaying ? 1.0 : 0.0
        info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue

        if report.duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = report.duration
        }

        if let artwork, artworkURL == report.artworkURL {
            info[MPMediaItemPropertyArtwork] = artwork
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        if !report.isTrackChange {
            MPNowPlayingInfoCenter.default().playbackState = report.isPlaying ? .playing : .paused
        }

        if report.artworkURL != artworkURL {
            loadArtwork(from: report.artworkURL)
        }
    }

    // MARK: - Artwork

    private func loadArtwork(from urlString: String) {
        artworkTask?.cancel()
        artworkTask = nil
        artworkURL = urlString
        artwork = nil

        guard let url = URL(string: urlString), !urlString.isEmpty else { return }
        if trustedHost == nil { trustedHost = url.host }

        let task = artworkSession.dataTask(with: url) { [weak self] data, _, error in
            guard
                let self,
                error == nil,
                let data,
                let image = UIImage(data: data)
            else { return }

            let item = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            self.artwork = item

            var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
            info[MPMediaItemPropertyArtwork] = item
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        }

        artworkTask = task
        task.resume()
    }

    // MARK: - URLSessionDataDelegate (self-signed artwork)

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard
            trustSelfSigned,
            challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
            let serverTrust = challenge.protectionSpace.serverTrust,
            trustedHost == nil || challenge.protectionSpace.host == trustedHost
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        completionHandler(.useCredential, URLCredential(trust: serverTrust))
    }
}
