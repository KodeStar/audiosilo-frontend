// The one account this watch is signed in to (decision 4): which server and user, and its
// addresses. The token is in the keychain (Keychain.swift), never here.
import Foundation

struct Account: Codable, Equatable {
  var serverId: String
  var serverName: String
  var userId: Int
  var userName: String
  /// The paired URL (the phone connection's).
  var serverURL: String
  var addresses: ServerAddresses?
  var signedInAt: Date

  /// `<server_id>.<user_id>`, the phone's connection id for the same account.
  var accountId: String { accountIdOf(serverId: serverId, userId: userId) }

  private static let file = JSONFile<Account>(url: Files.account)

  static func load() -> Account? { file.read() }
  static func save(_ account: Account?) { file.write(account) }
}

/// The server's last `/server` answer, kept so the gate holds offline.
enum ServerCache {
  private static let file = JSONFile<ServerInfo>(url: Files.server)
  static func load() -> ServerInfo? { file.read() }
  static func save(_ info: ServerInfo?) { file.write(info) }
}
