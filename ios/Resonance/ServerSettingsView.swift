import Foundation
import SwiftUI

/// Server address, TLS trust, diagnostics and storage — also used as the first-run
/// screen when no server is configured yet.
struct ServerSettingsView: View {
    enum Mode {
        case setup
        case settings
    }

    var mode: Mode = .settings

    @EnvironmentObject private var server: ServerStore
    @EnvironmentObject private var offline: OfflineStore
    @EnvironmentObject private var player: AudioEngine
    @Environment(\.dismiss) private var dismiss

    @State private var address = ""
    @State private var trust = false
    @State private var loaded = false
    @State private var showForgetConfirm = false

    var body: some View {
        NavigationStack {
            Form {
                addressSection
                connectionSection
                diagnosticsSection
                storageSection

                if mode == .settings {
                    Section {
                        Button("Forget server address", role: .destructive) {
                            showForgetConfirm = true
                        }
                    }
                }
            }
            .navigationTitle(mode == .setup ? "Connect your server" : "Server settings")
            .toolbar {
                if mode == .settings {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button("Done") { dismiss() }
                    }
                }
            }
            .onAppear {
                guard !loaded else { return }
                address = server.serverURL
                trust = server.trustSelfSigned
                loaded = true
            }
            .confirmationDialog("Forget the server address?", isPresented: $showForgetConfirm, titleVisibility: .visible) {
                Button("Forget", role: .destructive) {
                    server.forget()
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    // MARK: - Sections

    private var addressSection: some View {
        Section {
            TextField("192.168.1.20:3130", text: $address)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .font(.system(.body, design: .monospaced))
                .submitLabel(.go)
                .onSubmit(connect)

            Toggle("Trust self-signed certificate", isOn: $trust)

            Button {
                connect()
            } label: {
                HStack {
                    Text("Connect")
                        .bold()
                    Spacer()
                    if server.isTesting {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.right.circle.fill")
                    }
                }
            }
            .disabled(!ServerStore.isValid(address) || server.isTesting)
        } header: {
            Text("Server address")
        } footer: {
            Text("Resonance talks to your own music server — the Node.js + yt-dlp backend in this repository. Enter its address including the port (default 3000). Use http:// for a local server; that is also what allows offline downloads on the device.")
        }
    }

    @ViewBuilder
    private var connectionSection: some View {
        Section {
            if let error = server.connectionError {
                ErrorBanner(message: error)
            } else if let health = server.health {
                LabeledContent("Library folder", value: health.musicDir)
                LabeledContent("yt-dlp", value: health.ytDlp ? "available" : "missing")
                LabeledContent("ffprobe", value: health.ffprobe ? "available" : "missing")
                LabeledContent("Audio format", value: health.format)
                LabeledContent("Active downloads", value: "\(health.activeDownloads)")
            } else {
                Text("Not checked yet — tap Connect.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }

            Button("Re-check server") {
                Task { await server.refreshHealth() }
            }
            .disabled(!server.isConfigured)
        } header: {
            Text("Connection")
        }
    }

    private var diagnosticsSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(AudioSessionController.stateDescription)
                Text(player.diagnostics)
                Text(player.current == nil ? "now playing: empty" : "now playing: \(player.current?.title ?? "")")
            }
            .font(.system(.caption, design: .monospaced))
            .foregroundColor(.secondary)
            .lineLimit(3)
        } header: {
            Text("Playback diagnostics")
        } footer: {
            Text("Useful if audio stops: it shows whether the session is in playback mode and what the player is doing.")
        }
    }

    private var storageSection: some View {
        Section {
            LabeledContent("Saved on device", value: "\(offline.entries.count) tracks")
            LabeledContent("Space used", value: Format.bytes(Double(offline.totalBytes)))

            if !offline.entries.isEmpty {
                Button("Delete downloaded tracks", role: .destructive) {
                    offline.removeAll()
                }
            }
        } header: {
            Text("Offline storage")
        }
    }

    // MARK: - Actions

    private func connect() {
        Task {
            let succeeded = await server.testConnection(urlString: address, trustSelfSigned: trust, commit: true)
            if succeeded, mode == .settings {
                dismiss()
            }
        }
    }
}
