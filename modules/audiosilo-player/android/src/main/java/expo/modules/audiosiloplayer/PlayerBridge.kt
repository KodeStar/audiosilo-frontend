package expo.modules.audiosiloplayer

import androidx.media3.session.MediaSession

/**
 * What the service tells the Expo module (both live in the app's process, so a plain in-process
 * listener is enough; no session round trip). Every call happens on the main thread, the
 * session's application looper.
 */
interface PlayerEventSink {
  /** A move from outside the JS API landed at (fileIndex, seconds within that file). */
  fun remoteMove(fileIndex: Int, position: Double)

  /** A controller other than the app changed the speed; the engine already applied it. */
  fun rateChange(rate: Double)

  /** The bookmark button was pressed at (fileIndex, seconds within that file). */
  fun remoteBookmark(fileIndex: Int, position: Double)

  /** Android Auto (or Automotive) connected or disconnected. */
  fun carConnection(connected: Boolean)

  /** The car asked to play a book that JS must start. */
  fun carPlayRequest(id: String)

  /** True while JS listens for bookmarks (else the service stores them as pending). */
  val observingBookmarks: Boolean

  /** True while JS listens for car play requests: the JS car controller is running. */
  val observingCar: Boolean
}

/**
 * The in-process seam between [AudiosiloPlayerService] and [AudiosiloPlayerModule]: the module
 * registers its [sink] while it lives; the service registers itself so `setCarSnapshot` can
 * refresh what the car shows. Car events the module can't deliver yet (JS not listening) wait
 * here: the module drains them in `OnStartObserving`.
 */
object PlayerBridge {
  /** Connection hint the module's MediaController sets, so the service can tell the app's own
   * commands (the JS API) from every other controller's (lock screen, notification, headset,
   * Android Auto). Read from `ControllerInfo.connectionHints`. */
  const val HINT_APP = "audiosilo.app"

  @Volatile var sink: PlayerEventSink? = null
  @Volatile var service: AudiosiloPlayerService? = null

  /** Whether an Android Auto / Automotive controller is connected right now. */
  @Volatile var carConnected: Boolean = false

  /** The last car play request JS has not received yet (only the newest matters). */
  @Volatile var pendingCarPlayId: String? = null

  fun isAppController(controller: MediaSession.ControllerInfo?): Boolean =
    controller?.connectionHints?.getBoolean(HINT_APP, false) == true

  /** True when the JS car controller is listening, so JS can adopt or start books. */
  val jsListening: Boolean get() = sink?.observingCar == true

  fun requestCarPlay(id: String) {
    val s = sink
    if (s != null && s.observingCar) {
      pendingCarPlayId = null
      s.carPlayRequest(id)
    } else {
      pendingCarPlayId = id
    }
  }
}
