import Combine
import Foundation

/// Which server the app talks to, persisted between launches.
final class ServerStore: ObservableObject {
    private enum Keys {
        static let serverURL = "resonance.serverURL"
        static let trustSelfSigned = "resonance.trustSelfSigned"
    }

    @Published private(set) var serverURL: String
    @Published private(set) var trustSelfSigned: Bool
    @Published var connectionError: String?
    @Published var isTesting = false
    @Published var health: Health?

    let api: APIClient

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults

        let storedURL = defaults.string(forKey: Keys.serverURL) ?? ""
        let storedTrust = defaults.bool(forKey: Keys.trustSelfSigned)

        serverURL = storedURL
        trustSelfSigned = storedTrust
        api = APIClient(
            baseURL: URL(string: storedURL) ?? URL(string: "http://127.0.0.1:3000")!,
            trustSelfSigned: storedTrust
        )
    }

    var isConfigured: Bool { Self.isValid(serverURL) }
    var displayHost: String { URL(string: serverURL)?.host ?? serverURL }

    func save(_ rawURL: String, trustSelfSigned trust: Bool) {
        let normalized = Self.normalize(rawURL)
        serverURL = normalized
        trustSelfSigned = trust
        defaults.set(normalized, forKey: Keys.serverURL)
        defaults.set(trust, forKey: Keys.trustSelfSigned)

        if let url = URL(string: normalized) {
            api.update(baseURL: url, trustSelfSigned: trust)
        }

        connectionError = nil
    }

    func forget() {
        defaults.removeObject(forKey: Keys.serverURL)
        serverURL = ""
        health = nil
        connectionError = nil
    }

    /// Health-checks an address before it is committed, so a typo is obvious.
    @discardableResult
    func testConnection(urlString: String, trustSelfSigned trust: Bool, commit: Bool = false) async -> Bool {
        guard let base = URL(string: Self.normalize(urlString)), Self.isValid(urlString) else {
            await MainActor.run { self.connectionError = "That address is not valid." }
            return false
        }

        await MainActor.run {
            self.isTesting = true
            self.connectionError = nil
        }

        let probe = APIClient(baseURL: base, trustSelfSigned: trust)

        do {
            let health = try await probe.health()
            await MainActor.run {
                self.isTesting = false
                self.health = health

                if commit {
                    self.save(urlString, trustSelfSigned: trust)
                }
            }
            return true
        } catch {
            await MainActor.run {
                self.isTesting = false
                self.connectionError = error.localizedDescription
            }
            return false
        }
    }

    func refreshHealth() async {
        guard isConfigured else { return }

        do {
            let health = try await api.health()
            await MainActor.run { self.health = health }
        } catch {
            await MainActor.run { self.connectionError = error.localizedDescription }
        }
    }

    // MARK: - Address handling

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
