import Combine
import Foundation

/// A track the user downloaded onto the device for offline playback.
struct OfflineEntry: Codable, Identifiable, Hashable {
    var trackPath: String
    var title: String
    var artist: String?
    var album: String?
    var duration: Double?
    var fileName: String
    var size: Int64
    var savedAt: Date

    var id: String { trackPath }
}

/// Keeps copies of tracks on the device so they play with no network at all —
/// the native equivalent of the web app's offline cache, without needing HTTPS.
final class OfflineStore: ObservableObject {
    @Published private(set) var entries: [OfflineEntry] = []
    @Published private(set) var progress: [String: Double] = [:]
    @Published var errorMessage: String?

    private let api: APIClient
    private let directory: URL
    private let indexURL: URL

    init(api: APIClient) {
        self.api = api

        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())

        directory = base.appendingPathComponent("Offline", isDirectory: true)
        indexURL = directory.appendingPathComponent("index.json")

        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        load()
    }

    // MARK: - Queries

    func isSaved(_ trackPath: String) -> Bool {
        entries.contains { $0.trackPath == trackPath }
    }

    func entry(for trackPath: String) -> OfflineEntry? {
        entries.first { $0.trackPath == trackPath }
    }

    func localURL(for trackPath: String) -> URL? {
        guard let entry = entry(for: trackPath) else { return nil }
        let url = directory.appendingPathComponent(entry.fileName)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    var totalBytes: Int64 {
        entries.reduce(0) { $0 + $1.size }
    }

    /// Prefers the device copy when there is one, so playback works offline.
    func playable(_ track: Track, client: APIClient) -> PlayableTrack {
        if let url = localURL(for: track.path) {
            return .local(track, fileURL: url, client: client)
        }

        return .streamed(track, client: client)
    }

    var playableTracks: [PlayableTrack] {
        entries.compactMap { entry in
            guard let url = localURL(for: entry.trackPath) else { return nil }
            return .saved(entry, fileURL: url, client: api)
        }
    }

    // MARK: - Mutations

    func save(_ track: Track) async {
        guard let url = api.streamURL(for: track.path) else { return }

        await MainActor.run { self.progress[track.path] = 0 }

        let tracker = DownloadProgressTracker { [weak self] fraction in
            DispatchQueue.main.async { self?.progress[track.path] = fraction }
        }

        do {
            let (temporary, _) = try await api.sharedSession.download(from: url, delegate: tracker)
            let fileName = Self.fileName(for: track.path)
            let destination = directory.appendingPathComponent(fileName)

            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: temporary, to: destination)

            let attributes = try? FileManager.default.attributesOfItem(atPath: destination.path)
            let size = (attributes?[.size] as? NSNumber)?.int64Value ?? 0

            let entry = OfflineEntry(
                trackPath: track.path,
                title: track.title,
                artist: track.artist,
                album: track.album,
                duration: track.duration,
                fileName: fileName,
                size: size,
                savedAt: Date()
            )

            await MainActor.run {
                self.entries.removeAll { $0.trackPath == track.path }
                self.entries.append(entry)
                self.entries.sort { $0.savedAt > $1.savedAt }
                self.progress[track.path] = nil
                self.persist()
            }
        } catch {
            await MainActor.run {
                self.progress[track.path] = nil
                self.errorMessage = error.localizedDescription
            }
        }
    }

    func remove(_ trackPath: String) {
        guard let entry = entry(for: trackPath) else { return }

        let url = directory.appendingPathComponent(entry.fileName)
        try? FileManager.default.removeItem(at: url)

        entries.removeAll { $0.trackPath == trackPath }
        persist()
    }

    func removeAll() {
        for entry in entries {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(entry.fileName))
        }

        entries = []
        persist()
    }

    // MARK: - Index

    private func load() {
        guard
            let data = try? Data(contentsOf: indexURL),
            let stored = try? JSONDecoder().decode([OfflineEntry].self, from: data)
        else { return }

        // Drop index rows whose file disappeared underneath us.
        entries = stored.filter { FileManager.default.fileExists(atPath: directory.appendingPathComponent($0.fileName).path) }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        try? data.write(to: indexURL)
    }

    private static func fileName(for trackPath: String) -> String {
        let flattened = trackPath.replacingOccurrences(of: "/", with: "_")
        let ext = URL(fileURLWithPath: flattened).pathExtension

        if ext.isEmpty {
            return flattened + ".mp3"
        }

        return flattened
    }
}

/// Reports download progress without retaining the store strongly.
final class DownloadProgressTracker: NSObject, URLSessionTaskDelegate {
    private let onProgress: (Double) -> Void

    init(onProgress: @escaping (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        guard totalBytesExpectedToWrite > 0 else { return }
        onProgress(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
    }
}
