import Foundation
import SwiftUI

/// Local playlists plus the tracks saved on the device.
struct PlaylistsView: View {
    @EnvironmentObject private var server: ServerStore
    @EnvironmentObject private var player: AudioEngine
    @EnvironmentObject private var offline: OfflineStore
    @EnvironmentObject private var playlists: PlaylistStore

    @State private var isNaming = false
    @State private var newName = ""
    @State private var playlistToRename: Playlist?

    var body: some View {
        NavigationStack {
            List {
                if let error = offline.errorMessage {
                    Section { ErrorBanner(message: error) }
                }

                Section {
                    if offline.entries.isEmpty {
                        EmptyStateView(
                            symbol: "arrow.down.to.line",
                            title: "Nothing saved on this device",
                            message: "Use “Save on device” on a track to keep it playable with no network."
                        )
                    } else {
                        ForEach(offline.entries) { entry in
                            HStack(spacing: 12) {
                                ArtworkView(
                                    urlString: server.api.coverURL(for: entry.trackPath)?.absoluteString,
                                    size: 46,
                                    cornerRadius: 9
                                )

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.title)
                                        .font(.subheadline.weight(.medium))
                                        .lineLimit(1)
                                    Text([entry.artist, Format.bytes(Double(entry.size))].compactMap { $0 }.joined(separator: " · "))
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                        .lineLimit(1)
                                }

                                Spacer()

                                Text(Format.time(entry.duration))
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                            .contentShape(Rectangle())
                            .onTapGesture { playOffline(startingAt: entry) }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    offline.remove(entry.trackPath)
                                } label: {
                                    Label("Remove", systemImage: "trash")
                                }
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text("On this device")
                        Spacer()
                        if !offline.entries.isEmpty {
                            Text(Format.bytes(Double(offline.totalBytes)))
                        }
                    }
                }

                Section("Playlists") {
                    if playlists.playlists.isEmpty {
                        EmptyStateView(
                            symbol: "music.note.list",
                            title: "No playlists yet",
                            message: "Create one, then add tracks from a track’s context menu."
                        )
                    } else {
                        ForEach(playlists.playlists) { playlist in
                            NavigationLink {
                                PlaylistDetailView(playlistID: playlist.id)
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "music.note.list")
                                        .font(.system(size: 18))
                                        .foregroundColor(.resonanceAccent)
                                        .frame(width: 46, height: 46)
                                        .background(Color.resonanceSurface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))

                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(playlist.name)
                                            .font(.subheadline.weight(.medium))
                                            .lineLimit(1)
                                        Text("\(playlist.entries.count) tracks")
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                    }

                                    Spacer()
                                }
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    playlists.delete(playlist)
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                            .contextMenu {
                                menuButton("Play", symbol: "play.fill") { play(playlist, shuffled: false) }
                                menuButton("Shuffle", symbol: "shuffle") { play(playlist, shuffled: true) }
                                menuButton("Rename", symbol: "pencil") {
                                    playlistToRename = playlist
                                    newName = playlist.name
                                }
                                Divider()
                                menuButton("Delete", symbol: "trash", role: .destructive) {
                                    playlists.delete(playlist)
                                }
                            }
                        }
                    }
                }

                if !offline.entries.isEmpty {
                    Section {
                        Button(role: .destructive) {
                            offline.removeAll()
                        } label: {
                            Label("Free up space", systemImage: "trash")
                        }
                    } footer: {
                        Text("Removes every track saved on this device. Files stay in the server’s library.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .miniPlayerInset(player.current != nil)
            .navigationTitle("Playlists")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        newName = ""
                        isNaming = true
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .alert("New playlist", isPresented: $isNaming) {
                TextField("Name", text: $newName)
                Button("Create") {
                    playlists.create(named: newName)
                }
                Button("Cancel", role: .cancel) {}
            }
            .alert("Rename playlist", isPresented: Binding(get: { playlistToRename != nil }, set: { if !$0 { playlistToRename = nil } })) {
                TextField("Name", text: $newName)
                Button("Save") {
                    if let playlist = playlistToRename {
                        playlists.rename(playlist, to: newName)
                    }
                    playlistToRename = nil
                }
                Button("Cancel", role: .cancel) { playlistToRename = nil }
            }
        }
    }

    private func playOffline(startingAt entry: OfflineEntry) {
        let tracks = offline.playableTracks
        guard let index = tracks.firstIndex(where: { $0.trackPath == entry.trackPath }) else { return }
        player.setQueue(tracks, startAt: index, play: true)
    }

    private func play(_ playlist: Playlist, shuffled: Bool) {
        let tracks = playlists.playableTracks(in: playlist, offline: offline, client: server.api)
        guard !tracks.isEmpty else { return }

        player.isShuffled = shuffled
        player.setQueue(tracks, startAt: shuffled ? Int.random(in: 0..<tracks.count) : 0, play: true)
    }
}

struct PlaylistDetailView: View {
    @EnvironmentObject private var server: ServerStore
    @EnvironmentObject private var player: AudioEngine
    @EnvironmentObject private var offline: OfflineStore
    @EnvironmentObject private var playlists: PlaylistStore

    let playlistID: UUID

    var body: some View {
        List {
            if let playlist = playlists.playlist(playlistID) {
                if playlist.entries.isEmpty {
                    Section {
                        EmptyStateView(
                            symbol: "music.note",
                            title: "Empty playlist",
                            message: "Add tracks from the Library tab’s context menu."
                        )
                    }
                } else {
                    Section("\(playlist.entries.count) tracks") {
                        ForEach(playlist.entries) { entry in
                            HStack(spacing: 12) {
                                ArtworkView(
                                    urlString: entry.hasCover ? server.api.coverURL(for: entry.trackPath)?.absoluteString : nil,
                                    size: 46,
                                    cornerRadius: 9
                                )

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.title)
                                        .font(.subheadline.weight(.medium))
                                        .lineLimit(1)
                                    Text(entry.artist ?? "Unknown artist")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                        .lineLimit(1)
                                }

                                Spacer()

                                Text(Format.time(entry.duration))
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                            .contentShape(Rectangle())
                            .onTapGesture {
                                play(playlist, startingAt: entry)
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    playlists.remove(entry, from: playlistID)
                                } label: {
                                    Label("Remove", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
            } else {
                EmptyStateView(symbol: "questionmark", title: "Playlist not found", message: "It may have been deleted.")
            }
        }
        .listStyle(.insetGrouped)
        .miniPlayerInset(player.current != nil)
        .navigationTitle(playlists.playlist(playlistID)?.name ?? "Playlist")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    if let playlist = playlists.playlist(playlistID) {
                        play(playlist, shuffled: false)
                    }
                } label: {
                    Image(systemName: "play.fill")
                }
            }
        }
    }

    private func play(_ playlist: Playlist, startingAt entry: PlaylistEntry) {
        let tracks = playlists.playableTracks(in: playlist, offline: offline, client: server.api)
        guard let index = tracks.firstIndex(where: { $0.trackPath == entry.trackPath }) else { return }
        player.setQueue(tracks, startAt: index, play: true)
    }

    private func play(_ playlist: Playlist, shuffled: Bool) {
        let tracks = playlists.playableTracks(in: playlist, offline: offline, client: server.api)
        guard !tracks.isEmpty else { return }

        player.isShuffled = shuffled
        player.setQueue(tracks, startAt: shuffled ? Int.random(in: 0..<tracks.count) : 0, play: true)
    }
}
