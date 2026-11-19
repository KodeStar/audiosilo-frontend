package expo.modules.audiosiloplayer

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaConstants

/**
 * The Android Auto browse tree, answered from the car snapshot (`src/car/car-model.ts`):
 * root -> up to four browsable tabs (Continue listening, Up next, Downloads, Library) -> books
 * (playable, shown as a grid with their cover, completion and download state). Auto doesn't
 * page, so each tab is the snapshot's own trimmed list. Signed out, or a tab with no books: a
 * single item that is neither browsable nor playable, carrying the snapshot's label.
 */
object CarBrowseTree {
  const val ROOT = "audiosilo.root"
  /** The root a browser asking for recent media gets ([MediaLibraryService.LibraryParams.isRecent]):
   * its one child is the book a resumption plays ([recentChildren]). System UI's own request
   * (the resumption card after a reboot) Media3 answers itself, through `onPlaybackResumption`. */
  const val RECENT_ROOT = "audiosilo.recent"
  private const val TAB_PREFIX = "tab:"
  private const val INFO_PREFIX = "info:"

  fun tabId(tab: CarTab) = TAB_PREFIX + tab.id

  fun rootItem(): MediaItem = folderItem(ROOT, MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)

  /** The recent root ([RECENT_ROOT]). */
  fun recentRootItem(): MediaItem = folderItem(RECENT_ROOT, MediaMetadata.MEDIA_TYPE_FOLDER_AUDIO_BOOKS)

  /** A root: browsable, never playable. */
  private fun folderItem(id: String, mediaType: Int): MediaItem = MediaItem.Builder()
    .setMediaId(id)
    .setMediaMetadata(
      MediaMetadata.Builder()
        .setIsBrowsable(true)
        .setIsPlayable(false)
        .setMediaType(mediaType)
        .build(),
    )
    .build()

  /**
   * The recent root's children, and the resumption card's item: the book a resumption plays
   * ([resumable], already one with a play spec), as its browse row is (title, author, cover),
   * or none. PLAYABLE: System UI shows a card only for a first child flagged playable, and a
   * play spec's own items carry no such flag (the reboot card never appeared).
   */
  fun recentChildren(authority: String, resumable: CarItem?, grant: (Uri) -> Unit): List<MediaItem> =
    listOfNotNull(resumable?.takeIf(::hasRecent)?.let { bookItem(authority, it, grant) })

  /** Whether [resumable] is one a resumption can start (downloaded: it has a play spec), so
   * there is recent media to offer at all ([recentChildren] not empty). */
  fun hasRecent(resumable: CarItem?): Boolean = resumable?.play != null

  /** How many children the recent root has for [resumable]: its one book, or none. */
  fun recentCount(resumable: CarItem?): Int = if (hasRecent(resumable)) 1 else 0

  /** Whether the recent root's children changed between two resumable books: another book,
   * one where there was none (or none now), or the same one showing something else (its
   * title, author, cover or progress). Where it resumes ([CarItem.play], which moves as the
   * book plays) is not shown. */
  fun recentChanged(previous: CarItem?, now: CarItem?): Boolean =
    previous?.takeIf(::hasRecent)?.copy(play = null) != now?.takeIf(::hasRecent)?.copy(play = null)

  /** Root extras: the tabs' children (books) default to grid items. */
  fun rootExtras(): Bundle = Bundle().apply {
    putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_CATEGORY_LIST_ITEM)
    putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM)
  }

  /** The root's children: the tabs, or one label item when signed out. [limit] is the
   * browser's `EXTRAS_KEY_ROOT_CHILDREN_LIMIT` (Auto shows at most that many tabs). */
  fun rootChildren(snapshot: CarSnapshot?, limit: Int): List<MediaItem> {
    if (snapshot == null) return emptyList()
    if (!snapshot.signedIn) return listOf(infoItem("signedOut", snapshot.labels.signedOut))
    val tabs = if (limit > 0) snapshot.tabs.take(limit) else snapshot.tabs
    return tabs.map(::tabItem)
  }

  /** A browsable tab (its books default to grid items). */
  private fun tabItem(tab: CarTab): MediaItem = MediaItem.Builder()
    .setMediaId(tabId(tab))
    .setMediaMetadata(
      MediaMetadata.Builder()
        .setTitle(tab.title)
        .setIsBrowsable(true)
        .setIsPlayable(false)
        .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_AUDIO_BOOKS)
        .setExtras(
          Bundle().apply {
            putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM)
          },
        )
        .build(),
    )
    .build()

  /** A tab's books, or one label item for an empty tab; null for an unknown parent (the root's
   * children come from [rootChildren]). */
  fun children(authority: String, snapshot: CarSnapshot?, parentId: String, grant: (Uri) -> Unit): List<MediaItem>? {
    snapshot ?: return null
    val tab = snapshot.tabs.firstOrNull { tabId(it) == parentId } ?: return null
    if (tab.items.isEmpty()) return listOf(infoItem(tab.id, snapshot.labels.empty))
    return tab.items.map { bookItem(authority, it, grant) }
  }

  /** One item by id (Media3's default `onSubscribe` asks for the parent, and Auto may ask for a
   * book). Null when the snapshot doesn't name it. */
  fun item(authority: String, snapshot: CarSnapshot?, id: String, grant: (Uri) -> Unit): MediaItem? {
    if (id == ROOT) return rootItem()
    if (id == RECENT_ROOT) return recentRootItem()
    snapshot ?: return null
    snapshot.tabs.firstOrNull { tabId(it) == id }?.let { return tabItem(it) }
    return snapshot.find(id)?.let { bookItem(authority, it, grant) }
  }

  private fun bookItem(authority: String, item: CarItem, grant: (Uri) -> Unit): MediaItem {
    val extras = Bundle().apply {
      val status = when {
        item.finished -> MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_FULLY_PLAYED
        item.progress != null && item.progress > 0 -> MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_PARTIALLY_PLAYED
        else -> MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_NOT_PLAYED
      }
      putInt(MediaConstants.EXTRAS_KEY_COMPLETION_STATUS, status)
      if (status == MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_PARTIALLY_PLAYED) {
        putDouble(MediaConstants.EXTRAS_KEY_COMPLETION_PERCENTAGE, (item.progress ?: 0.0).coerceIn(0.0, 1.0))
      }
      putLong(
        MediaConstants.EXTRAS_KEY_DOWNLOAD_STATUS,
        if (item.downloaded) MediaConstants.EXTRAS_VALUE_STATUS_DOWNLOADED else MediaConstants.EXTRAS_VALUE_STATUS_NOT_DOWNLOADED,
      )
    }
    // A book with no cover, or whose cover file is gone, shows the bundled one: with none,
    // Android Auto drew a warning triangle. Both are the provider's URIs, granted per reader.
    val artwork = Uri.parse(
      ArtworkProvider.browseArtwork(authority, ArtworkProvider.browseArtworkKey(item)),
    ).also(grant)
    return MediaItem.Builder()
      .setMediaId(item.id)
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(item.title)
          .setSubtitle(item.subtitle)
          .setArtist(item.subtitle)
          .setIsBrowsable(false)
          .setIsPlayable(true)
          .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
          .setArtworkUri(artwork)
          .setExtras(extras)
          .build(),
      )
      .build()
  }

  private fun infoItem(key: String, label: String): MediaItem = MediaItem.Builder()
    .setMediaId(INFO_PREFIX + key)
    .setMediaMetadata(
      MediaMetadata.Builder()
        .setTitle(label)
        .setIsBrowsable(false)
        .setIsPlayable(false)
        .build(),
    )
    .build()
}
