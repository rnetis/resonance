import AVFoundation
import Combine
import Foundation
import MediaPlayer

/// Configures the audio session exactly once, at launch.
///
/// `AVPlayer` (unlike a `WKWebView` running Web Audio) keeps playing in the
/// background with `.playback` plus `UIBackgroundModes: audio`. The session is
/// deliberately never reconfigured afterwards: touching a live session is what makes
/// audio stop.
enum AudioSessionController {
    private static var prepared = false

    static func prepare() {
        guard !prepared else { return }
        prepared = true

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            print("Audio session setup failed: \(error.localizedDescription)")
        }
    }

    static func reactivate() {
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    /// One-line state for the diagnostics panel.
    static var stateDescription: String {
        let session = AVAudioSession.sharedInstance()
        return "category: \(session.category.rawValue) · other audio: \(session.isOtherAudioPlaying ? "yes" : "no")"
    }
}

/// Something the player can play: a server-side track (streamed, or served from a
/// local copy) or a finished download.
struct PlayableTrack: Identifiable, Codable, Hashable {
    enum Source: String, Codable {
        case library
        case offlineCopy
    }

    var id: String
    var title: String
    var artist: String?
    var album: String?
    var duration: Double?
    var trackPath: String?
    var artworkURLString: String?
    var remoteURLString: String?
    var localPath: String?
    var source: Source

    var isLocal: Bool { localPath != nil }

    var playbackURL: URL? {
        if let localPath {
            return URL(fileURLWithPath: localPath)
        }
        return remoteURLString.flatMap(URL.init(string:))
    }

    var subtitle: String {
        let bits = [artist, album].compactMap { $0 }.filter { !$0.isEmpty }
        return bits.isEmpty ? "Unknown artist" : bits.joined(separator: " · ")
    }

    // MARK: Factories

    static func streamed(_ track: Track, client: APIClient) -> PlayableTrack {
        PlayableTrack(
            id: "library:" + track.path,
            title: track.title,
            artist: track.artist,
            album: track.album,
            duration: track.duration,
            trackPath: track.path,
            artworkURLString: track.hasCover ? client.coverURL(for: track.path)?.absoluteString : nil,
            remoteURLString: client.streamURL(for: track.path)?.absoluteString,
            localPath: nil,
            source: .library
        )
    }

    static func local(_ track: Track, fileURL: URL, client: APIClient) -> PlayableTrack {
        var playable = streamed(track, client: client)
        playable.id = "offline:" + track.path
        playable.localPath = fileURL.path
        playable.source = .offlineCopy
        return playable
    }

    static func from(job: Job, client: APIClient) -> PlayableTrack? {
        guard let file = job.file, !file.isEmpty else { return nil }

        return PlayableTrack(
            id: "library:" + file,
            title: job.title ?? URL(fileURLWithPath: file).deletingPathExtension().lastPathComponent,
            artist: job.artist ?? job.channel,
            album: job.album,
            duration: job.duration,
            trackPath: file,
            artworkURLString: (job.hasCover ?? false) ? client.coverURL(for: file)?.absoluteString : job.thumbnail,
            remoteURLString: client.streamURL(for: file)?.absoluteString,
            localPath: nil,
            source: .library
        )
    }

    static func saved(_ entry: OfflineEntry, fileURL: URL, client: APIClient) -> PlayableTrack {
        PlayableTrack(
            id: "offline:" + entry.trackPath,
            title: entry.title,
            artist: entry.artist,
            album: entry.album,
            duration: entry.duration,
            trackPath: entry.trackPath,
            artworkURLString: client.coverURL(for: entry.trackPath)?.absoluteString,
            remoteURLString: nil,
            localPath: fileURL.path,
            source: .offlineCopy
        )
    }
}

/// AVPlayer-backed queue player with lock-screen integration.
final class AudioEngine: NSObject, ObservableObject {
    enum RepeatMode: String, CaseIterable {
        case off
        case all
        case one

        var symbolName: String {
            switch self {
            case .off, .all: return "repeat"
            case .one: return "repeat.1"
            }
        }
    }

    @Published private(set) var queue: [PlayableTrack] = []
    @Published private(set) var index: Int = -1
    @Published private(set) var isPlaying = false
    @Published private(set) var position: Double = 0
    @Published private(set) var duration: Double = 0
    @Published private(set) var isUsingLocalFile = false
    @Published var errorMessage: String?
    @Published var isShuffled = false {
        didSet { rebuildShuffleOrder() }
    }
    @Published var repeatMode: RepeatMode = .off
    @Published var volume: Double = 1.0 {
        didSet { player.volume = Float(max(0, min(1, volume))) }
    }

