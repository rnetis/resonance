import Combine
import Foundation

/// A playlist entry is stored by server path plus metadata, so playlists keep
/// working after the server address changes.
struct PlaylistEntry: Codable, Identifiable, Hashable {
    var trackPath: String
    var title: String
    var artist: String?
    var album: String?
    var duration: Double?
    var hasCover: Bool

    var id: String { trackPath }

    init(track: Track) {
        trackPath = track.path
        title = track.title
        artist = track.artist
        album = track.album
        duration = track.duration
        hasCover = track.hasCover
    }

    init(playable: PlayableTrack) {
        trackPath = playable.trackPath ?? playable.id
        title = playable.title
        artist = playable.artist
        album = playable.album
        duration = playable.duration
        hasCover = playable.artworkURLString != nil
    }
}

struct Playlist: Codable, Identifiable, Hashable {
    var id: UUID
    var name: String
    var entries: [PlaylistEntry]
    var createdAt: Date

    init(id: UUID = UUID(), name: String, entries: [PlaylistEntry] = [], createdAt: Date = Date()) {
        self.id = id
        self.name = name
        self.entries = entries
        self.createdAt = createdAt
    }
}

/// Local playlists (the server has no playlist API — the web app keeps them in the
/// browser, so the app keeps them on the device).
final class PlaylistStore: ObservableObject {
    @Published private(set) var playlists: [Playlist] = []

    private let fileURL: URL

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())

        fileURL = base.appendingPathComponent("playlists.json")
        load()
    }

    @discardableResult
    func create(named name: String) -> Playlist {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let playlist = Playlist(name: trimmed.isEmpty ? "New playlist" : trimmed)
        playlists.insert(playlist, at: 0)
        persist()
        return playlist
    }

    func rename(_ playlist: Playlist, to name: String) {
        guard let index = playlists.firstIndex(where: { $0.id == playlist.id }) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        playlists[index].name = trimmed
        persist()
    }

    func delete(_ playlist: Playlist) {
        playlists.removeAll { $0.id == playlist.id }
        persist()
    }

    /// Returns false when the track was already there.
    @discardableResult
    func add(_ entry: PlaylistEntry, to playlistID: UUID) -> Bool {
        guard let index = playlists.firstIndex(where: { $0.id == playlistID }) else { return false }

        if playlists[index].entries.contains(where: { $0.trackPath == entry.trackPath }) {
            return false
        }

        playlists[index].entries.append(entry)
        persist()
        return true
    }

    func remove(_ entry: PlaylistEntry, from playlistID: UUID) {
        guard let index = playlists.firstIndex(where: { $0.id == playlistID }) else { return }
        playlists[index].entries.removeAll { $0.trackPath == entry.trackPath }
        persist()
    }

    func playlist(_ id: UUID) -> Playlist? {
        playlists.first { $0.id == id }
    }

    /// Turns stored entries back into playable tracks, preferring device copies.
    func playableTracks(in playlist: Playlist, offline: OfflineStore, client: APIClient) -> [PlayableTrack] {
        playlist.entries.map { entry in
            let track = Track(
                path: entry.trackPath,
                name: URL(fileURLWithPath: entry.trackPath).lastPathComponent,
                title: entry.title,
                artist: entry.artist,
                album: entry.album,
                duration: entry.duration,
                size: nil,
                mtime: nil,
                hasCover: entry.hasCover,
                url: nil,
                cover: nil,
                hls: nil,
                scope: "library",
                user: nil
            )

            return offline.playable(track, client: client)
        }
    }

    // MARK: - Storage

    private func load() {
        guard
            let data = try? Data(contentsOf: fileURL),
            let stored = try? JSONDecoder().decode([Playlist].self, from: data)
        else { return }

        playlists = stored
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(playlists) else { return }
        try? data.write(to: fileURL)
    }
}
