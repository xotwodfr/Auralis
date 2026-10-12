import SwiftUI

@main
struct AuralisApp: App {
  @State private var app = AppModel()
  @State private var player = PlayerModel()

  var body: some Scene {
    WindowGroup {
      Group {
        if app.client == nil { NavigationStack { ConnectView() } } else { MainView() }
      }
      .environment(app)
      .environment(player)
      .onChange(of: app.client?.credentials) { player.client = app.client }
      .task { await app.restore() }
    }
  }
}
