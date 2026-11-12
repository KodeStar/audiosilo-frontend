// The debug sign-in (debug builds only; src/release has an empty stand-in that R8 removes). The
// emulator has no AudioSilo phone to send `pair`, so intent extras stand in for the phone's items:
//
//   adb -s <wear> shell am start -n app.audiosilo/app.audiosilo.wear.MainActivity \
//     --es debug_pair "$(node scripts/watch-debug-pair.mjs <server> <user> <password>)"
//
// - `debug_pair`: a v1 `pair` message as JSON, signed in to as if the phone had sent it (ignored
//   when already signed in to that account). scripts/watch-debug-pair.mjs mints one.
// - `debug_book`: a v1 `book` message as JSON, taken as if the phone had sent it.
// - `debug_remove`: a v1 `remove` message as JSON, taken the same way.
// - `debug_play` (`--es debug_play 1`): play the first book on the watch once the rest is done.
package app.audiosilo.wear.debug

import android.content.Intent
import android.util.Log
import app.audiosilo.wear.AppModel
import app.audiosilo.wear.core.PhoneMessage
import app.audiosilo.wear.core.PhoneMessages
import app.audiosilo.wear.core.WatchStateBook
import kotlinx.coroutines.launch

object DebugSignIn {
  const val PAIR = "debug_pair"
  const val BOOK = "debug_book"
  const val REMOVE = "debug_remove"
  const val PLAY = "debug_play"

  fun handle(model: AppModel, intent: Intent?) {
    val extras = intent?.extras ?: return
    val pairJson = extras.getString(PAIR)
    val book = extras.getString(BOOK)?.let(PhoneMessages::decodeJSON)
    val remove = extras.getString(REMOVE)?.let(PhoneMessages::decodeJSON)
    val play = extras.getString(PLAY) in setOf("1", "true")
    // Taken once: a rotation or a return to this intent does not send them again.
    for (k in listOf(PAIR, BOOK, REMOVE, PLAY)) intent.removeExtra(k)
    var pair: PhoneMessage.Pair? = null
    if (!pairJson.isNullOrEmpty()) {
      val m = PhoneMessages.decodeJSON(pairJson)
      if (m !is PhoneMessage.Pair) {
        Log.w(TAG, "$PAIR is not a v1 pair message")
        model.showSetupProblem("$PAIR is not a v1 pair message.")
        return
      }
      if (model.account.value?.accountId != m.message.accountId) pair = m
    }
    model.scope.launch {
      pair?.let { model.receive(it) }
      book?.let { model.receive(it) }
      remove?.let { model.receive(it) }
      if (play) {
        model.downloads.records.value.firstOrNull { it.state == WatchStateBook.State.READY }?.let { model.play(it) }
      }
    }
  }

  private const val TAG = "AudioSiloDebug"
}