    private let api: APIClient
    private let player = AVPlayer()
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var failureObserver: NSObjectProtocol?
    private var interruptionObserver: NSObjectProtocol?
    private var routeObserver: NSObjectProtocol?
    private var artworkTask: Task<Void, Never>?
    private var shuffleOrder: [Int] = []
    private var nowPlayingArtwork: MPMediaItemArtwork?
    private var nowPlayingArtworkKey: String?
    private var wasPlayingBeforeInterruption = false

    var current: PlayableTrack? {
        queue.indices.contains(index) ? queue[index] : nil
    }

    init(api: APIClient) {
        self.api = api
        super.init()

        player.volume = Float(volume)
        player.actionAtItemEnd = .pause
        observePlayback()
        configureRemoteCommands()
        observeSystemEvents()
    }

    deinit {
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
        }

        let center = NotificationCenter.default
        for observer in [endObserver, failureObserver, interruptionObserver, routeObserver].compactMap({ $0 }) {
            center.removeObserver(observer)
        }
    }

    // MARK: - Queue

    func setQueue(_ tracks: [PlayableTrack], startAt index: Int = 0, play: Bool = true) {
        queue = tracks

        guard !tracks.isEmpty else {
            clearQueue()
            return
        }

        self.index = max(0, min(index, tracks.count - 1))
        rebuildShuffleOrder()
        load(tracks[self.index], autoplay: play)
    }

    func enqueue(_ track: PlayableTrack) {
        queue.append(track)
        rebuildShuffleOrder()

        if current == nil {
            index = 0
            load(track, autoplay: false)
        }
    }

    func playNext(_ track: PlayableTrack) {
        guard current != nil else {
            enqueue(track)
            return
        }

        queue.insert(track, at: min(index + 1, queue.count))
        rebuildShuffleOrder()
    }

    func removeFromQueue(at position: Int) {
        guard queue.indices.contains(position) else { return }

        let wasCurrent = position == index
        queue.remove(at: position)

        guard !queue.isEmpty else {
            clearQueue()
            return
        }

        if position < index {
            index -= 1
        }

        if wasCurrent {
            index = min(index, queue.count - 1)
            load(queue[index], autoplay: isPlaying)
        }

        rebuildShuffleOrder()
    }

    func clearQueue() {
        player.replaceCurrentItem(with: nil)
        queue = []
        index = -1
        isPlaying = false
        position = 0
        duration = 0
        isUsingLocalFile = false
        shuffleOrder = []
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
    }

    func jump(to position: Int, play: Bool = true) {
        guard queue.indices.contains(position) else { return }
        index = position
        load(queue[position], autoplay: play)
    }

    // MARK: - Transport

    func togglePlay() {
        isPlaying ? pause() : play()
    }

    func play() {
        guard let track = current else { return }

        if player.currentItem == nil {
            load(track, autoplay: false)
        }

        player.play()
        isPlaying = true
        refreshNowPlayingState()
    }

    func pause() {
        player.pause()
        isPlaying = false
        refreshNowPlayingState()
    }

    func next() {
        if let target = nextIndex() {
            jump(to: target)
        } else {
            pause()
            seek(to: 0)
        }
    }

    func previous() {
        if position > 3 {
            seek(to: 0)
            return
        }

        let order = playbackOrder()
        guard let at = order.firstIndex(of: index), !order.isEmpty else { return }
        let target = at <= 0 ? order[order.count - 1] : order[at - 1]
        jump(to: target)
    }

    func seek(to seconds: Double) {
        let clamped = max(0, seconds)
        player.seek(to: CMTime(seconds: clamped, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        position = clamped
        refreshNowPlayingElapsed()
    }

    func skip(by seconds: Double) {
        seek(to: position + seconds)
    }

    // MARK: - Loading

    private func load(_ track: PlayableTrack, autoplay: Bool) {
        guard let url = track.playbackURL else {
            errorMessage = "This track has no playable source."
            return
        }

        errorMessage = nil
        player.replaceCurrentItem(with: AVPlayerItem(url: url))
        position = 0
        duration = track.duration ?? 0
        isUsingLocalFile = track.isLocal
        nowPlayingArtwork = nil
        nowPlayingArtworkKey = nil

        publishNowPlaying(track)
        loadArtwork(for: track)

        if autoplay {
            play()
        } else {
            isPlaying = false
            refreshNowPlayingState()
        }
    }

    // MARK: - Order

    private func playbackOrder() -> [Int] {
        if isShuffled, !shuffleOrder.isEmpty {
            return shuffleOrder
        }
        return Array(queue.indices)
    }

    private func nextIndex() -> Int? {
        let order = playbackOrder()
        guard !order.isEmpty else { return nil }

        guard let at = order.firstIndex(of: index) else { return order.first }
        if at + 1 < order.count { return order[at + 1] }
        return repeatMode == .all ? order.first : nil
    }

    private func rebuildShuffleOrder() {
        var indices = queue.indices.filter { $0 != index }

        if indices.count > 1 {
            for position in stride(from: indices.count - 1, to: 0, by: -1) {
                let swap = Int.random(in: 0...position)
                indices.swapAt(position, swap)
            }
        }

        shuffleOrder = index >= 0 ? [index] + indices : indices
    }

    // MARK: - Observation

    private func observePlayback() {
        let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            guard let self else { return }

            let seconds = time.seconds
            if seconds.isFinite {
                self.position = seconds
            }

            if let itemDuration = self.player.currentItem?.duration.seconds, itemDuration.isFinite, itemDuration > 0.5 {
                self.duration = itemDuration
            }

            let playing = self.player.timeControlStatus == .playing
            if playing != self.isPlaying {
                self.isPlaying = playing
                self.refreshNowPlayingState()
            }
        }

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self, let item = note.object as? AVPlayerItem, item == self.player.currentItem else { return }
            self.handleTrackFinished()
        }

        failureObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self, let item = note.object as? AVPlayerItem, item == self.player.currentItem else { return }
            let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            self.errorMessage = error?.localizedDescription ?? "Playback stopped unexpectedly."
        }
    }

    private func observeSystemEvents() {
        let center = NotificationCenter.default

        interruptionObserver = center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            guard
                let self,
                let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                let type = AVAudioSession.InterruptionType(rawValue: raw)
            else { return }

            switch type {
            case .began:
                self.wasPlayingBeforeInterruption = self.isPlaying
                self.pause()
            case .ended:
                let rawOptions = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
                if self.wasPlayingBeforeInterruption, options.contains(.shouldResume) {
                    AudioSessionController.reactivate()
                    self.play()
                }
                self.wasPlayingBeforeInterruption = false
            @unknown default:
                break
            }
        }

        routeObserver = center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            guard
                let self,
                let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
            else { return }

            // Headphones pulled out: pause instead of blasting the speaker.
            if reason == .oldDeviceUnavailable {
                self.pause()
            }
        }
    }

    private func handleTrackFinished() {
        if repeatMode == .one {
            seek(to: 0)
            play()
            return
        }

        if let target = nextIndex() {
            jump(to: target)
        } else {
            pause()
            seek(to: 0)
        }
    }

    // MARK: - Now playing / remote commands

    private func publishNowPlaying(_ track: PlayableTrack) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0
        ]

        if let artist = track.artist, !artist.isEmpty {
            info[MPMediaItemPropertyArtist] = artist
        }

        if let album = track.album, !album.isEmpty {
            info[MPMediaItemPropertyAlbumTitle] = album
        }

        if let duration = track.duration, duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        refreshNowPlayingState()
    }

    private func refreshNowPlayingState() {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
    }

    private func refreshNowPlayingElapsed() {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func loadArtwork(for track: PlayableTrack) {
        artworkTask?.cancel()

        guard let string = track.artworkURLString, let url = URL(string: string) else { return }

        let session = api.sharedSession

        artworkTask = Task { [weak self] in
            guard let data = await RemoteImage.data(at: url, session: session) else { return }
            if Task.isCancelled { return }

            await MainActor.run {
                guard let self, self.current?.artworkURLString == string, let image = UIImage(data: data) else { return }
                let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self.nowPlayingArtwork = artwork
                self.nowPlayingArtworkKey = string

                var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                info[MPMediaItemPropertyArtwork] = artwork
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
        }
    }

    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        for command in [
            center.playCommand,
            center.pauseCommand,
            center.togglePlayPauseCommand,
            center.nextTrackCommand,
            center.previousTrackCommand,
            center.stopCommand,
            center.skipForwardCommand,
            center.skipBackwardCommand,
            center.changePlaybackPositionCommand
        ] {
            command.removeTarget(nil)
            command.isEnabled = true
        }

        center.skipForwardCommand.preferredIntervals = [15]
        center.skipBackwardCommand.preferredIntervals = [15]

        center.playCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.play()
            return .success
        }

        center.pauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.pause()
            return .success
        }

        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.togglePlay()
            return .success
        }

        center.nextTrackCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.next()
            return .success
        }

        center.previousTrackCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.previous()
            return .success
        }

        center.stopCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.pause()
            self.seek(to: 0)
            return .success
        }

        center.skipForwardCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.skip(by: 15)
            return .success
        }

        center.skipBackwardCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.skip(by: -15)
            return .success
        }

        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self, let positionEvent = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self.seek(to: positionEvent.positionTime)
            return .success
        }
    }

    // MARK: - Diagnostics

    var diagnostics: String {
        let item = player.currentItem
        let source: String

        if let track = current {
            source = track.isLocal ? "local file" : "stream"
        } else {
            source = "nothing loaded"
        }

        return [
            "items: \(queue.count)",
            "index: \(index)",
            "status: \(player.timeControlStatus == .playing ? "playing" : player.timeControlStatus == .paused ? "paused" : "waiting")",
            "item: \(item == nil ? "none" : "ready")",
            "source: \(source)"
        ].joined(separator: " · ")
    }
}
