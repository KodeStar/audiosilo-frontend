package expo.modules.audiosiloplayer

import android.content.Context
import android.net.Uri
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

// Data classes: the service compares a new snapshot with the last one it showed, so it only
// tells the car about the tabs (and the button labels) that really changed.

/** The play spec of a DOWNLOADED book: enough to start it with no JS (file URIs, no headers). */
data class CarPlaySpec(
  val book: BookRef,
  val tracks: List<TrackSpec>,
  val clips: List<ClipSpec>,
  val startIndex: Int,
  val positionInTrack: Double,
  val rate: Double,
)

data class CarItem(
  val id: String,
  val title: String,
  val subtitle: String,
  /** 0..1, null when not started. */
  val progress: Double?,
  val finished: Boolean,
  val downloaded: Boolean,
  /** A file:// URI the app wrote, or null. */
  val artwork: String?,
  val play: CarPlaySpec?,
  /** The book the item is (JS writes it on every item; null from an older snapshot). */
  val book: BookRef? = null,
) {
  /** The cover file and the opaque key the artwork provider serves it under, worked out once
   * here (a SHA-256) rather than on every browse. Derived from [artwork], so not part of equals. */
  val artworkFile: File? = CarSnapshot.artworkFile(artwork)
  val artworkKey: String? = artworkFile?.let { CarSnapshot.artworkKey(it) }
}

data class CarTab(val id: String, val title: String, val items: List<CarItem>)

/** The strings the car shows. Native has none of its own: JS localizes them. */
data class CarLabels(
  val empty: String,
  val signedOut: String,
  val unavailable: String,
  val bookmark: String,
  val bookmarkSaved: String,
)

/** The car snapshot JS writes through `setCarSnapshot` (built by `src/car/car-model.ts`). */
class CarSnapshot(
  val labels: CarLabels,
  val signedIn: Boolean,
  val tabs: List<CarTab>,
) {
  /** Artwork files this snapshot names, by the opaque key the artwork provider serves them
   * under (a hash of the path, so the URI changes when the file does). */
  val artworkByKey: Map<String, File> by lazy {
    val out = HashMap<String, File>()
    for (tab in tabs) for (item in tab.items) {
      out[item.artworkKey ?: continue] = item.artworkFile ?: continue
    }
    out
  }

  fun find(id: String): CarItem? {
    for (tab in tabs) for (item in tab.items) if (item.id == id) return item
    return null
  }

  /** The first listed book whose title holds [query] (ignoring case), Continue listening first. */
  fun findByTitle(query: String): CarItem? {
    for (tab in tabs) for (item in tab.items) if (item.title.contains(query, ignoreCase = true)) return item
    return null
  }

  /** The first Continue listening book. */
  fun firstContinue(): CarItem? = tabs.firstOrNull { it.id == "continue" }?.items?.firstOrNull()

  /** Playback resumption: the first Continue listening book with a play spec (downloaded). */
  fun resumable(): CarItem? = tabs.firstOrNull { it.id == "continue" }?.items?.firstOrNull()?.takeIf { it.play != null }

  companion object {
    fun artworkFile(uri: String?): File? {
      if (uri.isNullOrEmpty()) return null
      val parsed = Uri.parse(uri)
      val path = if (parsed.scheme == "file") parsed.path else if (parsed.scheme == null) uri else null
      return path?.let { File(it) }
    }

    private val HEX = "0123456789abcdef".toCharArray()

    /** The first 16 bytes of the path's SHA-256, as lowercase hex. */
    fun artworkKey(file: File): String {
      val digest = MessageDigest.getInstance("SHA-256").digest(file.absolutePath.toByteArray())
      val out = CharArray(32)
      for (i in 0 until 16) {
        val b = digest[i].toInt() and 0xFF
        out[2 * i] = HEX[b ushr 4]
        out[2 * i + 1] = HEX[b and 0x0F]
      }
      return String(out)
    }

    fun parse(json: String): CarSnapshot {
      val root = JSONObject(json)
      val l = root.optJSONObject("labels") ?: JSONObject()
      val labels = CarLabels(
        empty = l.optString("empty"),
        signedOut = l.optString("signedOut"),
        unavailable = l.optString("unavailable"),
        bookmark = l.optString("bookmark"),
        bookmarkSaved = l.optString("bookmarkSaved"),
      )
      val tabs = ArrayList<CarTab>()
      val tabArr = root.optJSONArray("tabs") ?: JSONArray()
      for (i in 0 until tabArr.length()) {
        val t = tabArr.optJSONObject(i) ?: continue
        val items = ArrayList<CarItem>()
        val itemArr = t.optJSONArray("items") ?: JSONArray()
        for (j in 0 until itemArr.length()) {
          val it = itemArr.optJSONObject(j) ?: continue
          parseItem(it)?.let(items::add)
        }
        tabs.add(CarTab(t.optString("id"), t.optString("title"), items))
      }
      return CarSnapshot(labels, root.optBoolean("signedIn", false), tabs)
    }

    private fun parseItem(o: JSONObject): CarItem? {
      val id = o.optString("id")
      if (id.isEmpty()) return null
      return CarItem(
        id = id,
        title = o.optString("title"),
        subtitle = o.optString("subtitle"),
        progress = if (o.isNull("progress")) null else o.optDouble("progress").takeUnless { it.isNaN() },
        finished = o.optBoolean("finished", false),
        downloaded = o.optBoolean("downloaded", false),
        artwork = if (o.isNull("artwork")) null else o.optString("artwork").ifEmpty { null },
        play = o.optJSONObject("play")?.let { parsePlay(it) },
        book = o.optJSONObject("book")?.let { parseBook(it) },
      )
    }

    private fun parseBook(b: JSONObject): BookRef? {
      val connectionId = b.optString("connectionId")
      val path = b.optString("path")
      if (connectionId.isEmpty() || path.isEmpty()) return null
      return BookRef(connectionId, b.optLong("libraryId"), path)
    }

    private fun parsePlay(o: JSONObject): CarPlaySpec? {
      val b = o.optJSONObject("book") ?: return null
      val book = BookRef(b.optString("connectionId"), b.optLong("libraryId"), b.optString("path"))
      val tracks = ArrayList<TrackSpec>()
      val tArr = o.optJSONArray("tracks") ?: return null
      for (i in 0 until tArr.length()) {
        val t = tArr.optJSONObject(i) ?: return null
        val url = t.optString("url")
        // Play specs are for downloaded books only: never stream from the car without JS (no
        // headers are stored here, and nothing outside expo-secure-store may hold a token).
        if (!url.startsWith("file:")) return null
        tracks.add(
          TrackSpec(
            id = t.optString("id"),
            url = url,
            title = t.optString("title"),
            album = t.optString("album").ifEmpty { null },
            artist = t.optString("artist").ifEmpty { null },
            artwork = if (t.isNull("artwork")) null else t.optString("artwork").ifEmpty { null },
            duration = t.optDouble("duration", 0.0).takeUnless { it.isNaN() } ?: 0.0,
          ),
        )
      }
      if (tracks.isEmpty()) return null
      val clips = ArrayList<ClipSpec>()
      val cArr = o.optJSONArray("chapters") ?: JSONArray()
      for (i in 0 until cArr.length()) {
        val c = cArr.optJSONObject(i) ?: continue
        clips.add(
          ClipSpec(
            fileIndex = c.optInt("fileIndex"),
            startInFile = c.optDouble("startInFile", 0.0),
            endInFile = c.optDouble("endInFile", 0.0),
            title = c.optString("title"),
          ),
        )
      }
      return CarPlaySpec(
        book = book,
        tracks = tracks,
        clips = clips,
        startIndex = o.optInt("startIndex", 0),
        positionInTrack = o.optDouble("positionInTrack", 0.0).takeUnless { it.isNaN() } ?: 0.0,
        rate = o.optDouble("rate", 1.0).takeUnless { it.isNaN() || it <= 0 } ?: 1.0,
      )
    }
  }
}

