import AuralisKit
import SwiftUI

/// The play queue (src/features/queue/QueuePanel.tsx): jump, reorder, remove, clear.
struct QueueView: View {
  @Environment(PlayerModel.self) private var player
  @Environment(\.tokens) private var t
  @Environment(\.dismiss) private var dismiss
  @State private var confirming = false

  private var upNext: Int { player.queue.entries.count - ((player.queue.index ?? -1) + 1) }

  var body: some View {
    let entries = player.queue.entries
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        (Text("Queue").font(.panelTitle) + Text(entries.isEmpty ? "" : " · \(upNext) up next").font(.body16).foregroundStyle(t.text2))
          .accessibilityAddTraits(.isHeader)
        Spacer()
        Button("Clear queue") { confirming = true }.buttonStyle(.pill).disabled(entries.isEmpty)
        Button { dismiss() } label: { Icon("close") }.buttonStyle(IconButtonStyle()).help("Close").accessibilityLabel("Close queue")
          .keyboardShortcut(.cancelAction)
      }
      .padding(.horizontal, 8).padding(.bottom, 8)

      if entries.isEmpty {
        EmptyState(title: "The queue is empty", hint: "Play a track, or use “Add to queue” on any track.")
      } else {
        ScrollViewReader { proxy in
          ScrollView {
            LazyVStack(spacing: 0) {
              ForEach(Array(entries.enumerated()), id: \.element.key) { i, entry in
                QueueRow(entry: entry, index: i, count: entries.count, state: rowState(i))
              }
            }
          }
          .onAppear { if let i = player.queue.index { proxy.scrollTo(entries[i].key, anchor: .center) } }
        }
      }
    }
    .padding(.top, 12).padding(.horizontal, 8).padding(.bottom, 8)
    .alert("Clear the queue?", isPresented: $confirming) {
      Button("Clear queue", role: .destructive) { player.clearQueue() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This removes every track from the queue and stops playback.")
    }
  }

  private func rowState(_ i: Int) -> QueueRow.RowState {
    guard let cur = player.queue.index else { return .upcoming }
    return i == cur ? .current : i < cur ? .played : .upcoming
  }
}

private struct QueueRow: View {
  enum RowState { case played, current, upcoming }
  @Environment(PlayerModel.self) private var player
  @Environment(\.tokens) private var t
  let entry: PlayQueue.Entry
  let index: Int
  let count: Int
  let state: RowState

  var body: some View {
    HStack(spacing: 0) {
      Button { player.jump(to: index) } label: {
        HStack(spacing: 12) {
          CoverArtView(id: entry.song.coverArt, size: 96, radius: 8).frame(width: 40, height: 40)
          VStack(alignment: .leading, spacing: 1) {
            Text(entry.song.title).font(.body16.weight(.semibold)).foregroundStyle(state == .current ? t.accent : t.text).lineLimit(1)
            Text((state == .current ? "Now playing · " : "") + entry.song.artist).font(.meta).foregroundStyle(t.text2).lineLimit(1)
          }
          Spacer(minLength: 4)
        }
        .padding(.horizontal, 8)
        .frame(height: 60)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Play \(entry.song.title)")
      Button { player.move(from: index, to: index - 1) } label: { Icon("up", size: 18) }
        .buttonStyle(IconButtonStyle()).disabled(index == 0).help("Move up").accessibilityLabel("Move \(entry.song.title) up")
      Button { player.move(from: index, to: index + 1) } label: { Icon("down", size: 18) }
        .buttonStyle(IconButtonStyle()).disabled(index == count - 1).help("Move down").accessibilityLabel("Move \(entry.song.title) down")
      Button { player.remove(at: index) } label: { Icon("trash", size: 18) }
        .buttonStyle(IconButtonStyle()).help("Remove").accessibilityLabel("Remove \(entry.song.title) from queue")
    }
    .background(state == .current ? t.hover : .clear, in: .rect(cornerRadius: Metric.rThumb))
    .opacity(state == .played ? 0.55 : 1)
    .id(entry.key)
  }
}
