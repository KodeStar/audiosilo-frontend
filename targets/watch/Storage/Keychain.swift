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

  /// Store the token (nil deletes it). Returns whether it was kept. An existing token is
  /// updated in place: one that could not be replaced stays, so a failed sign-in again loses
  /// nothing.
  @discardableResult
  static func setToken(_ token: String?) -> Bool {
    guard let token else {
      let status = SecItemDelete(query as CFDictionary)
      return status == errSecSuccess || status == errSecItemNotFound
    }
    let values: [String: Any] = [
      kSecValueData as String: Data(token.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let updated = SecItemUpdate(query as CFDictionary, values as CFDictionary)
    guard updated == errSecItemNotFound else { return updated == errSecSuccess }
    return SecItemAdd(query.merging(values) { _, new in new } as CFDictionary, nil) == errSecSuccess
  }
}
