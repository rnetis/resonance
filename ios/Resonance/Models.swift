import Foundation

/// A YouTube search result from `GET /api/search`.
struct SearchResult: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let url: String
    let thumbnail: String?
    let channel: String?
    let length: String?
    let views: String?
}

/// A track in the server-side library (`GET /api/tracks`).
struct Track: Codable, Identifiable, Hashable {
    let path: String
    let name: String
    let title: String
    let artist: String?
    let album: String?
    var duration: Double?
    let size: Int?
    let mtime: Double?
    let hasCover: Bool
    let url: String?
    let cover: String?

    var id: String { path }
}

struct LibraryFolder: Codable, Identifiable, Hashable {
    let name: String
    let path: String
    let type: String

    var id: String { path }
}

struct LibraryPage: Codable {
    let path: String
    let parent: String?
    let folders: [LibraryFolder]
    let tracks: [Track]
    let total: Int
}

struct JobProgress: Codable, Hashable {
    let percent: Double?
    let downloadedBytes: Double?
    let totalBytes: Double?
    let speed: Double?
    let eta: Double?
}

/// A `yt-dlp` download job (`POST /api/download`, `GET /api/jobs`).
struct Job: Codable, Identifiable, Hashable {
    let id: String
    let url: String
    let videoId: String?
    let status: String
    let phase: String?
    let progress: JobProgress?
    let title: String?
    let channel: String?
    let artist: String?
    let album: String?
    let duration: Double?
    let hasCover: Bool?
    let thumbnail: String?
    let file: String?
    let error: String?
    let createdAt: String
    let startedAt: String?
    let finishedAt: String?
    let autoPlay: Bool?

    var isActive: Bool {
        status == "queued" || status == "downloading" || status == "processing"
    }

    var isFinished: Bool {
        status == "completed" || status == "failed" || status == "canceled"
    }

    var percent: Double {
        progress?.percent ?? 0
    }
}

struct JobsPage: Codable {
    let jobs: [Job]
    let active: Int
    let queued: Int
}

struct Health: Codable {
    let ok: Bool
    let musicDir: String
    let format: String
    let ytDlp: Bool
    let ffprobe: Bool
    let activeDownloads: Int
    let queued: Int
}

struct DurationResponse: Codable {
    let path: String
    let duration: Double?
}

struct ErrorResponse: Codable {
    let error: String
}

/// `DELETE /api/jobs/:id` answers with either the updated job or `{ removed: true }`.
struct JobDeletionResult: Codable {
    let removed: Bool?
    let id: String?
    let status: String?
}

struct RemovedResponse: Codable {
    let removed: Bool?
    let path: String?
}
