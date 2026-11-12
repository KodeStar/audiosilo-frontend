// The JS bridge over WearLink.kt on Android (the iOS one is ios/AudiosiloWatchModule.swift, over
// WatchConnectivity). Its TS surface is modules/audiosilo-watch/index.ts, used only by
// src/watch/link.native.ts: the same functions and event, plus `openInstallOnWatch`.
package expo.modules.audiosilowatch

import android.util.Log
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

class AudiosiloWatchModule : Module() {
  private val context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }

  private var stopObserving: (() -> Unit)? = null

  override fun definition() = ModuleDefinition {
    Name("AudiosiloWatch")

    Events("watchState")

    // Listen from the first moment the app runs JS (the listener service covers the rest).
    OnCreate { if (WearLink.supported(context)) WearLink.start(context) }

    // One snapshot at a time, and one more for whatever changed meanwhile: a burst of changes (a
    // watch back in reach with several receipts, each seen by the service and the listener) is
    // two reads of the Data Layer, not one each. A read with no answer tells JS nothing (it keeps
    // what it has), and an event JS could not take must not end the app with this coroutine.
    OnStartObserving("watchState") {
      if (stopObserving != null) return@OnStartObserving
      val app = context.applicationContext
      val changed = Channel<Unit>(Channel.CONFLATED)
      val stop = WearLink.observe { changed.trySend(Unit) }
      val sending =
        WearLink.scope.launch {
          for (change in changed) {
            val snapshot = WearLink.snapshotOrNull(app) ?: continue
            try {
              sendEvent("watchState", snapshot)
            } catch (x: Exception) {
              Log.w("AudiosiloWatch", "watchState not sent", x)
            }
          }
        }
      stopObserving = {
        stop()
        sending.cancel()
      }
    }

    OnStopObserving("watchState") { stopWatching() }

    OnDestroy { stopWatching() }

    // Play services is here; whether a watch is reachable is the snapshot's to say.
    Function("isSupported") { WearLink.supported(context) }

    // Rejects after 5 s with no Data Layer answer (JS keeps its last answer), never hangs.
    AsyncFunction("getSnapshot") Coroutine { -> WearLink.snapshot(context) }

    // A `book` put once this answered is behind it: the watch takes the `pair` first. A refusal
    // (NoWatchException, BadMessageException, a Data Layer error) rejects; nothing was sent.
    AsyncFunction("sendPair") Coroutine { message: Map<String, Any?> -> WearLink.send(context, message) }

    AsyncFunction("sendBook") Coroutine { message: Map<String, Any?> -> WearLink.send(context, message) }

    // Shares the book's item with `sendBook`: the latest of the two for a book wins.
    AsyncFunction("sendRemove") Coroutine { message: Map<String, Any?> -> WearLink.send(context, message) }

    AsyncFunction("openInstallOnWatch") Coroutine { -> WearLink.openInstallOnWatch(context) }
  }

  private fun stopWatching() {
    stopObserving?.invoke()
    stopObserving = null
  }
}
