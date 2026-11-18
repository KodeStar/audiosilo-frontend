package expo.modules.audiosiloplayer

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileNotFoundException

/**
 * Serves the car's cover art (`content://${applicationId}.audiosilo.artwork/art/<key>`).
 *
 * Android Auto runs in another app (and the car head unit), so it can't read our `file://`
 * covers: browse items and the loaded book's items need a content URI it can open. The
 * provider serves ONLY files the current car snapshot names or the loaded queue's items name
 * ([LocalArtwork]), looked up by an opaque key (a hash of the path, see
 * [CarSnapshot.artworkKey]); a URI can't name any other file, and a cover neither names any
 * more stops being served. Not exported: the service grants read access per URI to the car's
 * package (`grantUriPermission`, `android:grantUriPermissions`).
 *
 * A streamed book's cover is never served here: its URL carries the media token, and no other
 * app may fetch with it. An item names it by a URI of the app's own ([RemoteArtwork]), and
 * another process shows the bitmap the session sends with the metadata.
 */
class ArtworkProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw SecurityException("Read only")
    val ctx = context ?: throw FileNotFoundException(uri.toString())
    // Only `art/<key>` ([uriString]): any other path never names a file.
    val segments = uri.pathSegments
    if (segments.size != 2 || segments[0] != ART) throw FileNotFoundException(uri.toString())
    val file = CarSnapshotStore.get(ctx)?.artworkByKey?.get(segments[1])
      ?: LocalArtwork.fileFor(segments[1])
      ?: throw FileNotFoundException(uri.toString())
    if (!isInsideAppStorage(ctx, file) || !file.isFile) throw FileNotFoundException(uri.toString())
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun getType(uri: Uri): String = "image/jpeg"

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

  companion object {
    fun authority(context: Context) = "${context.packageName}.audiosilo.artwork"

    /** The content URI for an artwork key ([CarItem.artworkKey], [LocalArtwork]) of
     * [authority]. Keys are hex, nothing to escape. */
    fun uriString(authority: String, artworkKey: String): String = "content://$authority/$ART/$artworkKey"

    /** The bundled cover a browse row shows for a book with none (Android Auto drew a warning
     * triangle for an item with no artwork). */
    const val PLACEHOLDER = "audiosilo_car_cover"

    /** A browse row's artwork: the provider's URI for its cover's [artworkKey], else the
     * bundled [PLACEHOLDER] of [packageName] (an `android.resource` URI, which the car opens
     * with no grant). */
    fun browseArtwork(authority: String, packageName: String, artworkKey: String?): String =
      artworkKey?.let { uriString(authority, it) } ?: "android.resource://$packageName/drawable/$PLACEHOLDER"

    /** [raw], a loaded item's artwork, as the item may carry it: a server URL as its token-free
     * URI ([RemoteArtwork]), a cover file the app wrote (a download's) as this provider's URI,
     * which the car can open once granted ([LocalArtwork]), anything else as it is. */
    fun itemArtwork(raw: String, authority: String): String {
      if (RemoteArtwork.isRemote(raw)) return RemoteArtwork.shareable(raw)
      val file = CarSnapshot.artworkFile(raw) ?: return raw
      return uriString(authority, LocalArtwork.register(file))
    }

    private const val ART = "art"

    /** The snapshot names files the app wrote (the car artwork folder, a download's cover), all
     * inside the app's own data directory; anything else (a crafted path) is refused. */
    private fun isInsideAppStorage(context: Context, file: File): Boolean {
      val root = context.applicationInfo.dataDir?.let { File(it).canonicalPath } ?: return false
      val path = file.canonicalPath
      return path.startsWith("$root/")
    }
  }
}

/**
 * A streamed book's cover as an item's artwork URI may name it. The cover is a server URL that
 * carries the media token (`?token=`). Media3 hands an item's artwork URI to every controller
 * and the platform session, and Android's SystemUI logs the URIs it loads, so the token ended
 * up in the device log (fe#349). The item names it as `audiosilo-artwork://remote/<key>`
 * instead ([shareable]): the key is a SHA-256 of the URL, and only the service's own bitmap
 * loader turns it back into the URL ([resolve]), in this process.
 *
 * The scheme is the app's own, which no other process can open, so the car and the lock
 * screen show the bitmap the session sends with the metadata, as they did when the item held
 * the https URL. Never a `content` URI of [ArtworkProvider], which does not serve it: the car
 * loads covers from content URIs, and one that opens the URI ahead of the bitmap would show
 * no cover.
 *
 * Kept in memory: only the module's own load makes a remote cover (a car play spec holds files
 * only), and a new process loads again. The last [MAX] are kept, more than one book's queue
 * ever names (every item of a book shares its cover). Pure Kotlin (unit-tested on the JVM).
 */
object RemoteArtwork {
  const val MAX = 8

  private const val PREFIX = "audiosilo-artwork://remote/"

  private val urls = object : LinkedHashMap<String, String>(MAX, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > MAX
  }

  /** True for a URL fetched from a server (http or https), which may carry the media token. */
  fun isRemote(raw: String): Boolean =
    raw.startsWith("https://", ignoreCase = true) || raw.startsWith("http://", ignoreCase = true)

  /** [raw] as an item's artwork URI may carry it: a server URL ([isRemote]) as its token-free
   * URI, anything else (a file the app wrote) as it is. */
  fun shareable(raw: String): String = if (isRemote(raw)) PREFIX + register(raw) else raw

  /** The server URL a [shareable] URI stands for, or null for any other URI (or a key no
   * longer held). */
  fun resolve(uri: String): String? =
    if (uri.startsWith(PREFIX)) urlFor(uri.substring(PREFIX.length)) else null

  /** Keeps [url] and returns its key. */
  @Synchronized
  fun register(url: String): String {
    val key = CarSnapshot.opaqueKey(url)
    urls[key] = url
    return key
  }

  /** The URL kept under [key], or null. */
  @Synchronized
  fun urlFor(key: String): String? = urls[key]
}

/**
 * The cover files the loaded queue's items name ([ArtworkProvider.itemArtwork]): a downloaded
 * book's own cover, which may be in no car snapshot (a book started on the phone). Android Auto
 * could not read the `file://` URI the items carried (it loads covers itself, from another
 * app); the provider serves these too, by the key the snapshot would give the same file, so the
 * car's grant for a browse row covers the playing book as well.
 *
 * Kept in memory, the last [MAX] (every item of a book shares its cover): a new process loads
 * its queue again. Pure Kotlin (unit-tested on the JVM).
 */
object LocalArtwork {
  const val MAX = 8

  private val files = object : LinkedHashMap<String, File>(MAX, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, File>?) = size > MAX
  }

  /** Keeps [file] and returns its key ([CarSnapshot.artworkKey]). */
  @Synchronized
  fun register(file: File): String {
    val key = CarSnapshot.artworkKey(file)
    files[key] = file
    return key
  }

  /** The file kept under [key], or null. */
  @Synchronized
  fun fileFor(key: String): File? = files[key]
}
