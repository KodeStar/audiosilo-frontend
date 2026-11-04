// The session token, in the watch's keychain (decision 12): readable after the first unlock
// (`AfterFirstUnlockThisDeviceOnly`), so a background download or sync on a locked watch can
// still authenticate, and never copied off the device. Nothing else secret is kept.
import Foundation
import Security

enum Keychain {
  private static let service = "app.audiosilo.watch.session"
  private static let account = "token"

  private static var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  static func token() -> String? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  /// Store the token (nil deletes it). Returns whether it was kept.
  @discardableResult
  static func setToken(_ token: String?) -> Bool {
    SecItemDelete(query as CFDictionary)
    guard let token else { return true }
    var q = query
    q[kSecValueData as String] = Data(token.utf8)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
  }
}
