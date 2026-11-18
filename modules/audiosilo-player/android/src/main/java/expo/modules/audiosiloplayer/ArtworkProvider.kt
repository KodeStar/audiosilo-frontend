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
 * covers: browse items need a content URI it can open. The provider serves ONLY files the
 * current car snapshot names, looked up by an opaque key (a hash of the path, see
 * [CarSnapshot.artworkKey]); a URI can't name any other file, and a cover the snapshot no longer
 * names stops being served. Not exported: the service grants read access per URI to the
 * browsing controller's package (`grantUriPermission`, `android:grantUriPermissions`).
 *
 * A streamed book's cover is a server URL that carries the media token (`?token=`). Media3
 * hands an item's artwork URI to every controller and the platform session, and Android's
 * SystemUI logs the URIs it loads, so the token ended up in the device log (fe#349). Such a
 * cover goes out as `content://.../remote/<key>` instead ([shareable]): the key is a hash of the
 * URL ([RemoteArtwork]), and only the service's own bitmap loader turns it back into the URL
 * ([resolveRemote]), in this process. This provider never serves a remote key (no other app
 * may fetch with the listener's token), so another process falls back to the bitmap the
 * session sends with the metadata.
 */
class ArtworkProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw SecurityException("Read only")
    val ctx = context ?: throw FileNotFoundException(uri.toString())
    val key = uri.lastPathSegment ?: throw FileNotFoundException(uri.toString())
    val file = CarSnapshotStore.get(ctx)?.artworkByKey?.get(key)
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

    /** The content URI for a snapshot item's artwork key ([CarItem.artworkKey]), or null when
     * it has none. */
    fun uriFor(context: Context, artworkKey: String?): Uri? {
      artworkKey ?: return null
      return Uri.Builder()
        .scheme("content")
        .authority(authority(context))
        .appendPath("art")
        .appendPath(artworkKey)
        .build()
    }

    /** [raw] as an item's artwork URI may carry it: a server URL ([RemoteArtwork.isRemote])
     * as its token-free `remote` content URI, anything else (a file the app wrote) as it is. */
    fun shareable(context: Context, raw: String): String {
      if (!RemoteArtwork.isRemote(raw)) return raw
      return Uri.Builder()
        .scheme("content")
        .authority(authority(context))
        .appendPath(REMOTE)
        .appendPath(RemoteArtwork.register(raw))
        .build()
        .toString()
    }

    /** The server URL a [shareable] remote URI stands for, or null for any other URI (or a key
     * no longer held). In-process only: the service's bitmap loader. */
    fun resolveRemote(context: Context, uri: Uri): Uri? {
      if (uri.scheme != "content" || uri.authority != authority(context)) return null
      val segments = uri.pathSegments
      if (segments.size != 2 || segments[0] != REMOTE) return null
      return RemoteArtwork.urlFor(segments[1])?.let(Uri::parse)
    }

    private const val REMOTE = "remote"

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
 * The server cover URLs handed out as `remote` artwork URIs ([ArtworkProvider.shareable]), by
 * their opaque key (a SHA-256 of the URL, so the token never shows in the URI). Kept in memory:
 * only the module's own load makes a remote cover (a car play spec holds files only), and a new
 * process loads again. The last [MAX] are kept, more than one book's queue ever names (every
 * item of a book shares its cover). Pure Kotlin (unit-tested on the JVM).
 */
object RemoteArtwork {
  const val MAX = 8

  private val urls = object : LinkedHashMap<String, String>(MAX, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > MAX
  }

  /** True for a URL fetched from a server (http or https), which may carry the media token. */
  fun isRemote(raw: String): Boolean =
    raw.startsWith("https://", ignoreCase = true) || raw.startsWith("http://", ignoreCase = true)

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
