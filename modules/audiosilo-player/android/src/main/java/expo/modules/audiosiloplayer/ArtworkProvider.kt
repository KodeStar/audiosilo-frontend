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
 */
class ArtworkProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    // Providers start before any receiver or service in a fresh process: hand the snapshot
    // store the app context (the media button receiver needs it, see ResumptionReceiver).
    context?.let { CarSnapshotStore.init(it) }
    return true
  }

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

    /** The content URI for a snapshot's artwork file, or null when there is none. */
    fun uriFor(context: Context, artwork: String?): Uri? {
      val file = CarSnapshot.artworkFile(artwork) ?: return null
      return Uri.Builder()
        .scheme("content")
        .authority(authority(context))
        .appendPath("art")
        .appendPath(CarSnapshot.artworkKey(file))
        .build()
    }

    /** The snapshot names files the app wrote (the car artwork folder, a download's cover), all
     * inside the app's own data directory; anything else (a crafted path) is refused. */
    private fun isInsideAppStorage(context: Context, file: File): Boolean {
      val root = context.applicationInfo.dataDir?.let { File(it).canonicalPath } ?: return false
      val path = file.canonicalPath
      return path.startsWith("$root/")
    }
  }
}
