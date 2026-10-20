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
    @State private var newName = ""
    @State private var showNewName = false

    var body: some View {
        NavigationStack {
            Form {
                addressSection
                identitySection
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

                if server.isConfigured, server.users.isEmpty {
                    Task { await server.loadUsers() }
                }
            }
            .alert("Your name", isPresented: $showNewName) {
                TextField("e.g. sam", text: $newName)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Cancel", role: .cancel) {}
                Button("Use this name") { adopt(newName) }
            } message: {
                Text("Letters, digits, dots, dashes and underscores. Each name gets its own library.")
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

    /// Everyone on the server has a name; the name decides whose library you see.
    @ViewBuilder
    private var identitySection: some View {
        Section {
            LabeledContent("Browsing as", value: server.displayUser)

            if server.username.isEmpty {
                Text("Nobody is chosen yet on this device.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }

            ForEach(otherUsers) { user in
                Button {
                    adopt(user.name)
                } label: {
                    HStack {
                        Text(user.name)
                            .foregroundColor(.primary)
                        Spacer()
                        Text(user.summary)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
            }

            Button {
                newName = ""
                showNewName = true
            } label: {
                Label("Use a new name…", systemImage: "person.badge.plus")
            }

            Button("Reload names") {
                Task { await server.loadUsers() }
            }
            .disabled(!server.isConfigured)
        } header: {
            Text("Who’s listening")
        } footer: {
            Text("Your name selects which library the server shows you, and is the name other people share songs with. It is not a password — it only keeps libraries apart.")
        }
    }

    private var otherUsers: [UserSummary] {
        server.users.filter { $0.name != server.username }
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

    private func adopt(_ name: String) {
        Task {
            let adopted = await server.adopt(username: name)
            guard adopted else { return }

            // A different person means a different library: drop the queue.
            player.clearQueue()

            if mode == .settings {
                dismiss()
            }
        }
    }

    private func connect() {
        Task {
            let succeeded = await server.testConnection(urlString: address, trustSelfSigned: trust, commit: true)
            if succeeded, mode == .settings {
                dismiss()
            }
        }
    }
}
