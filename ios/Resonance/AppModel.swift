import Foundation
import WebKit

/// Persisted shell state: which music server this app talks to, plus the few
/// UI flags the native chrome needs.
final class AppModel: ObservableObject {
    private enum Keys {
        static let serverURL = "resonance.serverURL"
        static let trustSelfSigned = "resonance.trustSelfSigned"
    }

    @Published var serverURL: String
    @Published var trustSelfSigned: Bool
    @Published var showSettings = false
    @Published var loadError: String?
    @Published var reloadToken = 0
    @Published var isClearingData = false

    private let defaults = UserDefaults.standard

    init() {
        serverURL = defaults.string(forKey: Keys.serverURL) ?? ""
        trustSelfSigned = defaults.bool(forKey: Keys.trustSelfSigned)
    }

    var isConfigured: Bool {
        Self.isValid(serverURL)
    }

    var displayHost: String {
        URL(string: serverURL)?.host ?? serverURL
    }

    func save(serverURL rawURL: String, trustSelfSigned: Bool) {
        serverURL = Self.normalize(rawURL)
        self.trustSelfSigned = trustSelfSigned
        defaults.set(serverURL, forKey: Keys.serverURL)
        defaults.set(trustSelfSigned, forKey: Keys.trustSelfSigned)
        NowPlayingController.shared.trustSelfSigned = trustSelfSigned
        loadError = nil
        reloadToken += 1
    }

    /// Applies a playback report from the web player to the audio session and the
    /// lock-screen now-playing entry.
    func handlePlayback(_ report: PlaybackReport) {
        if report.isPlaying {
            AudioSessionController.shared.beginPlayback()
        } else {
            AudioSessionController.shared.markPaused()
        }

        NowPlayingController.shared.update(with: report)
    }

    func reload() {
        loadError = nil
        reloadToken += 1
    }

    func forgetServer() {
        defaults.removeObject(forKey: Keys.serverURL)
        serverURL = ""
        loadError = nil
        reloadToken += 1
    }

    /// Wipes the WKWebView data store: the cached app shell, saved offline tracks
    /// and any cookies for that origin.
    func clearWebsiteData() {
        isClearingData = true
        let store = WKWebsiteDataStore.default()
        let types = WKWebsiteDataStore.allWebsiteDataTypes()

        store.fetchDataRecords(ofTypes: types) { records in
            store.removeData(ofTypes: types, for: records) {
                DispatchQueue.main.async {
                    self.isClearingData = false
                    self.reload()
                }
            }
        }
    }

    /// Accepts "host:port", "192.168.1.20:3130", "music.example.com" and full URLs.
    static func normalize(_ input: String) -> String {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "" }

        if !text.contains("://") {
            text = "http://" + text
        }

        while text.hasSuffix("/") {
            text.removeLast()
        }

        return text
    }

    static func isValid(_ input: String) -> Bool {
        guard
            let url = URL(string: normalize(input)),
            let scheme = url.scheme?.lowercased(),
            let host = url.host,
            !host.isEmpty,
            scheme == "http" || scheme == "https"
        else { return false }

        return true
    }
}
