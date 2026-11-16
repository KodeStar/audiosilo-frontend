// Signing out and replacing the account (decisions 4 and 9): one account per watch, and
// listening not yet synced blocks both until it has gone or the listener explicitly discards
// it (Track W binding rule).
import Foundation

enum AccountChange: Equatable {
  /// Nobody signed in: sign in.
  case signIn
  /// The same `server_id.user_id` sent again: sign in afresh, keeping everything.
  case sameAccount
  /// Another account, nothing waiting (or discarded): drop this one's data, then sign in.
  case replace
  /// Another account while events wait: not until they have gone or are discarded.
  case blocked(unsent: Int)
}

enum SignOutGate: Equatable {
  case allowed
  case blocked(unsent: Int)
}

enum AccountRules {
  /// What a `pair` message for `incoming` does to the watch signed in to `current`.
  static func change(current: String?, incoming: String, unsent: Int, discard: Bool = false) -> AccountChange {
    guard let current else { return .signIn }
    if current == incoming { return .sameAccount }
    if unsent > 0 && !discard { return .blocked(unsent: unsent) }
    return .replace
  }

  /// A `pair` for the account signed in here (`.sameAccount`, D6, fe#219): whether the token kept
  /// here stays, by what `GET /me` with it answered (`meStatus`, nil for no answer). Exchanged every
  /// time, each Send again left another session on the server that nothing ever ended. Only a 401
  /// says the token no longer signs in; with no answer the exchange would fail too.
  static func keepsToken(meStatus: Int?) -> Bool {
    meStatus != 401
  }

  /// Whether signing out may go ahead now.
  static func signOut(unsent: Int, discard: Bool) -> SignOutGate {
    unsent > 0 && !discard ? .blocked(unsent: unsent) : .allowed
  }
}
