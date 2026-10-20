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
    @State private var trackToShare: Track?
    @State private var showSettings = false
    /// "library" is this person's own folder; "shared" is the area everyone sees.
    @State private var scope = "library"

    init(path: String = "") {
        _path = State(initialValue: path)
    }

    var body: some View {
        NavigationStack {
            List {
                errorSection
                loadingSection

                if let page {
                    foldersSection(page)
                    tracksSection
                }
            }
            .listStyle(.insetGrouped)
            .miniPlayerInset(player.current != nil)
            .navigationTitle(navigationTitle)
            .navigationDestination(for: String.self) { destination in
                LibraryView(path: destination)
            }
            .searchable(text: $filter, prompt: "Filter tracks")
            .toolbar { toolbarContent }
            .refreshable { await load() }
            .task { await load() }
            .sheet(isPresented: $showSettings) {
                ServerSettingsView(mode: .settings)
            }
            .sheet(item: $trackToShare) { track in
                ShareTargetPicker(track: track)
            }
            .confirmationDialog(
                deleteTitle,
                isPresented: deleteDialogBinding,
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

    // MARK: - Sections

    @ViewBuilder
    private var errorSection: some View {
        if let errorMessage {
            Section {
                ErrorBanner(message: errorMessage)
            }
        }
    }

    @ViewBuilder
    private var loadingSection: some View {
        if isLoading && page == nil {
            HStack {
                Spacer()
                ProgressView("Loading library…")
                Spacer()
            }
        }
    }

    @ViewBuilder
    private func foldersSection(_ page: LibraryPage) -> some View {
        if !page.folders.isEmpty && !recursive {
            Section("Folders") {
                ForEach(page.folders) { folder in
                    NavigationLink(value: folder.path) {
                        FolderRow(folder: folder)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var tracksSection: some View {
        Section {
            if visibleTracks.isEmpty {
                emptyState
            } else {
                ForEach(visibleTracks) { track in
                    trackRow(track)
                }
            }
        } header: {
            Text(sectionTitle)
        }
    }

    private var emptyState: EmptyStateView {
        if filter.trimmingCharacters(in: .whitespaces).isEmpty {
            return EmptyStateView(
                symbol: "music.note.list",
                title: "No music here yet",
                message: "Search for a song and tap it to download it into this folder."
            )
        }

        return EmptyStateView(
            symbol: "line.3.horizontal.decrease.circle",
            title: "No matches",
            message: "Try a different filter."
        )
    }

    private func trackRow(_ track: Track) -> some View {
        let shown = resolved(track)

        return Button {
            play(shown)
        } label: {
            TrackRow(
                track: shown,
                artworkURL: (server.api.absolute(shown.cover) ?? server.api.coverURL(for: shown.path, scope: shown.scope))?.absoluteString,
                isCurrent: player.current?.trackPath == shown.path,
                isSaved: offline.isSaved(shown.path)
            )
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                play(shown)
            } label: {
                Label("Play", systemImage: "play.fill")
            }
            .tint(.resonanceAccent)
        }
        .swipeActions(edge: .trailing) {
            if !shown.isFromSharedArea {
                Button(role: .destructive) {
                    trackToDelete = shown
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
        .contextMenu {
            menu(for: shown)
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .navigationBarLeading) {
            Button {
                recursive.toggle()
                Task { await load() }
            } label: {
                Image(systemName: recursive ? "square.stack.3d.up.fill" : "square.stack.3d.up")
            }
        }

        ToolbarItem(placement: .navigationBarTrailing) {
            Button {
                scope = scope == "shared" ? "library" : "shared"
                path = ""
                Task { await load() }
            } label: {
                Image(systemName: scope == "shared" ? "person.2.fill" : "person.2")
            }
            .accessibilityLabel(scope == "shared" ? "Back to my library" : "Show everyone’s songs")
        }

        ToolbarItem(placement: .navigationBarTrailing) {
            Menu {
                menuButton("Play all", symbol: "play.fill") { playAll(shuffled: false) }
                menuButton("Shuffle all", symbol: "shuffle") { playAll(shuffled: true) }
                Divider()
                menuButton("Server settings", symbol: "slider.horizontal.3") { showSettings = true }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }

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
                _ = playlists.add(PlaylistEntry(track: track), to: playlist.id)
            }
        } label: {
            Label("Add to playlist", systemImage: "music.note.list")
        }

        if !track.isFromSharedArea {
            menuButton("Share with…", symbol: "square.and.arrow.up") {
                trackToShare = track
            }
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

        if !track.isFromSharedArea {
            menuButton("Delete from library", symbol: "trash", role: .destructive) {
                trackToDelete = track
            }
        }
    }

    // MARK: - Derived state

    private var navigationTitle: String {
        if scope == "shared" {
            return path.isEmpty ? "Everyone’s songs" : URL(fileURLWithPath: path).lastPathComponent
        }
        return path.isEmpty ? "Library" : URL(fileURLWithPath: path).lastPathComponent
    }

    private var sectionTitle: String {
        recursive ? "All songs (\(visibleTracks.count))" : "Songs (\(visibleTracks.count))"
    }

    private var deleteTitle: String {
        "Delete “\(trackToDelete?.title ?? "")”?"
    }

    private var deleteDialogBinding: Binding<Bool> {
        Binding(
            get: { trackToDelete != nil },
            set: { if !$0 { trackToDelete = nil } }
        )
    }

    private var visibleTracks: [Track] {
        guard let page else { return [] }

        let needle = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return page.tracks }

        return page.tracks.filter { track in
            let fields = [track.title, track.artist, track.album, track.name].compactMap { $0 }
            return fields.contains { $0.lowercased().contains(needle) }
        }
    }

    // MARK: - Actions

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

    // MARK: - Data

    private func load() async {
        await MainActor.run { isLoading = true }

        do {
            let loaded = try await server.api.library(path: path, recursive: recursive, scope: scope)
            await MainActor.run {
                page = loaded
                isLoading = false
                errorMessage = nil
            }
            await probeMissingDurations(in: loaded)
        } catch {
            await MainActor.run {
                isLoading = false
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Durations of freshly downloaded files are only known after ffprobe has run.
    private func probeMissingDurations(in page: LibraryPage) async {
        let missing = page.tracks
            .filter { $0.duration == nil && durations[$0.path] == nil }
            .prefix(12)

        for track in missing {
            let response = try? await server.api.probeDuration(track.path)

            if let seconds = response?.duration {
                await MainActor.run { durations[track.path] = seconds }
            }
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
