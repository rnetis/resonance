import Foundation
import SwiftUI
import UIKit

/// Full-screen player: artwork, transport, seek, volume and the queue.
struct NowPlayingView: View {
    @EnvironmentObject private var player: AudioEngine
    @Environment(\.dismiss) private var dismiss

    @State private var scrubValue: Double = 0
    @State private var isScrubbing = false
    @State private var showQueue = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    artwork
                    titles
                    seekBar
                    transport
                    volumeRow
                    sourceRow

                    if showQueue {
                        queueSection
                    }
                }
                .padding(.horizontal, 22)
                .padding(.bottom, 30)
            }
            .background(
                LinearGradient(
                    colors: [Color(red: 0.12, green: 0.11, blue: 0.20), Color(red: 0.04, green: 0.04, blue: 0.07)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()
            )
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.down")
                    }
                }

                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text("NOW PLAYING")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(.secondary)
                        Text(player.current?.isLocal == true ? "Offline copy" : "Streaming")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }

                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        withAnimation { showQueue.toggle() }
                    } label: {
                        Image(systemName: "list.bullet")
                    }
                }
            }
            .onAppear { scrubValue = player.position }
            .onChange(of: player.position) { value in
                if !isScrubbing { scrubValue = value }
            }
        }
    }

    // MARK: - Pieces

    private var artwork: some View {
        ArtworkView(
            urlString: player.current?.artworkURLString,
            size: artworkSize,
            cornerRadius: 18
        )
        .shadow(color: .black.opacity(0.5), radius: 24, y: 12)
        .padding(.top, 8)
    }

    private var artworkSize: CGFloat {
        let width = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first?.screen.bounds.width ?? 390

        return min(max(width - 80, 200), 330)
    }

    private var titles: some View {
        VStack(spacing: 4) {
            Text(player.current?.title ?? "Nothing playing")
                .font(.title3.weight(.bold))
                .multilineTextAlignment(.center)
                .lineLimit(2)

            Text(player.current?.subtitle ?? "")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .lineLimit(1)
        }
    }

    private var seekBar: some View {
        VStack(spacing: 2) {
            Slider(
                value: $scrubValue,
                in: 0...max(player.duration, 1),
                onEditingChanged: { editing in
                    isScrubbing = editing
                    if !editing {
                        player.seek(to: scrubValue)
                    }
                }
            )
            .tint(.resonanceAccent)

            HStack {
                Text(Format.time(isScrubbing ? scrubValue : player.position))
                Spacer()
                Text(Format.time(player.duration))
            }
            .font(.caption2)
            .foregroundColor(.secondary)
            .monospacedDigit()
        }
    }

    private var transport: some View {
        HStack(spacing: 26) {
            Button {
                player.isShuffled.toggle()
            } label: {
                Image(systemName: "shuffle")
                    .font(.system(size: 18))
                    .foregroundColor(player.isShuffled ? .resonanceAccent : .secondary)
            }

            Button {
                player.previous()
            } label: {
                Image(systemName: "backward.fill")
                    .font(.system(size: 26))
            }

            Button {
                player.togglePlay()
            } label: {
                Image(systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 68))
                    .foregroundColor(.resonanceAccent)
            }

            Button {
                player.next()
            } label: {
                Image(systemName: "forward.fill")
                    .font(.system(size: 26))
            }
            .disabled(player.queue.isEmpty)

            Button {
                player.repeatMode = nextRepeatMode
            } label: {
                Image(systemName: player.repeatMode.symbolName)
                    .font(.system(size: 18))
                    .foregroundColor(player.repeatMode == .off ? .secondary : .resonanceAccent)
            }
        }
        .buttonStyle(.plain)
        .padding(.vertical, 4)
    }

    private var nextRepeatMode: AudioEngine.RepeatMode {
        switch player.repeatMode {
        case .off: return .all
        case .all: return .one
        case .one: return .off
        }
    }

    private var volumeRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "speaker.fill")
                .foregroundColor(.secondary)
                .font(.caption)

            Slider(value: $player.volume, in: 0...1)
                .tint(.resonanceAccent)

            Image(systemName: "speaker.wave.3.fill")
                .foregroundColor(.secondary)
                .font(.caption)
        }
    }

    private var sourceRow: some View {
        VStack(spacing: 4) {
            if let path = player.current?.trackPath {
                Text(path)
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var queueSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Queue")
                    .font(.headline)
                Spacer()
                Text("\(player.queue.count) tracks")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Button("Clear") { player.clearQueue() }
                    .font(.caption)
            }

            ForEach(Array(player.queue.enumerated()), id: \.offset) { position, track in
                HStack(spacing: 10) {
                    Image(systemName: position == player.index ? "speaker.wave.2.fill" : "music.note")
                        .font(.caption)
                        .foregroundColor(position == player.index ? .resonanceAccent : .secondary)
                        .frame(width: 18)

                    VStack(alignment: .leading, spacing: 1) {
                        Text(track.title)
                            .font(.subheadline)
                            .lineLimit(1)
                        Text(track.subtitle)
                            .font(.caption2)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }

                    Spacer()

                    Text(Format.time(track.duration))
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
                .contentShape(Rectangle())
                .onTapGesture { player.jump(to: position) }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        player.removeFromQueue(at: position)
                    } label: {
                        Label("Remove", systemImage: "trash")
                    }
                }
            }
        }
        .padding(.top, 10)
    }
}
