import SwiftUI

@main
struct AuralisApp: App {
  @State private var app = AppModel()
  @State private var player = PlayerModel()
  @State private var settings = SettingsStore()

  var body: some Scene {
    WindowGroup {
      ThemeRoot {
        Group {
          if app.client == nil { NavigationStack { ConnectView() } } else { MainView() }
        }
      }
      .environment(app)
      .environment(player)
      .environment(settings)
      .onChange(of: app.client?.credentials, initial: true) { player.attach(app.client) }
      .onChange(of: settings.reportPlays, initial: true) { player.reportPlays = settings.reportPlays }
      .task { await app.restore() }
    }
  }
}