/**
 * Keeps the last car snapshot on disk (`filesDir/audiosilo-car-snapshot.json`) so the car shows
 * the library at once next time, even before (or without) JS running. Written atomically (a
 * temp file renamed over the old one) so a crash mid-write never leaves half a snapshot.
 *
 * Readers never wait for a write: the current snapshot is published through one volatile
 * reference, read without a lock, so the main thread (the session callbacks, the button layout)
 * and the artwork provider never block on a write's fsync. Only writers, and the one-time disk
 * read when nothing is loaded yet, take [lock] (which keeps a slow first read from publishing an
 * older snapshot over a newer write). The service preloads it off the main thread ([preload]).
 */
object CarSnapshotStore {
  private const val TAG = "AudiosiloCar"
  private const val FILE = "audiosilo-car-snapshot.json"

  /** What is loaded: null until the file was read (or written) once in this process. */
  private class Loaded(val snapshot: CarSnapshot?)

  @Volatile private var current: Loaded? = null
  private val lock = Any()

  /** Application context, set by the first component that runs in the process (the artwork
   * provider's onCreate runs before any receiver), for callers without one. */
  @Volatile var appContext: Context? = null
    private set

  fun init(context: Context) {
    if (appContext == null) appContext = context.applicationContext
  }

  /** Validates [json], writes it atomically and makes it current. Throws on invalid JSON. Not on
   * the main thread (it syncs the file). */
  fun write(context: Context, json: String) {
    init(context)
    val snapshot = CarSnapshot.parse(json)
    synchronized(lock) {
      val dir = context.filesDir
      val tmp = File(dir, "$FILE.tmp")
      FileOutputStream(tmp).use { out ->
        out.write(json.toByteArray(Charsets.UTF_8))
        out.fd.sync()
      }
      if (!tmp.renameTo(File(dir, FILE))) {
        tmp.delete()
        throw IllegalStateException("Could not save the car snapshot")
      }
      current = Loaded(snapshot)
    }
  }

  /** The current snapshot (read from disk once per process), or null when JS never wrote one. */
  fun get(context: Context): CarSnapshot? {
    current?.let { return it.snapshot }
    init(context)
    synchronized(lock) {
      current?.let { return it.snapshot }
      val loaded = Loaded(read(context))
      current = loaded
      return loaded.snapshot
    }
  }

  /** The snapshot if it is already loaded, else null; never touches the disk. */
  fun peek(): CarSnapshot? = current?.snapshot

  /** Loads the snapshot on a background thread, then runs [then] (on that thread). */
  fun preload(context: Context, then: () -> Unit) {
    val app = context.applicationContext
    Thread({
      get(app)
      then()
    }, "AudiosiloCarSnapshot").start()
  }

  private fun read(context: Context): CarSnapshot? {
    val file = File(context.filesDir, FILE)
    if (!file.exists()) return null
    return try {
      CarSnapshot.parse(file.readText(Charsets.UTF_8))
    } catch (e: Exception) {
      Log.w(TAG, "Ignoring an unreadable car snapshot", e)
      null
    }
  }
}
