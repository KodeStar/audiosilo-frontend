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
  /// Nothing kept here reads yet (before the watch's first unlock): `current` says nobody whoever
  /// is signed in, so nothing is decided (no account forgotten, no listening discarded). The pair
  /// waits until it reads (fe#216).
  case wait
}

enum SignOutGate: Equatable {
  case allowed
  case blocked(unsent: Int)
}

enum AccountRules {
  /// What a `pair` message for `incoming` does to the watch signed in to `current`. `readable`:
  /// whether what is kept here has been read (`current` and `unsent` are guesses until it has).
  static func change(current: String?, incoming: String, unsent: Int, discard: Bool = false,
                     readable: Bool = true) -> AccountChange {
    guard readable else { return .wait }
    guard let current else { return .signIn }
    if current == incoming { return .sameAccount }
    if unsent > 0 && !discard { return .blocked(unsent: unsent) }
    return .replace
  }

  /// A `pair` for the account signed in here (`.sameAccount`, D6, fe#219): whether the token kept
  /// here stays. Exchanged every time, each Send again left another session on the server that
  /// nothing ever ended. It stays only on the server's own word that it signs in as the pair's
  /// user: `meUserId` is the id a 2xx `GET /me` with it answered, nil for anything else (a 401,
  /// any other refusal, a body with no id, no answer). With no answer the watch may only be at an
  /// address it can't reach from here, and the exchange tries the pair's own.
  static func keepsToken(meUserId: Int?, userId: Int) -> Bool {
    meUserId == userId
  }

  /// Whether signing out may go ahead now.
  static func signOut(unsent: Int, discard: Bool) -> SignOutGate {
    unsent > 0 && !discard ? .blocked(unsent: unsent) : .allowed
  }
}
