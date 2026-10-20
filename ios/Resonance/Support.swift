import Foundation
import SwiftUI
import UIKit

/// Fetches artwork with the app's TLS policy and keeps a small in-memory cache.
enum RemoteImage {
    private static let cache = NSCache<NSURL, NSData>()

    static func cachedData(for url: URL) -> Data? {
        cache.object(forKey: url as NSURL) as Data?
    }

    /// Returns raw bytes so nothing non-`Sendable` crosses a concurrency boundary.
    static func data(at url: URL, session: URLSession) async -> Data? {
        if let hit = cachedData(for: url) {
            return hit
        }

        do {
            let (data, response) = try await session.data(from: url)

            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                return nil
            }

            cache.setObject(data as NSData, forKey: url as NSURL)
            return data
        } catch {
            return nil
        }
    }
}

/// Cover art with a generated placeholder, sized by the caller.
struct ArtworkView: View {
    @EnvironmentObject private var server: ServerStore

    let urlString: String?
    var size: CGFloat
    var cornerRadius: CGFloat = 8

    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                placeholder
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .task(id: urlString) {
            await load()
        }
    }

    private var placeholder: some View {
        LinearGradient(
            colors: [Color(red: 0.17, green: 0.16, blue: 0.26), Color(red: 0.08, green: 0.08, blue: 0.13)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .overlay(
            Image(systemName: "music.note")
                .font(.system(size: size * 0.36, weight: .medium))
                .foregroundColor(.white.opacity(0.35))
        )
    }

    private func load() async {
        guard let urlString, let url = URL(string: urlString) else {
            image = nil
            return
        }

        if let data = RemoteImage.cachedData(for: url) {
            image = UIImage(data: data)
            return
        }

        let session = server.api.sharedSession
        guard let data = await RemoteImage.data(at: url, session: session) else { return }
        image = UIImage(data: data)
    }
}

// MARK: - Formatting

enum Format {
    static func time(_ seconds: Double?) -> String {
        guard let seconds, seconds.isFinite, seconds >= 0 else { return "--:--" }

        let total = Int(seconds.rounded())
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60

        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, secs)
            : String(format: "%d:%02d", minutes, secs)
    }

    static func bytes(_ value: Double?) -> String {
        guard let value, value > 0 else { return "0 MB" }

        let units = ["B", "KB", "MB", "GB"]
        var size = value
        var unit = 0

        while size >= 1024, unit < units.count - 1 {
            size /= 1024
            unit += 1
        }

        return unit == 0
            ? String(format: "%.0f %@", size, units[unit])
            : String(format: "%.1f %@", size, units[unit])
    }

    static func speed(_ bytesPerSecond: Double?) -> String? {
        guard let bytesPerSecond, bytesPerSecond > 0 else { return nil }
        return bytes(bytesPerSecond) + "/s"
    }

    /// "Downloading 42% · 1.2 MB/s · ETA 0:12" style summary of a job.
    static func jobStatus(_ job: Job) -> String {
        switch job.status {
        case "queued":
            return "Waiting in queue"
        case "downloading":
            if job.percent >= 99.9 {
                return job.phase ?? "Converting audio"
            }
            var parts = [String(format: "Downloading %.0f%%", job.percent)]
            if let speed = speed(job.progress?.speed) { parts.append(speed) }
            if let eta = job.progress?.eta, eta > 0 { parts.append("ETA " + time(eta)) }
            return parts.joined(separator: " · ")
        case "processing":
            return job.phase ?? "Converting audio"
        case "completed":
            return job.file.map { "Saved · " + URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent } ?? "Saved"
        case "failed":
            return job.error ?? "Download failed"
        case "canceled":
            return "Canceled"
        default:
            return job.phase ?? job.status
        }
    }

    static func relative(_ isoString: String?) -> String {
        guard let isoString else { return "" }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        var date = formatter.date(from: isoString)
        if date == nil {
            formatter.formatOptions = [.withInternetDateTime]
            date = formatter.date(from: isoString)
        }

        guard let date else { return "" }

        let seconds = Date().timeIntervalSince(date)
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60)) min ago" }
        if seconds < 86400 { return "\(Int(seconds / 3600)) h ago" }

        let dayFormatter = DateFormatter()
        dayFormatter.dateStyle = .medium
        return dayFormatter.string(from: date)
    }
}
