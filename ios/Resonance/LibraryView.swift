import Foundation
import SwiftUI

/// Browses the server-side library: folders, recursive "all songs", filter, and
/// per-track actions (queue, playlists, save on device, delete).
struct LibraryView: View {
    @EnvironmentObject private var server: ServerStore
    @EnvironmentObject private var player: AudioEngine
    @EnvironmentObject private var offline: OfflineStore
    @EnvironmentObject private var playlists: PlaylistStore

    @State private var path = ""
    @State private var page: LibraryPage?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var filter = ""
    @State private var recursive = false
    @State private var durations: [String: Double] = [:]
    @State private var trackToDelete: Track?
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }

                if isLoading && page == nil {
                    HStack {
                        Spacer()
                        ProgressView("Loading library…")
                        Spacer()
                    }
                }

                if let page {
                    if !page.folders.isEmpty && !recursive {
                        Section("Folders") {
                            ForEach(page.folders) { folder in
                                NavigationLink(value: folder.path) {
                                    FolderRow(folder: folder)
                                }
                            }
                        }
                    }

                    Section {
                        if visibleTracks.isEmpty {
                            EmptyStateView(
                                symbol: filter.isEmpty ? "music.note.list" : "line.3.horizontal.decrease.circle",
                                title: filter.isEmpty ? "No music here yet" : "No matches",
                                message: filter.isEmpty
                                    ? "Search for a song and tap it to download it into this folder."
                                    : "Try a different filter."
                            )
                        } else {
                            ForEach(visibleTracks) { track in
                                let shown = resolved(track)
                                Button {
                                    play(shown)
                                } label: {
                                    TrackRow(
                                        track: shown,
                                        artworkURL: server.api.coverURL(for: shown.path)?.absoluteString,
                                        isCurrent: player.current?.trackPath == shown.path,
                                        isSaved: offline.isSaved(shown.path)
                                    )
                                }
                                .buttonStyle(.plain)
                                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                    Button {
                                        play(track)
                                    } label: {
                                        Label("Play", systemImage: "play.fill")
                                    }
                                    .tint(.resonanceAccent)
                                }
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) {
                                        trackToDelete = track
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                                .contextMenu { menu(for: track) }
                            }
                        }
                    } header: {
                        Text(recursive ? "All songs (\(visibleTracks.count))" : "Songs (\(visibleTracks.count))")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .miniPlayerInset(player.current != nil)
            .navigationTitle(path.isEmpty ? "Library" : URL(fileURLWithPath: path).lastPathComponent)
            .navigationDestination(for: String.self) { destination in
                LibraryView(path: destination)
            }
            .searchable(text: $filter, prompt: "Filter tracks")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        recursive.toggle()
                        Task { await load() }
                    } label: {
                        Label(recursive ? "All songs" : "This folder", systemImage: recursive ? "square.stack.3d.up.fill" : "square.stack.3d.up")
                    }
                }

                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Button("Play all", systemImage: "play.fill") {
                            playAll(shuffled: false)
                        }
                        Button("Shuffle all", systemImage: "shuffle") {
                            playAll(shuffled: true)
                        }
                        .disabled(visibleTracks.isEmpty)
                        Divider()
                        Button("Server settings", systemImage: "slider.horizontal.3") {
                            showSettings = true
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .refreshable { await load() }
            .task { await load() }
            .sheet(isPresented: $showSettings) {
                ServerSettingsView(mode: .settings)
            }
            .confirmationDialog(
                "Delete “\(trackToDelete?.title ?? "")”?",
                isPresented: Binding(get: { trackToDelete != nil }, set: { if !$0 { trackToDelete = nil } }),
                titleVisibility: .visible
            ) {
                Button("Delete from library", role: .destructive) {
                    if let track = trackToDelete {
                        Task { await delete(track) }
                    }
                    trackToDelete = nil
                }
                Button("Cancel", role: .cancel) { trackToDelete = nil }
            } message: {
                Text("The file is removed from the server’s library.")
            }
        }
    }

    // MARK: - Actions

    @ViewBuilder
    private func menu(for track: Track) -> some View {
        menuButton("Play", symbol: "play.fill") { play(track) }
        menuButton("Play next", symbol: "text.line.first.and.arrowtriangle.forward") {
            player.playNext(playable(track))
        }
        menuButton("Add to queue", symbol: "text.badge.plus") {
            player.enqueue(playable(track))
        }

        Menu {
            ForEach(playlists.playlists) { playlist in
                Button(playlist.name) {
                    playlists.add(PlaylistEntry(track: track), to: playlist.id)
                }
            }
            menuButton("New playlist", symbol: "plus") {
                let playlist = playlists.create(named: track.title)
                playlists.add(PlaylistEntry(track: track), to: playlist.id)
            }
        } label: {
            Label("Add to playlist", systemImage: "music.note.list")
        }

        Divider()

        if offline.isSaved(track.path) {
            menuButton("Remove device copy", symbol: "trash", role: .destructive) {
                offline.remove(track.path)
            }
        } else {
            menuButton("Save on device", symbol: "arrow.down.to.line") {
                Task { await offline.save(track) }
            }
        }

        menuButton("Delete from library", symbol: "trash", role: .destructive) {
            trackToDelete = track
        }
    }

    private func playable(_ track: Track) -> PlayableTrack {
        offline.playable(track, client: server.api)
    }

    private func play(_ track: Track) {
        let tracks = visibleTracks
        let queue = tracks.map { playable($0) }

        if let index = tracks.firstIndex(where: { $0.path == track.path }) {
            player.setQueue(queue, startAt: index, play: true)
        } else {
            player.setQueue([playable(track)], startAt: 0, play: true)
        }
    }

    private func playAll(shuffled: Bool) {
        let queue = visibleTracks.map { playable($0) }
        guard !queue.isEmpty else { return }

        player.isShuffled = shuffled
        player.setQueue(queue, startAt: shuffled ? Int.random(in: 0..<queue.count) : 0, play: true)
    }

    private func delete(_ track: Track) async {
        do {
            try await server.api.deleteTrack(track.path)
            offline.remove(track.path)

            if player.current?.trackPath == track.path {
                player.removeFromQueue(at: player.index)
            }

            await load()
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    private var visibleTracks: [Track] {
        guard let page else { return [] }
        let needle = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return page.tracks }

        return page.tracks.filter { track in
            [track.title, track.artist, track.album, track.name]
                .compactMap { $0 }
                .contains { $0.lowercased().contains(needle) }
        }
    }

    // MARK: - Data

    private func load() async {
        await MainActor.run { isLoading = true }

        do {
            let loaded = try await server.api.library(path: path, recursive: recursive)
            await MainActor.run {
                page = loaded
                isLoading = false
                errorMessage = nil
            }
            await probeMissingDurations()
        } catch {
            await MainActor.run {
                isLoading = false
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Durations of freshly downloaded files are only known after ffprobe has run.
    private func probeMissingDurations() async {
        guard let page else { return }

        let missing = page.tracks
            .filter { $0.duration == nil && durations[$0.path] == nil }
            .prefix(12)

        for track in missing {
            guard let response = try? await server.api.probeDuration(track.path), let seconds = response.duration else { continue }
            await MainActor.run { durations[track.path] = seconds }
        }
    }

    /// Applies a probed duration without mutating the decoded page.
    private func resolved(_ track: Track) -> Track {
        guard track.duration == nil, let seconds = durations[track.path] else { return track }
        var copy = track
        copy.duration = seconds
        return copy
    }
}
