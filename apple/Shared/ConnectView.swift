import SwiftUI

struct ConnectView: View {
  @Environment(AppModel.self) private var app
  @State private var server = ""
  @State private var username = ""
  @State private var password = ""

  private var canSubmit: Bool { !server.isEmpty && !username.isEmpty && !password.isEmpty && !app.isConnecting }

  var body: some View {
    Form {
      Section {
        TextField("Server address", text: $server, prompt: Text("music.example.com"))
          .textContentType(.URL)
          #if os(iOS)
          .keyboardType(.URL)
          .textInputAutocapitalization(.never)
          #endif
          .autocorrectionDisabled()
        TextField("Username", text: $username)
          .textContentType(.username)
          #if os(iOS)
          .textInputAutocapitalization(.never)
          #endif
          .autocorrectionDisabled()
        SecureField("Password", text: $password).textContentType(.password)
      } header: {
        Text("Connect to your Navidrome or Subsonic server")
      } footer: {
        if let error = app.connectError { Text(error).foregroundStyle(.red) }
      }
      Section {
        Button {
          Task { await app.connect(server: server, username: username, password: password) }
        } label: {
          if app.isConnecting { ProgressView().frame(maxWidth: .infinity) } else { Text("Connect").frame(maxWidth: .infinity) }
        }
        .buttonStyle(.glassProminent)
        .disabled(!canSubmit)
      }
    }
    .formStyle(.grouped)
    .navigationTitle("Auralis")
    .frame(maxWidth: 520)
  }
}
