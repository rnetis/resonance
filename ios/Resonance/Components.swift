import SwiftUI

extension Color {
    static let resonanceAccent = Color(red: 0.56, green: 0.42, blue: 1.0)
    static let resonancePink = Color(red: 1.0, green: 0.31, blue: 0.56)
    static let resonanceSurface = Color(red: 0.11, green: 0.11, blue: 0.15)
}

/// Now-playing bar that floats above the tab bar.
struct MiniPlayerBar: View {
    @EnvironmentObject private var player: AudioEngine

    let open: () -> Void

    var body: some View {
        if let track = player.current {
            HStack(spacing: 12) {
                ArtworkView(urlString: track.artworkURLString, size: 40, cornerRadius: 9)

                VStack(alignment: .leading, spacing: 1) {
                    Text(track.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text(track.isLocal ? "Offline copy · " + track.subtitle : track.subtitle)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 4)

                Button {
                    player.togglePlay()
                } label: {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 20, weight: .semibold))
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)

                Button {
                    player.next()
                } label: {
                    Image(systemName: "forward.fill")
                        .font(.system(size: 17))
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.35), radius: 12, y: 4)
            .contentShape(Rectangle())
            .onTapGesture(perform: open)
        }
    }
}

/// One track in a list: artwork, title/artist, duration.
struct TrackRow: View {
    let track: Track
    let artworkURL: String?
    let isCurrent: Bool
    let isSaved: Bool

    var body: some View {
        HStack(spacing: 12) {
            ArtworkView(urlString: artworkURL, size: 46, cornerRadius: 9)

            VStack(alignment: .leading, spacing: 2) {
                Text(track.title)
                    .font(.subheadline.weight(isCurrent ? .bold : .semibold))
                    .foregroundColor(isCurrent ? .resonanceAccent : .primary)
                    .lineLimit(1)

                HStack(spacing: 5) {
                    if isSaved {
                        Image(systemName: "arrow.down.circle.fill")
                            .font(.caption2)
                            .foregroundColor(.green)
                    }
                    Text([track.artist, track.album].compactMap { $0 }.first ?? "Unknown artist")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 6)

            Text(Format.time(track.duration))
                .font(.caption)
                .foregroundColor(.secondary)
                .monospacedDigit()
        }
        .contentShape(Rectangle())
    }
}

struct FolderRow: View {
    let folder: LibraryFolder

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "folder.fill")
                .font(.system(size: 20))
                .foregroundColor(.resonanceAccent)
                .frame(width: 46, height: 46)
                .background(Color.resonanceSurface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))

            Text(folder.name)
                .font(.subheadline.weight(.medium))
                .lineLimit(2)

            Spacer()
        }
    }
}

/// A YouTube search hit, with the state of any download for it.
struct SearchResultRow: View {
    let result: SearchResult
    let job: Job?
    let onDownload: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            ArtworkView(urlString: result.thumbnail, size: 52, cornerRadius: 9)

            VStack(alignment: .leading, spacing: 3) {
                Text(result.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)

                Text([result.channel, result.length].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)

                if let job, job.isActive {
                    ProgressView(value: job.percent, total: 100)
                        .progressViewStyle(.linear)
                        .tint(.resonanceAccent)
                    Text(Format.jobStatus(job))
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                } else if job?.status == "completed" {
                    Label("Downloaded", systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundColor(.green)
                } else if job?.status == "failed" {
                    Label("Failed", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundColor(.orange)
                }
            }

            Spacer(minLength: 4)

            if job?.isActive != true {
                Button(action: onDownload) {
                    Image(systemName: job?.status == "completed" ? "arrow.down.circle" : "arrow.down.circle")
                        .font(.system(size: 20))
                        .foregroundColor(.resonanceAccent)
                }
                .buttonStyle(.plain)
            }
        }
        .contentShape(Rectangle())
    }
}

/// `Button(_:systemImage:)` is iOS 17+, so menus go through this helper.
@ViewBuilder
func menuButton(
    _ title: String,
    symbol: String,
    role: ButtonRole? = nil,
    action: @escaping () -> Void
) -> some View {
    if let role {
        Button(role: role, action: action) {
            Label(title, systemImage: symbol)
        }
    } else {
        Button(action: action) {
            Label(title, systemImage: symbol)
        }
    }
}

struct JobRow: View {
    let job: Job
    let onCancel: () -> Void
    let onRetry: () -> Void
    let onForget: () -> Void
    let onSaveOffline: (() -> Void)?
    let onPlay: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                ArtworkView(urlString: job.thumbnail, size: 46, cornerRadius: 9)

                VStack(alignment: .leading, spacing: 2) {
                    Text(job.title ?? job.file.map { URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent } ?? "YouTube audio")
                        .font(.subheadline.weight(.medium))
                        .lineLimit(2)

                    Text(Format.jobStatus(job))
                        .font(.caption)
                        .foregroundColor(job.status == "failed" ? .orange : .secondary)
                        .lineLimit(3)
                }

                Spacer(minLength: 4)

                if job.isActive {
                    Button(action: onCancel) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 20))
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                } else {
                    Menu {
                        if job.status == "completed" {
                            if let onPlay {
                                menuButton("Play now", symbol: "play.fill", action: onPlay)
                            }
                            if let onSaveOffline {
                                menuButton("Save on device", symbol: "arrow.down.to.line", action: onSaveOffline)
                            }
                        }
                        if job.status == "failed" {
                            menuButton("Retry", symbol: "arrow.clockwise", action: onRetry)
                        }
                        menuButton("Remove from list", symbol: "trash", role: .destructive, action: onForget)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.system(size: 20))
                            .foregroundColor(.secondary)
                    }
                }
            }

            if job.isActive {
                ProgressView(value: job.percent, total: 100)
                    .progressViewStyle(.linear)
                    .tint(.resonanceAccent)
            }
        }
        .padding(.vertical, 2)
    }
}

struct ErrorBanner: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.orange)
            Text(message)
                .font(.footnote)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 4)
    }
}

struct EmptyStateView: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 34))
                .foregroundColor(.secondary)
            Text(title)
                .font(.headline)
            Text(message)
                .font(.footnote)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
    }
}

/// Keeps list content clear of the floating mini player.
struct MiniPlayerInset: ViewModifier {
    let visible: Bool

    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .bottom) {
            Color.clear.frame(height: visible ? 66 : 0)
        }
    }
}

extension View {
    func miniPlayerInset(_ visible: Bool) -> some View {
        modifier(MiniPlayerInset(visible: visible))
    }
}
