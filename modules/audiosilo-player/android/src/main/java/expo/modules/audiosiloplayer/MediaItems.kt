package expo.modules.audiosiloplayer

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player

/** A book's identity (path is the identity, scoped by connection; never a DB id). */
data class BookRef(val connectionId: String, val libraryId: Long, val path: String)

/** One audio file of a queue, the plain-Kotlin twin of the JS `NativeTrack` (the module's
 * `TrackRecord` and the car snapshot's play spec both map onto it). */
data class TrackSpec(
  val id: String,
  val url: String,
  val title: String,
  val album: String?,
  val artist: String?,
  val artwork: String?,
  /** Seconds, 0 when unknown. */
  val duration: Double,
)

/** One chapter clip, the twin of the JS `NativeChapter` (`endInFile <= 0` = to the file's end). */
data class ClipSpec(
  val fileIndex: Int,
  val startInFile: Double,
  val endInFile: Double,
  val title: String,
)

/** A queue ready for `setMediaItems(items, index, positionMs)`. */
class BuiltQueue(val items: List<MediaItem>, val index: Int, val positionMs: Long)

/**
 * Builds the engine's media items, for the module's `load` AND for a queue the service starts
 * itself (the car, playback resumption), so both produce the same items.
 *
 * Every item carries its FILE mapping (and the book) in `MediaMetadata.extras`. The module used
 * to keep that mapping only in memory from its own `load`, so a queue the SERVICE loaded (Android
 * Auto with no JS running) reported clip-relative positions as if they were file positions. Now
 * the module rebuilds its [TimelineMap] from the controller's timeline instead (on connect and on
 * every timeline change), and the service reads the same extras to report remote moves and
 * bookmarks in file coordinates. Extras survive the session -> controller hop
 * (`MediaMetadata.toBundle` includes them).
 */
object MediaItems {
  const val KEY_FILE_INDEX = "audiosilo.fileIndex"
  const val KEY_START_IN_FILE = "audiosilo.startInFile"
  const val KEY_END_IN_FILE = "audiosilo.endInFile"
  const val KEY_FILE_DURATION = "audiosilo.fileDuration"
  const val KEY_CLIP = "audiosilo.clip"
  const val KEY_CONNECTION = "audiosilo.book.connectionId"
  const val KEY_LIBRARY = "audiosilo.book.libraryId"
  const val KEY_PATH = "audiosilo.book.path"
  /** The book's title (a track's `title` is the book's; a clip's item title is the chapter's),
   * used as the playlist (queue) title the car shows above the chapter list. */
  const val KEY_BOOK_TITLE = "audiosilo.book.title"

  /**
   * The queue for one book: chapter clips when [clips] is non-empty (the lock screen gets a
   * chapter scrubber and prev/next chapter), else one item per file. The start position is
   * given in FILE coordinates and mapped onto the clip that holds it.
   */
  fun buildQueue(
    tracks: List<TrackSpec>,
    clips: List<ClipSpec>,
    book: BookRef?,
    startIndex: Int,
    positionInTrack: Double,
  ): BuiltQueue {
    if (tracks.isEmpty()) return BuiltQueue(emptyList(), 0, 0L)
    val items: List<MediaItem>
    val itemIndex: Int
    val itemPosMs: Long
    if (clips.isNotEmpty()) {
      items = clips.map { toClipItem(it, tracks, book) }
      val (idx, ms) = TimelineMap(clips.map { entryFor(it, tracks) }).fileToItem(startIndex, positionInTrack)
      itemIndex = idx
      itemPosMs = ms
    } else {
      items = tracks.mapIndexed { i, t -> toMediaItem(t, i, book) }
      itemIndex = startIndex
      itemPosMs = (positionInTrack * 1000).toLong().coerceAtLeast(0L)
    }
    return BuiltQueue(items, itemIndex.coerceIn(0, maxOf(0, items.size - 1)), itemPosMs)
  }

