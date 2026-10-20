import Foundation
import SwiftUI

/// The server's download queue: live progress, cancel, retry, and what to do with
/// a finished file.
struct DownloadsView: View {
    @EnvironmentObject private var server: ServerStore
    @EnvironmentObject private var player: AudioEngine
    @EnvironmentObject private var offline: OfflineStore
    @EnvironmentObject private var downloads: DownloadCenter

    var body: some View {
        NavigationStack {
            List {
                if let error = downloads.errorMessage {
                    Section { ErrorBanner(message: error) }
                }

                if downloads.jobs.isEmpty {
                    Section {
                        EmptyStateView(
                            symbol: "arrow.down.circle",
                            title: "No downloads yet",
                            message: "Search for a song and tap it — the server downloads it, and it lands in your library."
                        )
                    }
                } else {
                    if !activeJobs.isEmpty {
                        Section("In progress") {
                            ForEach(activeJobs) { job in
                                row(job)
                            }
                        }
                    }

                    if !finishedJobs.isEmpty {
                        Section("Finished") {
                            ForEach(finishedJobs) { job in
                                row(job)
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .miniPlayerInset(player.current != nil)
            .navigationTitle("Downloads")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Clear finished") {
                        Task { await downloads.clearFinished() }
                    }
                    .disabled(finishedJobs.isEmpty)
                }
            }
            .refreshable { await downloads.refresh() }
            .task { await downloads.refresh() }
        }
    }

    @ViewBuilder
    private func row(_ job: Job) -> some View {
        JobRow(
            job: job,
            onCancel: { Task { await downloads.cancel(job) } },
            onRetry: { Task { await downloads.retry(job) } },
            onForget: { Task { await downloads.forget(job) } },
            onSaveOffline: job.status == "completed" ? { saveOnDevice(job) } : nil,
            onPlay: job.status == "completed" ? { play(job) } : nil
        )
    }

    private var activeJobs: [Job] {
        downloads.jobs.filter(\.isActive)
    }

    private var finishedJobs: [Job] {
        downloads.jobs.filter { !$0.isActive }
    }

    private func play(_ job: Job) {
        guard let track = PlayableTrack.from(job: job, client: server.api) else { return }
        player.setQueue([track], startAt: 0, play: true)
    }

    private func saveOnDevice(_ job: Job) {
        guard let file = job.file else { return }

        let track = Track(
            path: file,
            name: URL(fileURLWithPath: file).lastPathComponent,
            title: job.title ?? URL(fileURLWithPath: file).deletingPathExtension().lastPathComponent,
            artist: job.artist ?? job.channel,
            album: job.album,
            duration: job.duration,
            size: nil,
            mtime: nil,
            hasCover: job.hasCover ?? false,
            url: nil,
            cover: nil
        )

        Task { await offline.save(track) }
    }
}
