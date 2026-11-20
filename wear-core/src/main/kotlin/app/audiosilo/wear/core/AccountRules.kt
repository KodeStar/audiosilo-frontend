// Signing out and replacing the account, a port of targets/watch/Core/AccountRules.swift (W3
// decisions 4 and 9, carried by W4 decision 3): one account per watch, and listening not yet synced
// blocks both until it has gone or the listener explicitly discards it (Track W binding rule).
package app.audiosilo.wear.core

import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first

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

object AccountRules {
  /** What a `pair` message for `incoming` does to the watch signed in to `current`. */
  fun change(current: String?, incoming: String, unsent: Int, discard: Boolean = false): AccountChange {
    if (current == null) return AccountChange.SignIn
    if (current == incoming) return AccountChange.SameAccount
    if (unsent > 0 && !discard) return AccountChange.Blocked(unsent)
    return AccountChange.Replace
  }

  /**
   * A `pair` for the account signed in here (`SameAccount`, D6, fe#219): whether the token kept here
   * stays. Exchanged every time, each Send again left another session on the server that nothing
   * ever ended. It stays only on the server's own word that it signs in as the pair's user:
   * `meUserId` is the id a 2xx `GET /me` with it answered, null for anything else (a 401, any other
   * refusal, a body with no id, no answer). With no answer the watch may only be at an address it
   * can't reach from here, and the exchange tries the pair's own.
   */
  fun keepsToken(meUserId: Long?, userId: Long): Boolean = meUserId == userId

  /** Stopping can close one last span. Give it a send on the same tap that asked to leave. */
  suspend fun awaitSignOut(unsent: StateFlow<Int>, discard: Boolean, flush: suspend () -> Unit) {
    if (discard || unsent.value == 0) return
    flush()
    // A later Sync now or timer can finish the request while the sign-out screen is still open.
    unsent.first { it == 0 }
  }
}
