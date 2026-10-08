package expo.modules.audiosiloplayer

import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaConstants

/**
 * The Android Auto browse tree, answered from the car snapshot (contract section 3):
 * root -> up to four browsable tabs (Continue listening, Up next, Downloads, Library) -> books
 * (playable, shown as a grid with their cover, completion and download state). Auto doesn't
 * page, so each tab is the snapshot's own trimmed list. Signed out, or a tab with no books: a
 * single item that is neither browsable nor playable, carrying the snapshot's label.
 */
object CarBrowseTree {
  const val ROOT = "audiosilo.root"
  private const val TAB_PREFIX = "tab:"
  private const val INFO_PREFIX = "info:"

  fun tabId(tab: CarTab) = TAB_PREFIX + tab.id

  fun rootItem(): MediaItem = MediaItem.Builder()
    .setMediaId(ROOT)
    .setMediaMetadata(
      MediaMetadata.Builder()
        .setIsBrowsable(true)
        .setIsPlayable(false)
        .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
        .build(),
    )
    .build()

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
  fun children(context: Context, snapshot: CarSnapshot?, parentId: String, grant: (Uri) -> Unit): List<MediaItem>? {
    snapshot ?: return null
    val tab = snapshot.tabs.firstOrNull { tabId(it) == parentId } ?: return null
    if (tab.items.isEmpty()) return listOf(infoItem(tab.id, snapshot.labels.empty))
    return tab.items.map { bookItem(context, it, grant) }
  }

  /** One item by id (Media3's default `onSubscribe` asks for the parent, and Auto may ask for a
   * book). Null when the snapshot doesn't name it. */
  fun item(context: Context, snapshot: CarSnapshot?, id: String, grant: (Uri) -> Unit): MediaItem? {
    if (id == ROOT) return rootItem()
    snapshot ?: return null
    snapshot.tabs.firstOrNull { tabId(it) == id }?.let { return tabItem(it) }
    return snapshot.find(id)?.let { bookItem(context, it, grant) }
  }

  fun bookItem(context: Context, item: CarItem, grant: (Uri) -> Unit): MediaItem {
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
    val artwork = ArtworkProvider.uriFor(context, item.artworkKey)?.also(grant)
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
