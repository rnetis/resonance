import SwiftUI

@main
struct ResonanceApp: App {
    @StateObject private var model = AppModel()

    init() {
        // Must happen before any media starts so background playback works.
        AudioSessionController.shared.activate()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
        }
    }
}
