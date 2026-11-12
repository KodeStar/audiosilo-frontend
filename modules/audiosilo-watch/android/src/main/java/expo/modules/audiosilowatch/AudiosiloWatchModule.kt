// The JS bridge over WearLink.kt on Android (the iOS one is ios/AudiosiloWatchModule.swift, over
// WatchConnectivity). Its TS surface is modules/audiosilo-watch/index.ts, used only by
// src/watch/link.native.ts: the same functions and event, plus `openInstallOnWatch`.
package expo.modules.audiosilowatch

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
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

    OnStartObserving("watchState") {
      if (stopObserving != null) return@OnStartObserving
      stopObserving = WearLink.observe {
        WearLink.scope.launch { sendEvent("watchState", WearLink.snapshot(context)) }
      }
    }

    OnStopObserving("watchState") { stopWatching() }

    OnDestroy { stopWatching() }

    // Play services is here; whether a watch is reachable is the snapshot's to say.
    Function("isSupported") { WearLink.supported(context) }

    // Answers "no watch" after 5 s with no Data Layer answer, never hangs.
    AsyncFunction("getSnapshot") { promise: Promise ->
      WearLink.scope.launch { promise.resolve(WearLink.snapshot(context)) }
    }

    // A `book` put once this answered is behind it: the watch takes the `pair` first.
    AsyncFunction("sendPair") { message: Map<String, Any?>, promise: Promise -> send(message, promise) }

    AsyncFunction("sendBook") { message: Map<String, Any?>, promise: Promise -> send(message, promise) }

    // Shares the book's item with `sendBook`: the latest of the two for a book wins.
    AsyncFunction("sendRemove") { message: Map<String, Any?>, promise: Promise -> send(message, promise) }

    AsyncFunction("openInstallOnWatch") { promise: Promise ->
      WearLink.scope.launch {
        try {
          WearLink.openInstallOnWatch(context)
          promise.resolve(null)
        } catch (e: Exception) {
          promise.reject("ERR_NO_WATCH", "Could not open Google Play on the watch", e)
        }
      }
    }
  }

  private fun stopWatching() {
    stopObserving?.invoke()
    stopObserving = null
  }

  private fun send(message: Map<String, Any?>, promise: Promise) {
    WearLink.scope.launch {
      try {
        WearLink.send(context, message)
        promise.resolve(null)
      } catch (e: BadMessageException) {
        promise.reject("ERR_BAD_MESSAGE", "The message is not one the watch takes", e)
      } catch (e: Exception) {
        promise.reject("ERR_NO_WATCH", "No paired watch with the app installed", e)
      }
    }
  }
}
