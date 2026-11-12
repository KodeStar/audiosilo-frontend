// Signing out and replacing the account, a port of targets/watch/Core/AccountRules.swift (W3
// decisions 4 and 9, carried by W4 decision 3): one account per watch, and listening not yet synced
// blocks both until it has gone or the listener explicitly discards it (Track W binding rule).
package app.audiosilo.wear.core

sealed interface AccountChange {
  /** Nobody signed in: sign in. */
  data object SignIn : AccountChange

  /** The same `server_id.user_id` sent again: sign in afresh, keeping everything. */
  data object SameAccount : AccountChange

  /** Another account, nothing waiting (or discarded): drop this one's data, then sign in. */
  data object Replace : AccountChange

  /** Another account while events wait: not until they have gone or are discarded. */
  data class Blocked(val unsent: Int) : AccountChange
}

sealed interface SignOutGate {
  data object Allowed : SignOutGate

  data class Blocked(val unsent: Int) : SignOutGate
}

object AccountRules {
  /** What a `pair` message for `incoming` does to the watch signed in to `current`. */
  fun change(current: String?, incoming: String, unsent: Int, discard: Boolean = false): AccountChange {
    if (current == null) return AccountChange.SignIn
    if (current == incoming) return AccountChange.SameAccount
    if (unsent > 0 && !discard) return AccountChange.Blocked(unsent)
    return AccountChange.Replace
  }

  /** Whether signing out may go ahead now. */
  fun signOut(unsent: Int, discard: Boolean): SignOutGate =
    if (unsent > 0 && !discard) SignOutGate.Blocked(unsent) else SignOutGate.Allowed
}
