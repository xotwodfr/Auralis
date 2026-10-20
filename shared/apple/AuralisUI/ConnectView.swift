import SwiftUI

/// Sign-in (src/features/connect/Connect.tsx): one centred panel on the page background.
struct ConnectView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.tokens) private var t
  @State private var server = ""
  @State private var username = ""
  @State private var password = ""
  @State private var remember = true

  private var canSubmit: Bool { !server.isEmpty && !username.isEmpty && !password.isEmpty && !app.isConnecting }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        HStack(spacing: 10) {
          Icon("wave", size: 28).foregroundStyle(t.accent)
          Text("Auralis").font(.pageTitle).kerning(-1.08).accessibilityAddTraits(.isHeader)
        }
        Text("Connect to your Navidrome or Subsonic server.").foregroundStyle(t.text2)

        Field(label: "Server address") {
          TextField("", text: $server, prompt: Text("https://music.example.com"))
            .textContentType(.URL)
            #if os(iOS)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            #endif
        }
        Field(label: "Username") {
          TextField("", text: $username)
            .textContentType(.username)
            #if os(iOS)
            .textInputAutocapitalization(.never)
            #endif
        }
        Field(label: "Password") {
          SecureField("", text: $password).textContentType(.password).onSubmit(submit)
        }
        VStack(alignment: .leading, spacing: 4) {
          Toggle("Remember this device", isOn: $remember)
            #if os(macOS)
            .toggleStyle(.checkbox)
            #endif
          Hint("Stores your password in the Keychain. Leave off on shared computers.")
        }
        if let error = app.connectError {
          Text(error).font(.meta).foregroundStyle(t.danger)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(hex: "#ff6b00").opacity(0.1), in: .rect(cornerRadius: Metric.rThumb))
        }
        Button(action: submit) {
          Text(app.isConnecting ? "Connecting…" : "Connect").frame(maxWidth: .infinity)
        }
        .buttonStyle(.pillPrimary)
        .disabled(!canSubmit)
        .keyboardShortcut(.defaultAction)
      }
      .autocorrectionDisabled()
      .panel(padding: 32)
      .frame(maxWidth: 440)
      .padding(24)
      .frame(maxWidth: .infinity, minHeight: 520)
    }
    .background(t.bg)
  }

  private func submit() {
    guard canSubmit else { return }
    Task { await app.connect(server: server, username: username, password: password, remember: remember) }
  }
}

/// `.field`: a small label above a 44pt input.
private struct Field<Input: View>: View {
  @Environment(\.tokens) private var t
  let label: String
  @ViewBuilder let input: Input
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label).font(.meta).foregroundStyle(t.text2)
      input
        .textFieldStyle(.plain)
        .font(.body16)
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
        .background(t.bg, in: .rect(cornerRadius: Metric.rThumb))
        .overlay(RoundedRectangle(cornerRadius: Metric.rThumb).strokeBorder(t.hairline))
        .accessibilityLabel(label)
    }
  }
}
