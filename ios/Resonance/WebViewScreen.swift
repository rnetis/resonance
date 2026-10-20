import SwiftUI

/// Full-screen web player, with a native error state when the server is down.
struct WebViewScreen: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ZStack {
            ResonanceWebView(
                urlString: model.serverURL,
                trustSelfSigned: model.trustSelfSigned,
                reloadToken: model.reloadToken,
                onLoaded: { model.loadError = nil },
                onError: { message in
                    if model.loadError == nil {
                        model.loadError = message
                    }
                },
                onOpenSettings: { model.showSettings = true }
            )
            .ignoresSafeArea()

            if let message = model.loadError {
                Color(red: 0.03, green: 0.03, blue: 0.05)
                    .opacity(0.92)
                    .ignoresSafeArea()

                LoadErrorView(
                    message: message,
                    onRetry: { model.reload() },
                    onSettings: { model.showSettings = true }
                )
            }
        }
    }
}
