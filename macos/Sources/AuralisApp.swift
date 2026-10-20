import SwiftUI

@main
struct AuralisApp: App {
  @State private var app = AppModel()
  @State private var player = PlayerModel()
  @State private var settings = SettingsStore()
  @State private var router = Router()

  var body: some Scene {
    WindowGroup {
      ThemeRoot {
        Group {
          if app.client == nil { ConnectView().frame(minWidth: 520, minHeight: 560) } else { MainView() }
        }
      }
      .environment(app)
      .environment(player)
      .environment(settings)
      .environment(router)
      .onChange(of: app.client?.credentials, initial: true) { player.attach(app.client) }
      .onChange(of: settings.reportPlays, initial: true) { player.reportPlays = settings.reportPlays }
      .task { await app.restore() }
    }
    .windowToolbarStyle(.unified)
    .commands {
      CommandGroup(replacing: .appSettings) {
        Button("Settings…") { router.selection = .settings }.keyboardShortcut(",", modifiers: .command).disabled(app.client == nil)
      }
      CommandGroup(after: .textEditing) {
        Button("Search Library") { router.searchRequests += 1 }.keyboardShortcut("f", modifiers: .command).disabled(app.client == nil)
      }
      CommandMenu("Playback") {
        Button(player.isPlaying ? "Pause" : "Play") { player.togglePlay() }.keyboardShortcut("p", modifiers: .command)
        Button("Next") { player.next() }.keyboardShortcut(.rightArrow, modifiers: .command).disabled(!player.canNext)
        Button("Previous") { player.previous() }.keyboardShortcut(.leftArrow, modifiers: .command).disabled(!player.canPrevious)
        Divider()
        Button("Skip Forward 5 Seconds") { player.seek(by: PlayerModel.seekStep) }.keyboardShortcut(.rightArrow, modifiers: [.command, .option])
        Button("Skip Back 5 Seconds") { player.seek(by: -PlayerModel.seekStep) }.keyboardShortcut(.leftArrow, modifiers: [.command, .option])
        Button("Volume Up") { player.setVolume(player.volume + PlayerModel.volumeStep) }.keyboardShortcut(.upArrow, modifiers: .command)
        Button("Volume Down") { player.setVolume(player.volume - PlayerModel.volumeStep) }.keyboardShortcut(.downArrow, modifiers: .command)
        Divider()
        Toggle("Shuffle", isOn: Binding(get: { player.isShuffled }, set: { _ in player.toggleShuffle() }))
        Button("Repeat: \(player.repeatMode.rawValue.capitalized)") { player.cycleRepeat() }
        Divider()
        Button("Show Queue") { router.showQueue.toggle() }.keyboardShortcut("u", modifiers: [.command, .option]).disabled(app.client == nil)
        Button("Now Playing") { router.selection = .nowPlaying }.keyboardShortcut("l", modifiers: [.command, .option]).disabled(app.client == nil)
      }
    }
  }
}
