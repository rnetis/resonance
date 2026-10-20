import SwiftUI

@main
struct ResonanceApp: App {
    @StateObject private var model = AppModel()

    init() {
        // Category + system notifications only; the session is activated when the
        // web player actually starts playing (see AudioSessionController).
        AudioSessionController.shared.prepare()
        NowPlayingController.shared.configureRemoteCommands()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
        }
    }
}
