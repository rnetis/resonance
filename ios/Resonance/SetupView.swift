import SwiftUI

struct SetupView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    let isFirstRun: Bool

    @State private var urlText = ""
    @State private var trustSelfSigned = false
    @State private var showClearConfirm = false
    @State private var diagnosticsTick = 0

    private var valid: Bool {
        AppModel.isValid(urlText)
    }

    var body: some View {
        Form {
            Section {
                TextField("http://192.168.1.20:3130", text: $urlText, onCommit: commit)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .font(.system(.body, design: .monospaced))
                    .submitLabel(.go)
            } header: {
                Text("Server address")
            } footer: {
                Text("Resonance streams from your own music server — the Node.js + yt-dlp backend in this repository. Enter its address including the port (default 3000).")
            }

            Section {
                Toggle("Trust self-signed certificate", isOn: $trustSelfSigned)
            } footer: {
                Text("Only needed when your server uses HTTPS with a certificate iOS does not trust.")
            }

            if !isFirstRun {
                Section {
                    Button(role: .destructive) {
                        showClearConfirm = true
                    } label: {
                        HStack {
                            Text("Clear cached website data")
                            Spacer()
                            if model.isClearingData {
                                ProgressView()
                            }
                        }
                    }
                    Button(role: .destructive) {
                        model.forgetServer()
                        dismiss()
                    } label: {
                        Text("Forget server address")
                    }
                } footer: {
                    Text("Clearing removes the offline app shell, tracks saved for offline listening and any site data for that server.")
                }
            }

            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(AudioSessionController.shared.snapshot())
                    Text("lock screen: \(NowPlayingController.shared.isCommandChannelOpen ? "connected" : "not connected")")
                    Text("last report: \(NowPlayingController.shared.lastReportSummary)")
                }
                .font(.system(.caption, design: .monospaced))
                .foregroundColor(.secondary)
                .lineLimit(3)
                .id(diagnosticsTick)

                Button("Refresh") { diagnosticsTick += 1 }
            } header: {
                Text("Diagnostics")
            } footer: {
                Text("Audio session and lock-screen state. Start a track, lock the screen and reopen this panel if playback stops.")
            }

            if isFirstRun {
                Section {
                    Button(action: commit) {
                        HStack {
                            Spacer()
                            Text("Connect").bold()
                            Spacer()
                        }
                    }
                    .disabled(!valid)
                } footer: {
                    Text("Not sure? Run `node server.js` on your computer and use the address it prints.")
                }
            }
        }
        .navigationTitle(isFirstRun ? "Connect your server" : "Server settings")
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                if !isFirstRun {
                    Button("Cancel") { dismiss() }
                }
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                if !isFirstRun {
                    Button("Save", action: commit).disabled(!valid)
                }
            }
        }
        .onAppear {
            urlText = model.serverURL.isEmpty ? "" : model.serverURL
            trustSelfSigned = model.trustSelfSigned
        }
        .confirmationDialog(
            "Clear cached website data?",
            isPresented: $showClearConfirm,
            titleVisibility: .visible
        ) {
            Button("Clear data", role: .destructive) { model.clearWebsiteData() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Tracks saved for offline listening will need to be downloaded again.")
        }
    }

    private func commit() {
        guard valid else { return }
        model.save(serverURL: urlText, trustSelfSigned: trustSelfSigned)
        if !isFirstRun { dismiss() }
    }
}
