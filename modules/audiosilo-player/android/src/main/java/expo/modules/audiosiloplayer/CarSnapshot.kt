package expo.modules.audiosiloplayer

import android.content.Context
import android.net.Uri
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/** The play spec of a DOWNLOADED book: enough to start it with no JS (file URIs, no headers). */
class CarPlaySpec(
  val book: BookRef,
  val tracks: List<TrackSpec>,
  val clips: List<ClipSpec>,
  val startIndex: Int,
  val positionInTrack: Double,
  val rate: Double,
)

class CarItem(
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
)

class CarTab(val id: String, val title: String, val items: List<CarItem>)

/** The strings the car shows. Native has none of its own: JS localizes them. */
class CarLabels(
  val empty: String,
  val signedOut: String,
  val unavailable: String,
  val bookmark: String,
  val bookmarkSaved: String,
)

/** The car snapshot JS writes through `setCarSnapshot` (Phase 6 contract, section 3). */
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
      val file = artworkFile(item.artwork) ?: continue
      out[artworkKey(file)] = file
    }
    out
  }

  fun find(id: String): CarItem? {
    for (tab in tabs) for (item in tab.items) if (item.id == id) return item
    return null
  }

  /** Playback resumption: the first Continue listening book with a play spec (downloaded). */
  fun resumable(): CarItem? = tabs.firstOrNull { it.id == "continue" }?.items?.firstOrNull()?.takeIf { it.play != null }

  companion object {
    fun artworkFile(uri: String?): File? {
      if (uri.isNullOrEmpty()) return null
      val parsed = Uri.parse(uri)
      val path = if (parsed.scheme == "file") parsed.path else if (parsed.scheme == null) uri else null
      return path?.let { File(it) }
    }

    fun artworkKey(file: File): String {
      val digest = MessageDigest.getInstance("SHA-256").digest(file.absolutePath.toByteArray())
      return digest.take(16).joinToString("") { "%02x".format(it) }
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
      )
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
 */
object CarSnapshotStore {
  private const val TAG = "AudiosiloCar"
  private const val FILE = "audiosilo-car-snapshot.json"

  @Volatile private var cached: CarSnapshot? = null
  @Volatile private var loaded = false

  /** Application context, set by the first component that runs in the process (the artwork
   * provider's onCreate runs before any receiver), for callers without one. */
  @Volatile var appContext: Context? = null
    private set

  fun init(context: Context) {
    if (appContext == null) appContext = context.applicationContext
  }

  /** Validates [json], writes it atomically and makes it current. Throws on invalid JSON. */
  @Synchronized
  fun write(context: Context, json: String) {
    init(context)
    val snapshot = CarSnapshot.parse(json)
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
    cached = snapshot
    loaded = true
  }

  /** The current snapshot (read from disk once per process), or null when JS never wrote one. */
  @Synchronized
  fun get(context: Context): CarSnapshot? {
    init(context)
    if (loaded) return cached
    loaded = true
    val file = File(context.filesDir, FILE)
    cached = if (!file.exists()) null else try {
      CarSnapshot.parse(file.readText(Charsets.UTF_8))
    } catch (e: Exception) {
      Log.w(TAG, "Ignoring an unreadable car snapshot", e)
      null
    }
    return cached
  }
}
