import Foundation

enum APIError: LocalizedError {
    case invalidAddress
    case server(String)
    case transport(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidAddress:
            return "That server address is not valid."
        case .server(let message):
            return message
        case .transport(let message):
            return message
        case .decoding(let message):
            return "Unexpected response from the server (\(message))."
        }
    }
}

/// Client for the Resonance server API — the same JSON endpoints the web app uses.
///
/// The app never scrapes YouTube itself: search and downloads are the server's job
/// (`yt-dlp`), and audio is streamed from, or downloaded off, the server.
final class APIClient: NSObject, URLSessionDelegate {
    private(set) var baseURL: URL
    var trustSelfSigned: Bool

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 60 * 60
        configuration.requestCachePolicy = .useProtocolCachePolicy
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    init(baseURL: URL, trustSelfSigned: Bool) {
        self.baseURL = baseURL
        self.trustSelfSigned = trustSelfSigned
        super.init()
    }

    func update(baseURL: URL, trustSelfSigned: Bool) {
        self.baseURL = baseURL
        self.trustSelfSigned = trustSelfSigned
    }

    /// Shared session so artwork and file downloads honour the same TLS policy.
    var sharedSession: URLSession { session }

    // MARK: - URLs

    func url(path: String = "", query: [URLQueryItem] = []) -> URL? {
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let base = trimmed.isEmpty ? baseURL : baseURL.appendingPathComponent(trimmed)
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = query.isEmpty ? nil : query
        return components.url
    }

    func streamURL(for trackPath: String) -> URL? {
        url(path: "api/stream", query: [URLQueryItem(name: "path", value: trackPath)])
    }

    func coverURL(for trackPath: String) -> URL? {
        url(path: "api/cover", query: [URLQueryItem(name: "path", value: trackPath)])
    }

    // MARK: - Endpoints

    func health() async throws -> Health {
        try await get("api/health", as: Health.self)
    }

    func search(_ query: String) async throws -> [SearchResult] {
        try await get("api/search", query: [URLQueryItem(name: "q", value: query)], as: [SearchResult].self)
    }

    func library(path: String = "", recursive: Bool) async throws -> LibraryPage {
        var query = [URLQueryItem(name: "path", value: path)]
        if recursive {
            query.append(URLQueryItem(name: "recursive", value: "1"))
        }
        return try await get("api/tracks", query: query, as: LibraryPage.self)
    }

    func probeDuration(_ trackPath: String) async throws -> DurationResponse {
        try await get("api/duration", query: [URLQueryItem(name: "path", value: trackPath)], as: DurationResponse.self)
    }

    func startDownload(from videoURL: String, autoPlay: Bool = false) async throws -> Job {
        try await post("api/download", body: ["url": videoURL, "autoPlay": autoPlay], as: Job.self)
    }

    func jobs() async throws -> JobsPage {
        try await get("api/jobs", as: JobsPage.self)
    }

    func cancelJob(_ id: String) async throws {
        _ = try await delete("api/jobs/\(id)", as: JobDeletionResult.self)
    }

    func deleteTrack(_ trackPath: String) async throws {
        _ = try await delete("api/track", query: [URLQueryItem(name: "path", value: trackPath)], as: RemovedResponse.self)
    }

    // MARK: - Plumbing

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type) async throws -> T {
        guard let url = url(path: path, query: query) else { throw APIError.invalidAddress }
        return try await send(URLRequest(url: url), as: type)
    }

    private func post<T: Decodable>(_ path: String, body: [String: Any], as type: T.Type) async throws -> T {
        guard let url = url(path: path) else { throw APIError.invalidAddress }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request, as: type)
    }

    private func delete<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type) async throws -> T {
        guard let url = url(path: path, query: query) else { throw APIError.invalidAddress }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        return try await send(request, as: type)
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let data: Data
        let response: URLResponse

        do {
            (data, response) = try await session.data(for: request)
        } catch {
            let nsError = error as NSError
            if nsError.code == NSURLErrorCancelled {
                throw CancellationError()
            }
            throw APIError.transport(Self.describe(error))
        }

        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error
            throw APIError.server(message ?? "The server replied \(http.statusCode).")
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error.localizedDescription)
        }
    }

    private static func describe(_ error: Error) -> String {
        let nsError = error as NSError

        switch nsError.code {
        case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost, NSURLErrorNetworkConnectionLost,
             NSURLErrorNotConnectedToInternet, NSURLErrorDNSLookupFailed:
            return "Can’t reach the server. Check the address and that server.js is running."
        case NSURLErrorTimedOut:
            return "The server took too long to respond."
        case NSURLErrorAppTransportSecurityRequiresSecureConnection:
            return "iOS blocked that connection (App Transport Security)."
        case NSURLErrorServerCertificateUntrusted, NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateHasBadDate:
            return "The server’s HTTPS certificate is not trusted — enable “Trust self-signed certificate” in Server settings."
        default:
            return nsError.localizedDescription
        }
    }

    // MARK: - URLSessionDelegate

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard
            trustSelfSigned,
            challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
            let serverTrust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        completionHandler(.useCredential, URLCredential(trust: serverTrust))
    }
}
