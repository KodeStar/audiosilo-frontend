package expo.modules.audiosiloplayer

import android.os.Process
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

  /** The bookmark button was pressed at (fileIndex, seconds within that file) of [book], the
   * book the engine has loaded (null when its items carry none, e.g. an older JS load).
   * [relPath] names that file by its library-relative path (null when its media id has
   * another shape). */
  fun remoteBookmark(fileIndex: Int, position: Double, book: BookRef?, relPath: String?)

  /** The engine failed (a stream that could not be read). Controllers see it stopped, not
   * failed ([AudiobookPlayer.failed]), so this is how the app hears of it. */
  fun playerFailed()

  /** Android Auto (or Automotive) connected or disconnected. */
  fun carConnection(connected: Boolean)

  /** The car asked to play a book that JS must start. */
  fun carPlayRequest(id: String)

  /** A car play JS received is over without its load: timed out, or another play took its
   * place ([replaced]: the car's tap on another book, or on the loaded book, which plays on).
   * JS must not start it any more; one [replaced] must not load either (fe#350). A play that
   * timed out is told again, [replaced], when another play is made before its load. */
  fun carPlayCancel(id: String, replaced: Boolean)

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

  /** The module's own controller: the hint AND this app's uid. The hint alone is whatever a
   * connecting app sends (any app could claim it: the effects command, completing a car play
   * with its queue, its moves never reported); the uid is the binder caller's. Media3's own
   * notification controller shares the uid but not the hint. */
  fun isAppController(controller: MediaSession.ControllerInfo?): Boolean =
    controller != null &&
      controller.uid == Process.myUid() &&
      controller.connectionHints.getBoolean(HINT_APP, false)

  /** True when the JS car controller is listening, so JS can adopt or start books. */
  val jsListening: Boolean get() = sink?.observingCar == true

  /** The car play [id] is over without the app's load. Never delivered: it is dropped here.
   * Delivered: JS is told, so a start still on its way loads paused instead of playing, or
   * loads nothing when another play [replaced] it. */
  fun cancelCarPlay(id: String, replaced: Boolean) {
    val delivered = pendingCarPlayId != id
    pendingCarPlayId = null
    val s = sink
    if (delivered && s != null && s.observingCar) s.carPlayCancel(id, replaced)
  }

  /**
   * Whether the app's load of [loaded] completes the car play waiting for [pending]. Not when
   * it is the book of the play called off before it ([calledOff]) and not the waiting one's:
   * JS was already loading that book when it was told to drop it, and loads it paused. Filled
   * with it, the waiting play would start the called-off book for a moment and lose its own
   * timeout (and its "unavailable") while its real start is still on its way. A load or a
   * snapshot item that names no book (an older JS, an older snapshot) completes it as before.
   */
  fun completesCarPlay(loaded: BookRef?, pending: BookRef?, calledOff: BookRef?): Boolean =
    loaded == null || loaded != calledOff || loaded == pending

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
