import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            if model.isConfigured {
                WebViewScreen()
            } else {
                NavigationView {
                    SetupView(isFirstRun: true)
                }
                .navigationViewStyle(.stack)
            }
        }
        .sheet(isPresented: $model.showSettings) {
            NavigationView {
                SetupView(isFirstRun: false)
            }
            .navigationViewStyle(.stack)
            .environmentObject(model)
        }
    }
}

/// Shown when the web view cannot reach the configured server.
struct LoadErrorView: View {
    let message: String
    let onRetry: () -> Void
    let onSettings: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 40, weight: .regular))
                .foregroundColor(Color(red: 0.72, green: 0.62, blue: 1.0))

            Text("Can’t reach your music server")
                .font(.headline)
                .multilineTextAlignment(.center)

            Text(message)
                .font(.footnote)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)

            HStack(spacing: 10) {
                Button(action: onRetry) {
                    Label("Retry", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)

                Button(action: onSettings) {
                    Label("Server", systemImage: "slider.horizontal.3")
                }
                .buttonStyle(.bordered)
            }
            .padding(.top, 4)
        }
        .padding(26)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .padding(28)
    }
}
