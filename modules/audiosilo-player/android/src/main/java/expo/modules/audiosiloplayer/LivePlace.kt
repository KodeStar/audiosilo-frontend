package expo.modules.audiosiloplayer

import android.content.Context

/**
 * Where the engine was last heard on a book: the book, the file (by its library-relative path,
 * and its index in the engine's order) and the seconds in that file. The service keeps it on
 * disk while a book plays ([LivePlaceRecorder]), so a playback resumption after a crash or a
 * kill starts near where the book was, not at the place JS last wrote into the car snapshot
 * (written on a pause, and not at all by a cold runtime away from every server). Never a DB id.
 */
data class LivePlace(
  val book: BookRef,
  /** The file's library-relative path ([LoadedFiles.pathOf]); null when its media id has
   * another shape (then [fileIndex] alone names it). */
  val relPath: String?,
  val fileIndex: Int,
  /** Seconds in that file. */
  val position: Double,
)

/**
 * The play spec started from [live] when it is on this spec's book and names one of its files: by
 * path when it has one (the spec's file order may differ from the engine's), else by index. This
 * spec as it is otherwise (null [live] included).
 */
fun CarPlaySpec.at(live: LivePlace?): CarPlaySpec {
  if (live == null || live.book != book) return this
  val index = if (live.relPath != null) {
    tracks.indexOfFirst { LoadedFiles.pathOf(it.id, clip = false) == live.relPath }
  } else {
    live.fileIndex
  }
  if (index !in tracks.indices) return this
  return copy(startIndex = index, positionInTrack = live.position.coerceAtLeast(0.0))
}

/**
 * What a playback resumption starts (a headset, Bluetooth or the car's play with nothing
 * loaded): the book the engine was last heard on, at that place ([LivePlace]), when the snapshot
 * lists it with a play spec (downloaded; and listed for the person and the kids mode the
 * snapshot was built for); else the book JS named ([CarSnapshot.resumable]). A live place exists
 * only for a book the engine still holds or held when the process died: a stop, the end of the
 * book and the app's own load of a queue drop it ([LivePlaceRecorder]), so a stopped or finished
 * book still never resumes. When JS named none (a book stopped or finished here, offered before
 * kids mode changed, or no longer the person listening's), nothing resumes, whatever the
 * engine last held.
 */
fun CarSnapshot.resumable(live: LivePlace?): CarItem? {
  if (live != null && !(namesResume && resume == null)) {
    for (tab in tabs) for (item in tab.items) {
      val play = item.play ?: continue
      if (play.book == live.book) return item.copy(play = play.at(live))
    }
  }
  return resumable()
}

/** The live place on disk, in a prefs file of its own: it is rewritten every
 * [LivePlaceRecorder.INTERVAL_MS] while a book plays, and the player's shared prefs
 * ([AudiosiloPlayerService.PREFS], with the pending bookmarks) would be rewritten whole each time. */
object LivePlaceStore {
  private const val PREFS = "audiosilo.liveplace"
  private const val KEY_CONNECTION = "connectionId"
  private const val KEY_LIBRARY = "libraryId"
  private const val KEY_PATH = "path"
  private const val KEY_FILE_PATH = "relPath"
  private const val KEY_FILE_INDEX = "fileIndex"
  private const val KEY_POSITION_MS = "positionMs"

  fun get(context: Context): LivePlace? {
    val prefs = prefs(context)
    val connectionId = prefs.getString(KEY_CONNECTION, null) ?: return null
    val path = prefs.getString(KEY_PATH, null) ?: return null
    return LivePlace(
      book = BookRef(connectionId, prefs.getLong(KEY_LIBRARY, 0L), path),
      relPath = prefs.getString(KEY_FILE_PATH, null),
      fileIndex = prefs.getInt(KEY_FILE_INDEX, 0),
      position = prefs.getLong(KEY_POSITION_MS, 0L) / 1000.0,
    )
  }

  /** Written asynchronously (`apply`): the service saves it from the main thread. */
  fun save(context: Context, place: LivePlace) {
    prefs(context).edit()
      .putString(KEY_CONNECTION, place.book.connectionId)
      .putLong(KEY_LIBRARY, place.book.libraryId)
      .putString(KEY_PATH, place.book.path)
      .putString(KEY_FILE_PATH, place.relPath)
      .putInt(KEY_FILE_INDEX, place.fileIndex)
      .putLong(KEY_POSITION_MS, (place.position * 1000).toLong())
      .apply()
  }

  fun clear(context: Context) {
    prefs(context).edit().clear().apply()
  }

  private fun prefs(context: Context) =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}

/**
 * Keeps the [LivePlace] current from the player's events (the service's main thread): every
 * [INTERVAL_MS] while it plays, and at once when it starts or stops playing (a pause, a stall,
 * the stop before the app replaces a queue) and on a seek. Dropped when the book ends, when the
 * player is emptied (a stop: JS's `reset`) and when the app loads a queue (a book the app loads
 * is the one the snapshot names, at the place JS gave it, until it plays or moves).
 *
 * The engine is reached through functions so the timing is tested on the JVM: [place] reads
 * where the player is (null with nothing loaded, an ended book or no book named), [save] and
 * [clear] write the disk, [schedule] and [unschedule] are the main looper's.
 */
internal class LivePlaceRecorder(
  private val place: () -> LivePlace?,
  private val save: (LivePlace) -> Unit,
  private val clear: () -> Unit,
  private val schedule: (Runnable, Long) -> Unit,
  private val unschedule: (Runnable) -> Unit,
) {
  /** What is on disk as far as this recorder knows (an unchanged place is not written again). */
  private var saved: LivePlace? = null
  private var cleared = false

  private val tick = object : Runnable {
    override fun run() {
      record()
      schedule(this, INTERVAL_MS)
    }
  }

  fun onIsPlayingChanged(playing: Boolean) {
    unschedule(tick)
    record()
    if (playing) schedule(tick, INTERVAL_MS)
  }

  fun onSeek() = record()

  /** The book ended, the player was emptied or the app loaded a queue. */
  fun drop() {
    unschedule(tick)
    if (cleared) return
    saved = null
    cleared = true
    clear()
  }

  private fun record() {
    val now = place() ?: return
    if (now == saved) return
    saved = now
    cleared = false
    save(now)
  }

  companion object {
    /** How often a playing book's place is kept: what a crash can lose at most. */
    const val INTERVAL_MS = 10_000L
  }
}
