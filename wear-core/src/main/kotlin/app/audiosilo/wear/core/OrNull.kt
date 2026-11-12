// "Try it; anything that goes wrong is no answer": the shape of every quiet request the watch
// makes (a probe, a refresh, a logout). A cancel is never swallowed: it ends the caller too.
package app.audiosilo.wear.core

import kotlinx.coroutines.CancellationException

/** `block`'s value, or null when it throws anything but a cancel (which is thrown on). */
inline fun <T> orNull(block: () -> T): T? =
  try {
    block()
  } catch (e: CancellationException) {
    throw e
  } catch (_: Exception) {
    null
  }
