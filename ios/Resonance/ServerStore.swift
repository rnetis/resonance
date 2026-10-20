import Combine
import Foundation

/// Which server the app talks to, persisted between launches.
final class ServerStore: ObservableObject {
    private enum Keys {
        static let serverURL = "resonance.serverURL"
        static let trustSelfSigned = "resonance.trustSelfSigned"
        static let username = "resonance.username"
    }

    @Published private(set) var serverURL: String
    @Published private(set) var trustSelfSigned: Bool
    /// Which person's library this device browses. A name, not a password.
    @Published private(set) var username: String
    @Published var users: [UserSummary] = []
    @Published var defaultUser: String = ""
    @Published var connectionError: String?
    @Published var isTesting = false
    @Published var health: Health?

    let api: APIClient

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults

        let storedURL = defaults.string(forKey: Keys.serverURL) ?? ""
        let storedTrust = defaults.bool(forKey: Keys.trustSelfSigned)
        let storedUser = defaults.string(forKey: Keys.username) ?? ""

        serverURL = storedURL
        trustSelfSigned = storedTrust
        username = storedUser
        api = APIClient(
            baseURL: URL(string: storedURL) ?? URL(string: "http://127.0.0.1:3000")!,
            trustSelfSigned: storedTrust,
            username: storedUser.isEmpty ? nil : storedUser
        )
    }

    var isConfigured: Bool { Self.isValid(serverURL) }
    var displayHost: String { URL(string: serverURL)?.host ?? serverURL }
    var displayUser: String { username.isEmpty ? "Guest" : username }

    /// Remembers who is listening; every request then selects their library.
    func setUsername(_ raw: String) {
        let clean = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        username = clean
        defaults.set(clean, forKey: Keys.username)
        api.username = clean.isEmpty ? nil : clean
    }

    func loadUsers() async {
        guard isConfigured else { return }

        do {
            let page = try await api.users()
            await MainActor.run {
                self.users = page.users
                self.defaultUser = page.defaultUser
            }
        } catch {
            await MainActor.run { self.connectionError = error.localizedDescription }
        }
    }

    /// Creates the name if it is new, then starts browsing as that person.
    @discardableResult
    func adopt(username raw: String) async -> Bool {
        let clean = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !clean.isEmpty else { return false }

        if let existing = users.first(where: { $0.name == clean }) {
            setUsername(existing.name)
            return true
        }

        do {
            let created = try await api.createUser(clean)
            await MainActor.run {
                self.users.append(created)
                self.setUsername(created.name)
            }
            return true
        } catch {
            await MainActor.run { self.connectionError = error.localizedDescription }
            return false
        }
    }

    func save(_ rawURL: String, trustSelfSigned trust: Bool) {
        let normalized = Self.normalize(rawURL)
        serverURL = normalized
        trustSelfSigned = trust
        defaults.set(normalized, forKey: Keys.serverURL)
        defaults.set(trust, forKey: Keys.trustSelfSigned)

        if let url = URL(string: normalized) {
            api.update(baseURL: url, trustSelfSigned: trust, username: username.isEmpty ? nil : username)
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