  /** A whole-file item (a multi-file book without chapter clips). */
  fun toMediaItem(t: TrackSpec, fileIndex: Int, book: BookRef?): MediaItem {
    val metadata = MediaMetadata.Builder()
      .setTitle(t.title)
      .setArtist(t.artist ?: "")
      .setAlbumTitle(t.album ?: t.title)
      .setExtras(extras(fileIndex, 0.0, 0.0, t.duration, clip = false, book = book, title = t.title))
      .apply { t.artwork?.let { setArtworkUri(Uri.parse(it)) } }
      .build()
    return MediaItem.Builder()
      .setUri(t.url)
      .setMediaId(t.id)
      .setMediaMetadata(metadata)
      .build()
  }

  /** A clipped item for one chapter: the file's URL clipped to the chapter's in-file range,
   * titled with the chapter (so the lock screen and the car's queue show the chapter). */
  fun toClipItem(clip: ClipSpec, tracks: List<TrackSpec>, book: BookRef?): MediaItem {
    val t = tracks.getOrNull(clip.fileIndex) ?: tracks.first()
    val title = clip.title.ifEmpty { t.title }
    val metadata = MediaMetadata.Builder()
      .setTitle(title)
      .setArtist(t.artist ?: "")
      .setAlbumTitle(t.album ?: t.title)
      .setExtras(
        extras(clip.fileIndex, clip.startInFile, clip.endInFile, t.duration, clip = true, book = book, title = t.title),
      )
      .apply { t.artwork?.let { setArtworkUri(Uri.parse(it)) } }
      .build()
    val clipping = MediaItem.ClippingConfiguration.Builder()
      .setStartPositionMs((clip.startInFile * 1000).toLong())
      .apply { if (clip.endInFile > 0) setEndPositionMs((clip.endInFile * 1000).toLong()) }
      .build()
    return MediaItem.Builder()
      .setUri(t.url)
      .setMediaId("${t.id}#${clip.startInFile}")
      .setMediaMetadata(metadata)
      .setClippingConfiguration(clipping)
      .build()
  }

  private fun extras(
    fileIndex: Int,
    startInFile: Double,
    endInFile: Double,
    fileDuration: Double,
    clip: Boolean,
    book: BookRef?,
    title: String,
  ) = Bundle().apply {
    putInt(KEY_FILE_INDEX, fileIndex)
    putDouble(KEY_START_IN_FILE, startInFile)
    putDouble(KEY_END_IN_FILE, endInFile)
    putDouble(KEY_FILE_DURATION, fileDuration)
    putBoolean(KEY_CLIP, clip)
    putString(KEY_BOOK_TITLE, title)
    if (book != null) {
      putString(KEY_CONNECTION, book.connectionId)
      putLong(KEY_LIBRARY, book.libraryId)
      putString(KEY_PATH, book.path)
    }
  }

  private fun entryFor(clip: ClipSpec, tracks: List<TrackSpec>) = TimelineMap.Entry(
    fileIndex = clip.fileIndex,
    startInFile = clip.startInFile,
    endInFile = clip.endInFile,
    fileDuration = tracks.getOrNull(clip.fileIndex)?.duration ?: 0.0,
    clip = true,
  )

  /** The mapping entry an item carries, or null for an item without our extras. */
  fun entryOf(item: MediaItem?): TimelineMap.Entry? {
    val e = item?.mediaMetadata?.extras ?: return null
    if (!e.containsKey(KEY_FILE_INDEX)) return null
    return TimelineMap.Entry(
      fileIndex = e.getInt(KEY_FILE_INDEX),
      startInFile = e.getDouble(KEY_START_IN_FILE),
      endInFile = e.getDouble(KEY_END_IN_FILE),
      fileDuration = e.getDouble(KEY_FILE_DURATION),
      clip = e.getBoolean(KEY_CLIP),
    )
  }

  /** The book title an item carries (else its album title), for the playlist metadata. */
  fun bookTitleOf(item: MediaItem?): CharSequence? =
    item?.mediaMetadata?.extras?.getString(KEY_BOOK_TITLE) ?: item?.mediaMetadata?.albumTitle

