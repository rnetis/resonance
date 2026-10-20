import SwiftUI
import UIKit
import WebKit

/// WKWebView host for the Resonance web player.
///
/// The web app is loaded from the user's own server so that everything stays on
/// one origin: same-origin fetches, Range-scoped audio streaming and (over HTTPS)
/// the service worker with its offline app shell and saved tracks.
struct ResonanceWebView: UIViewRepresentable {
    let urlString: String
    let trustSelfSigned: Bool
    let reloadToken: Int
    let onLoaded: () -> Void
    let onError: (String) -> Void
    let onOpenSettings: () -> Void
    let onPlayback: (PlaybackReport) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        // The web player only starts from a user tap; once started, queue
        // advance and lock-screen controls must not need another gesture.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true

        // Native bridge: the web app only shows its settings button when this
        // exists, reports playback so the shell can own the audio session and the
        // lock screen, and disables its Web Audio visualiser (an AudioContext is
        // suspended in the background on iOS, which would silence playback).
        let bridge = WKUserScript(
            source: """
            window.__resonanceNative = {
              platform: 'ios',
              visualizer: false,
              openSettings: function () {
                try { window.webkit.messageHandlers.resonance.postMessage({ type: 'openSettings' }); } catch (e) {}
              },
              onPlayback: function (payload) {
                try {
                  var message = { type: 'playback' };
                  for (var key in payload) { message[key] = payload[key]; }
                  window.webkit.messageHandlers.resonance.postMessage(message);
                } catch (e) {}
              }
            };
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        configuration.userContentController.addUserScript(bridge)
        configuration.userContentController.add(context.coordinator, name: "resonance")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.03, green: 0.03, blue: 0.05, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        // The web app handles safe-area insets itself (viewport-fit=cover).
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }

        context.coordinator.trustSelfSigned = trustSelfSigned
        context.coordinator.load(urlString: urlString, reloadToken: reloadToken, in: webView)
        context.coordinator.attachShell(to: webView)

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.trustSelfSigned = trustSelfSigned
        NowPlayingController.shared.trustSelfSigned = trustSelfSigned

        if context.coordinator.loadedURL != urlString || context.coordinator.loadedToken != reloadToken {
            context.coordinator.load(urlString: urlString, reloadToken: reloadToken, in: webView)
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.detachShell()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "resonance")
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: ResonanceWebView
        var trustSelfSigned: Bool
        private(set) var loadedURL = ""
        private(set) var loadedToken = -1
        private var serverHost: String?

        init(_ parent: ResonanceWebView) {
            self.parent = parent
            self.trustSelfSigned = parent.trustSelfSigned
        }

        func load(urlString: String, reloadToken: Int, in webView: WKWebView) {
            loadedURL = urlString
            loadedToken = reloadToken

            guard let url = URL(string: urlString) else {
                parent.onError("\u{201C}\(urlString)\u{201D} is not a valid server address.")
                return
            }

            serverHost = url.host
            var request = URLRequest(url: url)
            request.cachePolicy = .useProtocolCachePolicy
            webView.load(request)
        }

        // MARK: - Navigation

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.onLoaded()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }

            let scheme = url.scheme?.lowercased() ?? ""
            let isWebLink = scheme == "http" || scheme == "https"

            // Links the web app opens with window.open()/_blank leave for Safari.
            if navigationAction.targetFrame == nil {
                if isWebLink { UIApplication.shared.open(url) }
                decisionHandler(.cancel)
                return
            }

            if isWebLink {
                let isSameServer = url.host == nil || url.host == serverHost
                if isSameServer {
                    decisionHandler(.allow)
                } else {
                    UIApplication.shared.open(url)
                    decisionHandler(.cancel)
                }
                return
            }

            // tel:, mailto:, custom schemes…
            if UIApplication.shared.canOpenURL(url) {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        // MARK: - WKUIDelegate

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url {
                UIApplication.shared.open(url)
            }
            return nil
        }

        // MARK: - TLS

        func webView(
            _ webView: WKWebView,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            guard
                trustSelfSigned,
                challenge.protectionSpace.host == serverHost,
                challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                let serverTrust = challenge.protectionSpace.serverTrust
            else {
                completionHandler(.performDefaultHandling, nil)
                return
            }

            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        }

        // MARK: - Native bridge

        /// Connects the lock-screen / remote-control plumbing to this web view.
        func attachShell(to webView: WKWebView) {
            NowPlayingController.shared.trustSelfSigned = parent.trustSelfSigned
            NowPlayingController.shared.configureRemoteCommands(trustedHost: URL(string: parent.urlString)?.host)

            NowPlayingController.shared.sendCommand = { [weak webView] name, value in
                guard let webView else { return }
                let argument = value.map { String(format: "%.3f", $0) } ?? "undefined"
                let script = "window.__resonanceRemote && window.__resonanceRemote.command('\(name)', \(argument));"
                DispatchQueue.main.async {
                    webView.evaluateJavaScript(script, completionHandler: nil)
                }
            }

            AudioSessionController.shared.onShouldResume = { [weak webView] in
                guard let webView else { return }
                DispatchQueue.main.async {
                    webView.evaluateJavaScript(
                        "window.__resonanceRemote && window.__resonanceRemote.command('play');",
                        completionHandler: nil
                    )
                }
            }

            AudioSessionController.shared.onMediaServicesReset = { [weak webView] in
                guard let webView else { return }
                DispatchQueue.main.async {
                    // Re-assert the now-playing entry the system wiped.
                    webView.evaluateJavaScript(
                        "window.__resonanceRemote && window.__resonanceRemote.command('refresh');",
                        completionHandler: nil
                    )
                }
            }
        }

        func detachShell() {
            NowPlayingController.shared.sendCommand = nil
            AudioSessionController.shared.onShouldResume = nil
            AudioSessionController.shared.onMediaServicesReset = nil
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard
                message.name == "resonance",
                let body = message.body as? [String: Any],
                let type = body["type"] as? String
            else { return }

            switch type {
            case "openSettings":
                parent.onOpenSettings()
            case "playback":
                if let report = PlaybackReport(body: body) {
                    parent.onPlayback(report)
                }
            default:
                break
            }
        }

        // MARK: - Helpers

        private func report(_ error: Error) {
            let nsError = error as NSError
            // A superseded load (e.g. an immediate retry) is not a failure.
            if nsError.code == NSURLErrorCancelled { return }
            parent.onError(nsError.localizedDescription)
        }
    }
}
