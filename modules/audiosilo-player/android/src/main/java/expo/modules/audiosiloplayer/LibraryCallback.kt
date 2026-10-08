package expo.modules.audiosiloplayer

import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSession.MediaItemsWithStartPosition
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

// Custom session commands. The skips must be CUSTOM actions (not the standard
// COMMAND_SEEK_BACK/FORWARD, which map to legacy ACTION_REWIND/FAST_FORWARD that the modern
// Android media UI does NOT render) so the buttons actually appear.
internal const val CMD_SEEK_BACK = "audiosilo.SEEK_BACK"
internal const val CMD_SEEK_FORWARD = "audiosilo.SEEK_FORWARD"
/** The bookmark button (notification overflow, Android Auto's custom action). */
internal const val CMD_BOOKMARK = "audiosilo.BOOKMARK"
/** The module's `setConfig` -> Smart Speed / Voice Boost (extras `smartSpeed`, `voiceBoost`). */
internal const val CMD_SET_EFFECTS = "audiosilo.SET_EFFECTS"

/**
 * The session callback: commands, connections, the Android Auto browse tree and playing from
 * the car. Runs on the main thread (the player's application looper).
 */
@androidx.annotation.OptIn(UnstableApi::class)
internal class LibraryCallback(private val service: AudiosiloPlayerService) : MediaLibrarySession.Callback {

  /**
   * Grants the custom commands (so the skip and bookmark buttons are enabled) to every
   * controller; SET_EFFECTS only to the app's own controller. Notes an Android Auto controller.
   *
   * Search is NOT granted: the session has no `onSearch`/`onGetSearchResult` (car search is
   * not built, Phase 6 contract decision 12), and a legacy browser's root hints say
   * `BROWSER_SERVICE_EXTRAS_KEY_SEARCH_SUPPORTED` exactly when the controller holds
   * `COMMAND_CODE_LIBRARY_SEARCH` (MediaLibraryServiceLegacyStub.onGetRoot), so granting it
   * (the default command set does) showed Android Auto a search button that found nothing.
   */
  override fun onConnect(
    session: MediaSession,
    controller: MediaSession.ControllerInfo,
  ): MediaSession.ConnectionResult {
    val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
      .remove(SessionCommand.COMMAND_CODE_LIBRARY_SEARCH)
      .remove(SessionCommand.COMMAND_CODE_LIBRARY_GET_SEARCH_RESULT)
      .add(SessionCommand(CMD_SEEK_BACK, Bundle.EMPTY))
      .add(SessionCommand(CMD_SEEK_FORWARD, Bundle.EMPTY))
      .add(SessionCommand(CMD_BOOKMARK, Bundle.EMPTY))
      .apply { if (PlayerBridge.isAppController(controller)) add(SessionCommand(CMD_SET_EFFECTS, Bundle.EMPTY)) }
      .build()
    service.onControllerConnected(controller)
    return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
      .setAvailableSessionCommands(commands)
      .build()
  }

  override fun onDisconnected(session: MediaSession, controller: MediaSession.ControllerInfo) {
    service.onControllerDisconnected(controller)
  }

  override fun onCustomCommand(
    session: MediaSession,
    controller: MediaSession.ControllerInfo,
    customCommand: SessionCommand,
    args: Bundle,
  ): ListenableFuture<SessionResult> {
    val remote = !PlayerBridge.isAppController(controller)
    when (customCommand.customAction) {
      // AudiobookPlayer overrides these to seek by the live user-configured intervals. The
      // session doesn't attribute custom commands to a controller, so pass the origin along.
      CMD_SEEK_BACK -> service.player?.withOrigin(remote) { service.player?.seekBack() }
      CMD_SEEK_FORWARD -> service.player?.withOrigin(remote) { service.player?.seekForward() }
      CMD_BOOKMARK -> service.onBookmarkPressed()
      CMD_SET_EFFECTS -> service.applyEffects(args.getBoolean("smartSpeed"), args.getBoolean("voiceBoost"))
    }
    return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
  }

  override fun onGetLibraryRoot(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    params: LibraryParams?,
  ): ListenableFuture<LibraryResult<MediaItem>> {
    val rootParams = LibraryParams.Builder().setExtras(CarBrowseTree.rootExtras()).build()
    return Futures.immediateFuture(LibraryResult.ofItem(CarBrowseTree.rootItem(), rootParams))
  }

  override fun onGetChildren(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    parentId: String,
    page: Int,
    pageSize: Int,
    params: LibraryParams?,
  ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
    val snapshot = service.snapshot()
    if (snapshot == null) service.needJs() // JS writes the first snapshot; notifyChildrenChanged follows
    val all = if (parentId == CarBrowseTree.ROOT) {
      val limit = params?.extras?.getInt(MediaConstants.EXTRAS_KEY_ROOT_CHILDREN_LIMIT, 0) ?: 0
      CarBrowseTree.rootChildren(snapshot, limit)
    } else {
      CarBrowseTree.children(service, snapshot, parentId) { service.grantArtwork(browser, it) }
        ?: return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE, params))
    }
    val from = page.toLong() * pageSize
    val pageItems = if (from >= all.size) emptyList() else all.subList(from.toInt(), minOf(all.size, from.toInt() + pageSize))
    return Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(pageItems), params))
  }

  override fun onGetItem(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    mediaId: String,
  ): ListenableFuture<LibraryResult<MediaItem>> {
    val item = CarBrowseTree.item(service, service.snapshot(), mediaId) { service.grantArtwork(browser, it) }
      ?: return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
    return Futures.immediateFuture(LibraryResult.ofItem(item, null))
  }

  /** Accept every subscription (also before the first snapshot exists, so the browser hears
   * `notifyChildrenChanged` when it arrives). */
  override fun onSubscribe(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    parentId: String,
    params: LibraryParams?,
  ): ListenableFuture<LibraryResult<Void>> = Futures.immediateFuture(LibraryResult.ofVoid(params))

  /**
   * The app's own `load` passes straight through (its items carry their URIs). A car's request
   * is an id-only item naming a snapshot book: the service resolves it (at once for a
   * downloaded book when no JS runs, else through JS).
   */
  override fun onSetMediaItems(
    mediaSession: MediaSession,
    controller: MediaSession.ControllerInfo,
    mediaItems: MutableList<MediaItem>,
    startIndex: Int,
    startPositionMs: Long,
  ): ListenableFuture<MediaItemsWithStartPosition> {
    if (PlayerBridge.isAppController(controller)) {
      service.onAppLoad()
      return Futures.immediateFuture(MediaItemsWithStartPosition(mediaItems, startIndex, startPositionMs))
    }
    val single = mediaItems.singleOrNull()
    if (single != null && single.localConfiguration == null) {
      return service.playFromCar(single.mediaId, requirePlaySpec = false)
    }
    return super.onSetMediaItems(mediaSession, controller, mediaItems, startIndex, startPositionMs)
  }

  /**
   * A play with an empty player (Bluetooth, the car's play button, the system's resumption
   * card): the snapshot's first Continue listening book, when it is downloaded (has a play
   * spec). Media3 1.5.1 only asks on a play command, so merely connecting Auto never plays.
   */
  override fun onPlaybackResumption(
    mediaSession: MediaSession,
    controller: MediaSession.ControllerInfo,
  ): ListenableFuture<MediaItemsWithStartPosition> {
    val item = service.snapshot()?.resumable()
      ?: return Futures.immediateFailedFuture(UnsupportedOperationException("Nothing to resume"))
    return service.playFromCar(item.id, requirePlaySpec = true)
  }
}
