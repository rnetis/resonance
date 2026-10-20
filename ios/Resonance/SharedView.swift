import SwiftUI

/// Songs other people sent you, and songs you sent them.
///
/// Shares are references, not copies: the file stays in the sender’s library,
/// and the recipient can play it in place or copy it into their own folder.
struct SharedView: View {
    @EnvironmentObject private var server: ServerStore
    @EnvironmentObject private var player: AudioEngine

    @State private var page: SharesPage?
    @State private var direction: Direction = .incoming
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var busyID: String?
    @State private var showSettings = false

    enum Direction: String, CaseIterable, Identifiable {
        case incoming
        case outgoing

        var id: String { rawValue }

        var title: String {
            self == .incoming ? "Shared with me" : "I shared"
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }

                Picker("Direction", selection: $direction) {
                    ForEach(Direction.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))

                Section {
                    if isLoading && page == nil {
                        loadingRow
                    } else if shares.isEmpty {
                        emptyState
                    } else {
                        ForEach(shares) { share in
                            row(share)
                        }
                    }
                } header: {
                    Text(direction == .incoming ? "From other people" : "Sent by you")
                } footer: {
                    footer
                }
            }
            .listStyle(.insetGrouped)
            .miniPlayerInset(player.current != nil)
            .navigationTitle("Shared")
            .toolbar { toolbarContent }
            .refreshable { await load() }
            .task { await load() }
            .sheet(isPresented: $showSettings) {
                ServerSettingsView(mode: .settings)
            }
        }
    }

    // MARK: - Rows

    @ViewBuilder
    private var loadingRow: some View {
        HStack {
            Spacer()
            ProgressView("Loading…")
            Spacer()
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if direction == .incoming {
            EmptyStateView(
                symbol: "tray",
                title: "Nothing shared with you yet",
                message: "When someone sends you a song it lands here. Share your own tracks from the Library tab."
            )
        } else {
            EmptyStateView(
                symbol: "paperplane",
                title: "You have not shared anything yet",
                message: "Open a track in your Library and choose “Share with…”."
            )
        }
    }

    @ViewBuilder
    private var footer: some View {
        if direction == .incoming && !shares.isEmpty {
            Text("Play a shared song straight from the sender’s library, or copy it into your own.")
        }
    }

    private func row(_ share: Share) -> some View {
        let incoming = direction == .incoming
        let playable = incoming && share.available

        return Button {
            if playable { play(share) }
        } label: {
            ShareRow(
                share: share,
                artworkURL: (share.hasCover ?? false) ? server.api.absolute(share.cover)?.absoluteString : nil,
                isIncoming: incoming,
                isCurrent: player.current?.id == "share:" + share.id
            )
        }
        .buttonStyle(.plain)
        .disabled(!playable && incoming)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if playable {
                Button {
                    play(share)
                } label: {
                    Label("Play", systemImage: "play.fill")
                }
                .tint(.resonanceAccent)
            }
        }
        .swipeActions(edge: .trailing) {
            if incoming {
                if playable {
                    Button {
                        Task { await importShare(share) }
                    } label: {
                        Label("Save", systemImage: "arrow.down.to.line")
                    }
                    .tint(.green)
                }

                Button(role: .destructive) {
                    Task { await remove(share) }
                } label: {
                    Label("Dismiss", systemImage: "trash")
                }
            } else {
                Button(role: .destructive) {
                    Task { await remove(share) }
                } label: {
                    Label("Revoke", systemImage: "trash")
                }
            }
        }
        .contextMenu {
            if playable {
                menuButton("Play", symbol: "play.fill") { play(share) }
                menuButton("Play next", symbol: "text.line.first.and.arrowtriangle.forward") {
                    player.playNext(PlayableTrack.from(share: share, client: server.api))
                }
                menuButton("Save to my library", symbol: "arrow.down.to.line") {
                    Task { await importShare(share) }
                }
                Divider()
            }

            menuButton(incoming ? "Dismiss" : "Revoke", symbol: "trash", role: .destructive) {
                Task { await remove(share) }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .navigationBarLeading) {
            Button {
                showSettings = true
            } label: {
                Image(systemName: "slider.horizontal.3")
            }
            .accessibilityLabel("Server settings")
        }

        ToolbarItem(placement: .navigationBarTrailing) {
            Button {
                Task { await load() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .accessibilityLabel("Refresh")
        }
    }

    // MARK: - Derived state

    private var shares: [Share] {
        guard let page else { return [] }
        return direction == .incoming ? page.incoming : page.outgoing
    }

    // MARK: - Actions

    private func play(_ share: Share) {
        let tracks = shares.filter { $0.available }.map { PlayableTrack.from(share: $0, client: server.api) }
        guard let index = tracks.firstIndex(where: { $0.id == "share:" + share.id }) else { return }

        player.setQueue(tracks, startAt: index, play: true)
    }

    private func importShare(_ share: Share) async {
        await MainActor.run { busyID = share.id }

        do {
            _ = try await server.api.importShare(share.id)
            await load()
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }

        await MainActor.run { busyID = nil }
    }

    private func remove(_ share: Share) async {
        do {
            try await server.api.revokeShare(share.id)

            if player.current?.id == "share:" + share.id {
                player.removeFromQueue(at: player.index)
            }

            await load()
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    // MARK: - Data

    private func load() async {
        await MainActor.run { isLoading = true }

        do {
            let loaded = try await server.api.shares()
            await MainActor.run {
                page = loaded
                isLoading = false
                errorMessage = nil
            }
        } catch {
            await MainActor.run {
                isLoading = false
                errorMessage = error.localizedDescription
            }
        }
    }
}

/// One shared track: artwork, title, who it is from/to, and the sender’s note.
struct ShareRow: View {
    let share: Share
    let artworkURL: String?
    let isIncoming: Bool
    let isCurrent: Bool

    var body: some View {
        HStack(spacing: 12) {
            ArtworkView(urlString: artworkURL, size: 46, cornerRadius: 9)

            VStack(alignment: .leading, spacing: 2) {
                Text(share.title)
                    .font(.subheadline.weight(isCurrent ? .bold : .semibold))
                    .foregroundColor(isCurrent ? .resonanceAccent : .primary)
                    .lineLimit(1)

                Text(subtitle)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)

                if let note = share.note, !note.isEmpty {
                    Text("“\(note)”")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.85))
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 6)

            VStack(alignment: .trailing, spacing: 4) {
                Text(Format.time(share.duration))
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .monospacedDigit()

                if !share.available {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundColor(.orange)
                }
            }
        }
        .contentShape(Rectangle())
        .opacity(share.available ? 1 : 0.55)
    }

    private var subtitle: String {
        let who = isIncoming ? "from \(share.from)" : "with \(share.counterpart)"
        return [share.artist, who].compactMap { $0 }.joined(separator: " · ")
    }
}

/// Picks who to share a track with: one person, or everyone on the server.
struct ShareTargetPicker: View {
    let track: Track

    @EnvironmentObject private var server: ServerStore
    @Environment(\.dismiss) private var dismiss

    @State private var users: [UserSummary] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var confirmation: String?
    @State private var isBusy = false
    @State private var showNewName = false
    @State private var newName = ""

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }

                Section {
                    Button {
                        Task { await send(to: "*") }
                    } label: {
                        targetLabel("Everyone", detail: "anyone on this server", symbol: "person.3.fill")
                    }
                } header: {
                    Text("Share “\(track.title)”")
                } footer: {
                    Text("The song stays in your library. The other person can play it, or copy it into theirs.")
                }

                Section("Send to") {
                    if isLoading {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                    }

                    ForEach(candidates) { user in
                        Button {
                            Task { await send(to: user.name) }
                        } label: {
                            targetLabel(user.name, detail: user.summary, symbol: "person.fill")
                        }
                    }

                    Button {
                        newName = ""
                        showNewName = true
                    } label: {
                        Label("New name…", systemImage: "plus.circle")
                    }
                }
            }
            .navigationTitle("Share")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .overlay {
                if isBusy {
                    ProgressView()
                        .padding(18)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            .alert("Shared", isPresented: confirmationBinding) {
                Button("Done") { dismiss() }
            } message: {
                Text(confirmation ?? "")
            }
            .alert("New name", isPresented: $showNewName) {
                TextField("e.g. sam", text: $newName)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Cancel", role: .cancel) {}
                Button("Create and share") {
                    Task { await createAndSend() }
                }
            } message: {
                Text("Letters, digits, dots, dashes and underscores.")
            }
            .task { await loadUsers() }
        }
    }

    private func targetLabel(_ title: String, detail: String, symbol: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundColor(.resonanceAccent)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(.primary)

                Text(detail)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }

    private var candidates: [UserSummary] {
        users.filter { $0.name != server.username }
    }

    private var confirmationBinding: Binding<Bool> {
        Binding(
            get: { confirmation != nil },
            set: { if !$0 { confirmation = nil } }
        )
    }

    // MARK: - Actions

    private func loadUsers() async {
        do {
            let page = try await server.api.users()
            await MainActor.run {
                users = page.users
                isLoading = false
            }
        } catch {
            await MainActor.run {
                isLoading = false
                errorMessage = error.localizedDescription
            }
        }
    }

    private func send(to target: String) async {
        await MainActor.run { isBusy = true; errorMessage = nil }

        do {
            try await server.api.share(trackPath: track.path, to: target)
            await MainActor.run {
                isBusy = false
                confirmation = target == "*" ? "Shared with everyone." : "Shared with \(target)."
            }
        } catch {
            await MainActor.run {
                isBusy = false
                errorMessage = error.localizedDescription
            }
        }
    }

    private func createAndSend() async {
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !name.isEmpty else { return }

        await MainActor.run { isBusy = true; errorMessage = nil }

        do {
            let created = try await server.api.createUser(name)
            try await server.api.share(trackPath: track.path, to: created.name)
            await MainActor.run {
                isBusy = false
                users.append(created)
                confirmation = "Shared with \(created.name)."
            }
        } catch {
            await MainActor.run {
                isBusy = false
                errorMessage = error.localizedDescription
            }
        }
    }
}
