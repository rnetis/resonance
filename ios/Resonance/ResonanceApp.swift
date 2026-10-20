import SwiftUI

@main
struct ResonanceApp: App {
    @StateObject private var server: ServerStore
    @StateObject private var player: AudioEngine
    @StateObject private var offline: OfflineStore
    @StateObject private var downloads: DownloadCenter
    @StateObject private var playlists = PlaylistStore()

    init() {
        let store = ServerStore()
        _server = StateObject(wrappedValue: store)
        _player = StateObject(wrappedValue: AudioEngine(api: store.api))
        _offline = StateObject(wrappedValue: OfflineStore(api: store.api))
        _downloads = StateObject(wrappedValue: DownloadCenter(api: store.api))

        // Configured once, before any media exists — and never touched again.
        AudioSessionController.prepare()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(server)
                .environmentObject(player)
                .environmentObject(offline)
                .environmentObject(downloads)
                .environmentObject(playlists)
                .preferredColorScheme(.dark)
                .tint(.resonanceAccent)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var server: ServerStore
    @EnvironmentObject private var player: AudioEngine
    @EnvironmentObject private var downloads: DownloadCenter

    @State private var tab: Tab = .library
    @State private var showNowPlaying = false
    @State private var showSettings = false

    enum Tab: Hashable {
        case search
        case library
        case downloads
        case playlists
    }

    var body: some View {
        Group {
            if server.isConfigured {
                tabs
            } else {
                ServerSettingsView(mode: .setup)
            }
        }
        .sheet(isPresented: $showSettings) {
            ServerSettingsView(mode: .settings)
        }
        .onAppear { downloads.beginPolling() }
    }

    private var tabs: some View {
        TabView(selection: $tab) {
            SearchView()
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(Tab.search)

            LibraryView()
                .tabItem { Label("Library", systemImage: "books.vertical") }
                .tag(Tab.library)

            DownloadsView()
                .tabItem { Label("Downloads", systemImage: "arrow.down.circle") }
                .tag(Tab.downloads)

            PlaylistsView()
                .tabItem { Label("Playlists", systemImage: "music.note.list") }
                .tag(Tab.playlists)
        }
        .overlay(alignment: .bottom) {
            if player.current != nil {
                MiniPlayerBar { showNowPlaying = true }
                    .padding(.horizontal, 10)
                    .padding(.bottom, 56)
            }
        }
        .fullScreenCover(isPresented: $showNowPlaying) {
            NowPlayingView()
        }
    }
}
