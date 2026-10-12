import Foundation
import Security

/// The Subsonic password lives in the Keychain; server URL and username are plain UserDefaults.
enum Keychain {
  private static let service = "app.auralis.subsonic"

  private static func query(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  static func save(_ password: String, account: String) {
    SecItemDelete(query(account) as CFDictionary)
    var item = query(account)
    item[kSecValueData as String] = Data(password.utf8)
    SecItemAdd(item as CFDictionary, nil)
  }

  static func load(account: String) -> String? {
    var q = query(account)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func delete(account: String) { SecItemDelete(query(account) as CFDictionary) }
}
