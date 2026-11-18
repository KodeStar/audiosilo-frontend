package expo.modules.audiosiloplayer

import android.content.Context

/**
 * Where the engine was last heard on a book: the book, the file (by its library-relative path,
 * and its index in the engine's order) and the seconds in that file. The service keeps it on
 * disk while a book plays ([LivePlaceRecorder]), so a playback resumption after a crash or a
 * kill starts near where the book was, not at the place JS last wrote into the car snapshot
 * (written on a pause, and not at all by a cold runtime away from every server), unless JS
 * wrote a newer place since ([savedAt]). Never a DB id.
 */
data class LivePlace(
  val book: BookRef,
  /** The file's library-relative path ([MediaItems.relPathOf]); null when its item has none
   * (then [fileIndex] alone names it). */
  val relPath: String?,
  val fileIndex: Int,
  /** Seconds in that file. */
  val position: Double,
  /** When it was saved, by the device's clock (ms since the epoch; [LivePlaceRecorder] stamps
   * it). 0 for a place not saved yet. */
  val savedAt: Long = 0L,
)

/**
 * The play spec started from [live] when it is on this spec's book, newer than the spec's own
 * place, and names one of its files: by path when it has one (the spec's file order may differ
 * from the engine's), else by index. This spec as it is otherwise (null [live] included). The
 * later place wins: a live place a dead process left is older than one JS wrote since (another
 * device's listen it read, say), and a spec with no time counts as older than any live place.
 */
fun CarPlaySpec.at(live: LivePlace?): CarPlaySpec {
  if (live == null || live.book != book || savedAfter(live)) return this
  val index = if (live.relPath != null) {
    tracks.indexOfFirst { it.relPath == live.relPath }
  } else {
    live.fileIndex
  }
  if (index !in tracks.indices) return this
  return copy(startIndex = index, positionInTrack = live.position.coerceAtLeast(0.0))
}

/** JS saved this spec's place after [live] was saved, by more than [margin]; a spec with no
 * time never was. */
private fun CarPlaySpec.savedAfter(live: LivePlace, margin: Long = 0L) =
  placeSavedAt != null && placeSavedAt > live.savedAt + margin

/**
 * How much later JS's place on ANOTHER book must be to win over the engine's book
 * ([resumable]). The live place is stamped by this device's clock; JS's place may be a server's
 * time brought onto it by a measured skew (another device's listen), which is only as good as
 * the measure (JS rebuilds a spec only when its skew moves by more, `SKEW_SLACK_MS`). Inside
 * the margin the engine's book wins, as when either time is missing.
 */
const val CLOCK_MARGIN_MS = 2_000L

/**
 * What a playback resumption starts (a headset, Bluetooth or the car's play with nothing
 * loaded): the book the engine was last heard on, at that place ([LivePlace]) unless the spec's
 * own place is newer ([at]), when the snapshot lists it with a play spec (downloaded; and listed
 * for the person and the kids mode the snapshot was built for); else the book JS named
 * ([CarSnapshot.resumable]). Across books the later place wins too: when JS named another book
 * and saved its place after the live place was saved, that book resumes at its own place (a
 * dead process's book is older than the one JS played since). When either time is missing the
 * live place's book wins, as a pause in a cold runtime away from every server writes no
 * snapshot, and so does a time within the clocks' margin ([CLOCK_MARGIN_MS]). A live place
 * exists only for a book the engine still holds or held when the process died: a stop, the
 * end of the book and the app's own load of a queue drop it
 * ([LivePlaceRecorder]), so a stopped or finished book still never resumes. When JS named none
 * (a book stopped or finished here, offered before kids mode changed, or no longer the person
 * listening's), nothing resumes, whatever the engine last held.
 */
fun CarSnapshot.resumable(live: LivePlace?): CarItem? {
  val named = resumable()
  if (live == null || (namesResume && resume == null)) return named
  val namedPlay = named?.play
  val namedIsNewer = namedPlay != null && namedPlay.book != live.book && live.savedAt > 0L &&
    namedPlay.savedAfter(live, CLOCK_MARGIN_MS)
  if (namedIsNewer) return named
  for (tab in tabs) for (item in tab.items) {
    val play = item.play ?: continue
    if (play.book == live.book) return item.copy(play = play.at(live))
  }
  return named
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
  private const val KEY_SAVED_AT = "savedAt"

  fun get(context: Context): LivePlace? {
    val prefs = prefs(context)
    val connectionId = prefs.getString(KEY_CONNECTION, null) ?: return null
    val path = prefs.getString(KEY_PATH, null) ?: return null
    return LivePlace(
      book = BookRef(connectionId, prefs.getLong(KEY_LIBRARY, 0L), path),
      relPath = prefs.getString(KEY_FILE_PATH, null),
      fileIndex = prefs.getInt(KEY_FILE_INDEX, 0),
      position = prefs.getLong(KEY_POSITION_MS, 0L) / 1000.0,
      savedAt = prefs.getLong(KEY_SAVED_AT, 0L),
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
      .putLong(KEY_SAVED_AT, place.savedAt)
      .apply()
  }

  fun clear(context: Context) {
    prefs(context).edit().clear().apply()
  }

  /** Starts reading the file in the background (Android loads a prefs file on its own thread
   * once it is first asked for), so a later [get] on the main thread (a car tap, the media
   * button start's placeholder) finds it read instead of waiting on the disk. */
  fun preload(context: Context) {
    prefs(context)
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
 * [clear] write the disk, [schedule] and [unschedule] are the main looper's, [clock] stamps what
 * is saved ([LivePlace.savedAt]).
 */
internal class LivePlaceRecorder(
  private val place: () -> LivePlace?,
  private val save: (LivePlace) -> Unit,
  private val clear: () -> Unit,
  private val schedule: (Runnable, Long) -> Unit,
  private val unschedule: (Runnable) -> Unit,
  private val clock: () -> Long = System::currentTimeMillis,
) {
  /** What is on disk as far as this recorder knows, unstamped (an unchanged place is not
   * written again, and keeps the time it was first saved). */
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
    save(now.copy(savedAt = clock()))
  }

  companion object {
    /** How often a playing book's place is kept: what a crash can lose at most. */
    const val INTERVAL_MS = 10_000L
  }
}