  /** The book an item belongs to, or null (an item loaded without a book, e.g. an older JS). */
  fun bookOf(item: MediaItem?): BookRef? {
    val e = item?.mediaMetadata?.extras ?: return null
    val connection = e.getString(KEY_CONNECTION) ?: return null
    val path = e.getString(KEY_PATH) ?: return null
    return BookRef(connection, e.getLong(KEY_LIBRARY), path)
  }
}

/** Every item of the player's queue, in order. */
fun Player.mediaItems(): List<MediaItem> = List(mediaItemCount) { getMediaItemAt(it) }

/**
 * Translates between the media items the engine plays and the FILE-based timeline the JS store
 * works in. The store thinks in (fileIndex, positionInFile); each engine item is one chapter clip
 * or one whole file. Built from each item's extras ([MediaItems.entryOf]), so it is right for a
 * queue the module loaded and for one the service loaded. Pure Kotlin (unit-tested on the JVM).
 */
class TimelineMap(val entries: List<Entry>) {
  data class Entry(
    val fileIndex: Int,
    /** Seconds; 0 for a whole-file item. */
    val startInFile: Double,
    /** Seconds; <= 0 means to the end of the file. */
    val endInFile: Double,
    /** The FILE's duration in seconds (0 when unknown). */
    val fileDuration: Double,
    val clip: Boolean,
  )

  /** True when the items are chapter clips (positions need translating). */
  val clipped: Boolean get() = entries.any { it.clip }

  /** (fileIndex, seconds-within-file) -> (item index, item-relative ms). */
  fun fileToItem(fileIndex: Int, fileRelSec: Double): Pair<Int, Long> {
    // Fallback candidate: the latest clip of this file that starts at or before the
    // target, else the file's first clip (when the target precedes every clip).
    var candidate = -1
    for (i in entries.indices) {
      val c = entries[i]
      if (c.fileIndex != fileIndex) continue
      val end = if (c.endInFile > c.startInFile) c.endInFile else Double.MAX_VALUE
      if (fileRelSec >= c.startInFile && fileRelSec < end) {
        return Pair(i, (((fileRelSec - c.startInFile) * 1000).toLong()).coerceAtLeast(0L))
      }
      if (candidate < 0 || c.startInFile <= fileRelSec) candidate = i
    }
    // Position not inside any clip of that file (a gap between chapters, or rounding past
    // the last boundary). Snap to the candidate and measure the offset against THAT
    // clip's start - measuring against the file's first clip seeked into the wrong
    // chapter's content. Clamp within the chosen clip so we never cross its clipped end;
    // before the first clip the negative offset clamps to 0 (the clip's start).
    val idx = candidate.coerceAtLeast(0)
    val clip = entries.getOrNull(idx)
    val start = clip?.startInFile ?: 0.0
    val clipLenMs = clip?.let {
      if (it.endInFile > it.startInFile) ((it.endInFile - it.startInFile) * 1000).toLong() else Long.MAX_VALUE
    } ?: Long.MAX_VALUE
    return Pair(idx, (((fileRelSec - start) * 1000).toLong()).coerceIn(0L, clipLenMs))
  }

  /** (item index, item-relative ms) -> (fileIndex, seconds-within-file). */
  fun itemToFile(itemIndex: Int, itemRelMs: Long): Pair<Int, Double> =
    toFile(entries.getOrNull(itemIndex), itemIndex, itemRelMs)

  /** The FILE duration for an item (seconds, 0 when unknown). */
  fun fileDurationAt(itemIndex: Int): Double = entries.getOrNull(itemIndex)?.fileDuration ?: 0.0

  companion object {
    /** One item's (entry, index, item-relative ms) -> (fileIndex, seconds-within-file). An item
     * without our extras (null [entry]) is taken as a whole file at its own index. */
    fun toFile(entry: Entry?, itemIndex: Int, itemRelMs: Long): Pair<Int, Double> =
      if (entry == null) Pair(itemIndex, itemRelMs / 1000.0) else Pair(entry.fileIndex, entry.startInFile + itemRelMs / 1000.0)
  }
}
