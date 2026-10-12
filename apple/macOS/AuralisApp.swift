import SwiftUI

@main
struct AuralisApp: App {
  @State private var app = AppModel()
  @State private var player = PlayerModel()

  var body: some Scene {
    WindowGroup {
      Group {
        if app.client == nil { ConnectView().frame(minWidth: 480, minHeight: 360) } else { MainView() }
      }
      .environment(app)
      .environment(player)
      .onChange(of: app.client?.credentials) { player.client = app.client }
      .task { await app.restore() }
    }
    .commands {
      CommandMenu("Playback") {
        Button("Play / Pause") { player.togglePlay() }.keyboardShortcut("p", modifiers: .command)
        Button("Next") { player.next() }.keyboardShortcut(.rightArrow, modifiers: .command)
        Button("Previous") { player.previous() }.keyboardShortcut(.leftArrow, modifiers: .command)
      }
    }
  }
}
