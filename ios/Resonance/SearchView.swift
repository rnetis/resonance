import Foundation
import SwiftUI

/// Search YouTube through the server, then pull tracks into the library.
struct SearchView: View {
    @EnvironmentObject private var server: ServerStore
    @EnvironmentObject private var player: AudioEngine
    @EnvironmentObject private var offline: OfflineStore
    @EnvironmentObject private var downloads: DownloadCenter

    @State private var query = ""
    @State private var results: [SearchResult] = []
    @State private var isSearching = false
    @State private var errorMessage: String?

    private let suggestions = ["lofi hip hop", "coldplay", "jazz cafe", "synthwave", "persian"]

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }

                if results.isEmpty && !isSearching {
                    Section {
                        EmptyStateView(
                            symbol: "magnifyingglass",
                            title: "Search YouTube",
                            message: "Type a song, artist or album — tap a result to download it into your library."
                        )
                    }

                    Section("Try") {
                        ForEach(suggestions, id: \.self) { suggestion in
                            Button {
                                query = suggestion
                                Task { await runSearch() }
                            } label: {
                                Label(suggestion, systemImage: "sparkles")
                            }
                        }
                    }
                } else {
                    Section {
                        ForEach(results) { result in
                            SearchResultRow(
                                result: result,
                                job: downloads.job(forVideoId: result.id),
                                onDownload: { download(result, playWhenReady: true) }
                            )
                            .contextMenu {
                                menuButton("Download & play", symbol: "play.fill") {
                                    download(result, playWhenReady: true)
                                }
                                menuButton("Download only", symbol: "arrow.down.circle") {
                                    download(result, playWhenReady: false)
                                }
                                menuButton("Download, then queue", symbol: "text.badge.plus") {
                                    download(result, playWhenReady: false, queueWhenReady: true)
                                }
                                Divider()
                                if let url = URL(string: result.url) {
                                    Link("Open on YouTube", destination: url)
                                }
                            }
                        }
                    } header: {
                        if !results.isEmpty {
                            Text("\(results.count) results")
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .miniPlayerInset(player.current != nil)
            .navigationTitle("Search")
            .searchable(text: $query, prompt: "Song, artist or album")
            .onSubmit(of: .search) {
                Task { await runSearch() }
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    if isSearching {
                        ProgressView()
                    } else {
                        Button {
                            Task { await runSearch() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .disabled(query.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .refreshable { await runSearch() }
        }
    }

    private func runSearch() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        await MainActor.run {
            isSearching = true
            errorMessage = nil
        }

        do {
            let found = try await server.api.search(trimmed)
            await MainActor.run {
                results = found
                isSearching = false
            }
        } catch {
            await MainActor.run {
                results = []
                isSearching = false
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Taps land here: the server downloads with yt-dlp, the app plays it when it lands.
    private func download(_ result: SearchResult, playWhenReady: Bool, queueWhenReady: Bool = false) {
        Task {
            guard let job = await downloads.start(videoURL: result.url, autoPlay: playWhenReady) else { return }
            guard playWhenReady || queueWhenReady else { return }

            // Wait for this job to finish, then hand the file to the player.
            var attempts = 0
            while !Task.isCancelled && attempts < 600 {
                attempts += 1
                try? await Task.sleep(nanoseconds: 1_500_000_000)

                let page = try? await server.api.jobs()
                guard let current = page?.jobs.first(where: { $0.id == job.id }) else {
                    // Job fell out of the server's history — stop waiting.
                    if attempts > 4 { return }
                    continue
                }

                if current.status == "completed" {
                    if let playable = PlayableTrack.from(job: current, client: server.api) {
                        await MainActor.run {
                            if queueWhenReady, player.current != nil {
                                player.enqueue(playable)
                            } else {
                                player.setQueue([playable], startAt: 0, play: true)
                            }
                        }
                    }
                    return
                }

                if current.status == "failed" || current.status == "canceled" {
                    return
                }
            }
        }
    }
}
