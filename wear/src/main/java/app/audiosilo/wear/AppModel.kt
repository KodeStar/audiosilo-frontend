// The Wear app's state, the port of targets/watch/AppModel.swift: one process-wide model the UI,
// the workers and (W4a pass 2) the Data Layer listener share, with StateFlows to the screens. The
// account (one per watch, decision 3), sign-in from the phone's `pair` (decision 12), the server
// gate (`listening_sync` + the watch rendition, else the too-old screen), the address in use,
// Continue listening, the books on the watch, and the books the phone sent that wait (HeldBooks).
//
// Seams for W4a pass 2, kept here so its pieces plug in without moving these:
//  - PhoneLink calls `receive(PhoneMessage)` for each `/to/<me>/` item (pair, book, remove) and
//    puts the receipt; `onState` hands it each `watch-state` worth publishing (`statePublication`).
//  - Playback adds the SpanRecorder (emitting into `outbox`), `places`, Now Playing and
//    `willRemove`'s stop; the SyncWorker flushes `outbox` with `client()` per SyncSchedule.
//  - Sign-out (AccountRules.signOut, then `forgetAccount`), the offer, the debug sign-in.
package app.audiosilo.wear

import android.content.Context
import app.audiosilo.wear.core.APIError
import app.audiosilo.wear.core.Account
import app.audiosilo.wear.core.AccountChange
import app.audiosilo.wear.core.AccountRules
import app.audiosilo.wear.core.AckStore
import app.audiosilo.wear.core.AddressPicker
import app.audiosilo.wear.core.AuthSession
import app.audiosilo.wear.core.BookRef
import app.audiosilo.wear.core.ContinueRow
import app.audiosilo.wear.core.DownloadIndex
import app.audiosilo.wear.core.DownloadRecord
import app.audiosilo.wear.core.HeldBook
import app.audiosilo.wear.core.HeldBooks
import app.audiosilo.wear.core.JsonFile
import app.audiosilo.wear.core.Outbox
import app.audiosilo.wear.core.PairMessage
import app.audiosilo.wear.core.PhoneMessage
import app.audiosilo.wear.core.PhoneMessages
import app.audiosilo.wear.core.RemoveTicket
import app.audiosilo.wear.core.ServerInfo
import app.audiosilo.wear.core.StatePublication
import app.audiosilo.wear.core.WatchState
import app.audiosilo.wear.core.WatchStateBook
import app.audiosilo.wear.net.AddressRouter
import app.audiosilo.wear.net.ApiClient
import app.audiosilo.wear.net.BookWorker
import app.audiosilo.wear.net.ContinueListening
import app.audiosilo.wear.storage.DeviceIdentity
import app.audiosilo.wear.storage.Files
import app.audiosilo.wear.storage.KeystoreCipher
import app.audiosilo.wear.storage.TokenStore
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class AppModel private constructor(private val context: Context) {
  sealed interface SetupStatus {
    /** Nothing received yet: "Open AudioSilo on your phone". */
    data object Waiting : SetupStatus

    data object SigningIn : SetupStatus

    /** The pairing token was past `expires_at`: "Send again from your phone". */
    data object Expired : SetupStatus

    data class Failed(val message: String) : SetupStatus
  }

  sealed interface Phase {
    data class Setup(val status: SetupStatus) : Phase

    /** The server lacks `listening_sync` or the watch rendition (needs 2.6 or later, with ffmpeg). */
    data class TooOld(val version: String?) : Phase

    data object Ready : Phase
  }

  /** A pair message for another account, on Home until it is settled (decision 3's sign-out rule). */
  sealed interface PendingReplace {
    /** Listening waited when it came: sync it (or discard it), then switch, or keep this account. */
    data object Waiting : PendingReplace

    /** Signing in to the other account. */
    data object Switching : PendingReplace

    /** It did not happen (an expired sign-in, a refusal, no answer): why, in plain words. */
    data class Failed(val message: String) : PendingReplace
  }

  val files = Files(context)
  private val tokens = TokenStore(files.session, KeystoreCipher())
  val deviceId: String = DeviceIdentity.deviceId(files.deviceIdFile)
  private val accountFile = JsonFile(files.account, Account.serializer())
  private val serverFile = JsonFile(files.server, ServerInfo.serializer())

  /** The model's own work: the main thread, so the screens' flows change where they read them. */
  val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

  val router = AddressRouter(scope)
  val library = ContinueListening(files)
  val downloads = DownloadIndex(files.downloadsIndex)
  val acks = AckStore(files.acks)
  val outbox = Outbox(files.root, acks, deviceId)
  private val held = HeldBooks(files.heldBooks)

  /** What `watch-state` the phone is owed (PhoneLink puts it, W4a pass 2). */
  val statePublication = StatePublication()

  /** Told each `watch-state` that is news (PhoneLink, W4a pass 2). */
  @Volatile var onState: ((WatchState) -> Unit)? = null

  /** Told before a book is removed (the player stops it and closes its span, W4a pass 2). */
  @Volatile var willRemove: ((BookRef) -> Unit)? = null

  private val _account = MutableStateFlow<Account?>(null)
  val account: StateFlow<Account?> = _account.asStateFlow()

  private val _server = MutableStateFlow<ServerInfo?>(null)
  val server: StateFlow<ServerInfo?> = _server.asStateFlow()

  private val _phase = MutableStateFlow<Phase>(Phase.Setup(SetupStatus.Waiting))
  val phase: StateFlow<Phase> = _phase.asStateFlow()

  private val _pendingReplace = MutableStateFlow<PendingReplace?>(null)
  val pendingReplace: StateFlow<PendingReplace?> = _pendingReplace.asStateFlow()

  /** What `held` holds, for the screens (`publishState` keeps it current). */
  private val _heldBooks = MutableStateFlow<List<HeldBook>>(emptyList())
  val heldBooks: StateFlow<List<HeldBook>> = _heldBooks.asStateFlow()

  /** Bumped whenever the outbox changes (the replace card's count). */
  private val _syncRevision = MutableStateFlow(0)
  val syncRevision: StateFlow<Int> = _syncRevision.asStateFlow()

  private val _inForeground = MutableStateFlow(false)
  val inForeground: StateFlow<Boolean> = _inForeground.asStateFlow()

  /** The pair message a blocked replace waits on. */
  private var pendingPair: PairMessage? = null

  /** The phone's messages, handled one at a time in the order they came (`receive`). */
  private val inbox = Channel<suspend () -> Unit>(Channel.UNLIMITED)
  private var retryTimer: Job? = null

  init {
    val token = tokens.token()
    val account = if (token == null) null else accountFile.read()
    val server = serverFile.read()
    _account.value = account
    _server.value = server
    _phase.value =
      when {
        account == null -> Phase.Setup(SetupStatus.Waiting)
        server != null && !server.supportsWatch -> Phase.TooOld(server.version)
        else -> Phase.Ready
      }
    outbox.onChange = {
      _syncRevision.value += 1
      publishState()
    }
    scope.launch { for (work in inbox) work() }
    // Held across a kill: aged, and queued if a sign-in finished just before it.
    releaseHeld()
    publishState()
  }

  /** The session token, null when signed out (or it no longer opens). */
  fun token(): String? = tokens.token()

  /** The client for the account's address now, with its token; null when signed out. */
  fun client(): ApiClient? {
    val a = _account.value ?: return null
    val token = tokens.token() ?: return null
    return ApiClient(router.base(a), token)
  }

  // Life cycle

  /** Launch and every return to the foreground. */
  fun becameActive() {
    _inForeground.value = true
    releaseHeld()
    val a = _account.value ?: return
    router.startRechecks { _account.value }
    retryTimer?.cancel()
    retryTimer =
      scope.launch {
        while (isActive) {
          delay(RETRY_INTERVAL_MS)
          if (outbox.unsentCount > 0) flush()
        }
      }
    scope.launch {
      router.repick(a)
      checkServer()
      refreshAddresses(a)
      // Before the gate: a server without the watch rendition still takes the listening.
      flush()
      if (_phase.value != Phase.Ready) return@launch
      // Books that stopped short (a worker given up, a reboot) carry on.
      for (r in downloads.records.value) {
        if (r.state != WatchStateBook.State.READY && r.state != WatchStateBook.State.FAILED) BookWorker.enqueue(context, r.ref)
      }
      client()?.let { library.refresh(it) }
    }
  }

  fun wentToBackground() {
    _inForeground.value = false
    router.stopRechecks()
    retryTimer?.cancel()
    retryTimer = null
    _account.value?.let { router.leaveHome(it) }
    // The SyncWorker (W4a pass 2) takes what waits from here (SyncSchedule.Trigger.BACKGROUND).
  }

  /** Ask the server whether it can serve the watch (kept for offline launches). */
  suspend fun checkServer() {
    val a = _account.value ?: return
    val info =
      try {
        ApiClient(router.base(a), null).serverInfo()
      } catch (e: CancellationException) {
        throw e
      } catch (_: Exception) {
        return
      }
    // Signed out (or switched) while it was asked: the answer is no longer this account's.
    if (_account.value?.accountId != a.accountId) return
    _server.value = info
    serverFile.write(info)
    _phase.value = if (info.supportsWatch) Phase.Ready else Phase.TooOld(info.version)
    // A server that was too old may serve the watch now.
    releaseHeld()
  }

  /**
   * Keep what the server says its addresses are now (the phone's `refreshAddresses`): one moved
   * since the pairing would otherwise go on failing here. Quiet on any failure.
   */
  private suspend fun refreshAddresses(a: Account) {
    if (_server.value?.capabilities?.addresses != true) return
    val api = client() ?: return
    val fresh =
      try {
        api.addresses()
      } catch (e: CancellationException) {
        throw e
      } catch (_: Exception) {
        return
      }
    val now = _account.value ?: return
    if (now.accountId != a.accountId) return
    val merged = AddressPicker.merge(now.addresses, fresh)
    if (merged == now.addresses) return
    val next = now.copy(addresses = merged)
    accountFile.write(next)
    _account.value = next
    if (_inForeground.value) router.repick(next)
  }

  /**
   * Whether what waits can be sent. The listening needs only Sync v2: a server without the watch
   * rendition still takes it, so it is not held until it is discarded.
   */
  private val canSync: Boolean
    get() = _account.value != null && (_phase.value == Phase.Ready || _server.value?.capabilities?.listeningSync == true)

  /** Send what waits from the app (the foreground's triggers; the SyncWorker is W4a pass 2). */
  suspend fun flush() {
    if (!canSync || outbox.unsentCount == 0) return
    val api = client() ?: return
    outbox.flush(api)
  }

  // Books

  /** The Download button (and Try again): queue the book and start its worker. */
  fun download(ref: BookRef, title: String, author: String?, sentAt: Instant? = null) {
    if (downloads.enqueue(ref, title, author, Instant.now(), sentAt)) BookWorker.enqueue(context, ref)
    publishState()
  }

  fun download(row: ContinueRow) = download(row.ref, row.title, row.author)

  /** Q3: the listener chose the phone's connection (slow) for this book. */
  fun useSlowConnection(ref: BookRef) {
    downloads.update(ref) { it.copy(slow = true, waitingForWifi = false, message = null) } ?: return
    BookWorker.enqueue(context, ref, restart = true)
  }

  /** Remove a book from the watch: its work, its files, its item and its record. */
  fun removeBook(ref: BookRef) {
    val r = downloads.record(ref) ?: return
    willRemove?.invoke(ref)
    BookWorker.cancel(context, ref)
    files.folder(r).deleteRecursively()
    files.item(ref).delete()
    downloads.remove(ref)
    publishState()
  }

  /** Remove every book (the account was left). */
  private fun removeAllBooks() {
    BookWorker.cancelAll(context)
    for (r in downloads.removeAll()) {
      willRemove?.invoke(r.ref)
      files.folder(r).deleteRecursively()
    }
    files.books.deleteRecursively()
  }

  // Messages from the phone

  /**
   * One of the phone's messages (PhoneLink's entry point, W4a pass 2), handled one at a time in
   * the order they came: a `book` that follows its `pair` is handled once that sign-in is done.
   * Returns when this message's turn is over, so the caller can put its receipt after.
   */
  suspend fun receive(m: PhoneMessage) {
    val done = kotlinx.coroutines.CompletableDeferred<Unit>()
    when (m) {
      is PhoneMessage.Pair -> serially(done) { signIn(m.message) }
      is PhoneMessage.Book -> {
        // On disk now, not when its turn comes: a sign-in ahead of it can take a while, and the
        // phone has said "Sent", so a kill meanwhile must not lose it.
        held.hold(m.message, Instant.now())
        publishState()
        serially(done) { releaseHeld() }
      }
      is PhoneMessage.Remove -> {
        val ticket = held.noteRemove(m.message)
        serially(done) { remove(ticket) }
      }
    }
    done.await()
  }

  /** Sign in from a received pair: the entry point PhoneLink (W4a pass 2) and the debug sign-in call. */
  suspend fun signInFromPair(p: PairMessage) = receive(PhoneMessage.Pair(p))

  private fun serially(done: kotlinx.coroutines.CompletableDeferred<Unit>, work: suspend () -> Unit) {
    inbox.trySend {
      try {
        work()
      } finally {
        done.complete(Unit)
      }
    }
  }

  /**
   * A `remove`'s turn: the same path as removing by hand. Refused for any account but this one
   * (`finishRemove`), and a `remove` older than the download it would remove is ignored (its
   * `sent_at` before the book's).
   */
  private fun remove(ticket: RemoveTicket) {
    held.finishRemove(ticket, _account.value?.accountId, Instant.now()) {
      val r = downloads.record(ticket.message.ref)
      if (r != null && PhoneMessages.removeApplies(ticket.message, r.queuedAt)) removeBook(r.ref)
    }
    publishState()
  }

  /**
   * Queue what waits for the account, if it is ready, and age the rest. Ready needs the server's
   * own word: a sign-in sets Ready before `checkServer` has asked, and a server too old for the
   * watch would turn a held book into a failed download. `checkServer` releases them once it has
   * answered.
   */
  private fun releaseHeld() {
    if (held.books.isEmpty()) return
    val ready = _phase.value == Phase.Ready && _server.value?.supportsWatch == true
    for (b in held.due(_account.value?.accountId, ready, Instant.now())) {
      if (downloads.enqueue(b.ref, b.title, b.author, Instant.now(), b.sentAt)) BookWorker.enqueue(context, b.ref)
    }
    publishState()
  }

  private class WrongServer : Exception("another server answered")

  /**
   * Sign in from a `pair` message (decision 12): exchange its token at `base_url`, then away, then
   * home http under pairingFallback's rule; keep the token sealed; then gate on the server. Past
   * `expires_at` it is never tried. `discard`: the listener chose to drop what waits to replace
   * the account.
   */
  private suspend fun signIn(p: PairMessage, discard: Boolean = false) {
    val current = _account.value
    val another = current != null && current.accountId != p.accountId
    if (p.expired(Instant.now())) {
      if (current == null) {
        _phase.value = Phase.Setup(SetupStatus.Expired)
      } else if (another) {
        _pendingReplace.value = PendingReplace.Failed(EXPIRED)
        pendingPair = null
      }
      return
    }
    val change = AccountRules.change(current?.accountId, p.accountId, outbox.unsentCount, discard)
    if (change is AccountChange.Blocked) {
      _pendingReplace.value = PendingReplace.Waiting
      pendingPair = p
      return
    }
    pendingPair = null
    _pendingReplace.value = if (change == AccountChange.Replace) PendingReplace.Switching else null
    if (current == null) _phase.value = Phase.Setup(SetupStatus.SigningIn)

    fun failed(message: String) {
      if (_account.value == null) {
        _phase.value = Phase.Setup(SetupStatus.Failed(message))
      } else if (change == AccountChange.Replace) {
        _pendingReplace.value = PendingReplace.Failed(message)
      }
    }

    val deviceName = DeviceIdentity.deviceName(context)
    val exchanged =
      try {
        AddressPicker.exchange(
          p.baseUrl,
          p.addresses,
          p.serverId,
          attempt = { url ->
            val s: AuthSession = ApiClient(url, null).exchange(p.pairingToken, deviceName)
            if (s.serverId != p.serverId || s.user.id != p.userId) throw WrongServer()
            s
          },
          isTimeout = ApiClient::isTimeout,
          probe = { ApiClient.probeServerId(it) },
        )
      } catch (e: CancellationException) {
        throw e
      } catch (e: APIError) {
        failed(if (e.status == 401 || e.status == 404) EXPIRED else "Your server refused the sign-in (${e.status}).")
        return
      } catch (_: WrongServer) {
        failed("Another server answered. Send again from your phone.")
        return
      } catch (_: Exception) {
        failed("Can't reach your server. Send again from your phone when the watch is online.")
        return
      }
    val session = exchanged.answer
    if (change == AccountChange.Replace) {
      // Its token ends on its server too (as Sign out does): this watch forgets it now. A sign-in
      // again for the same account keeps its old token, as the phone does.
      val leaving = client()
      forgetAccount()
      if (leaving != null) {
        scope.launch {
          try {
            leaving.logout()
          } catch (e: CancellationException) {
            throw e
          } catch (_: Exception) {}
        }
      }
    } else if (change == AccountChange.SignIn && accountFile.read()?.accountId != p.accountId) {
      // The token was lost, and what is here is another account's: never sent under this one.
      forgetAccount()
    }
    if (!tokens.setToken(session.token)) {
      failed("The watch could not keep its sign-in.")
      publishState()
      return
    }
    val a =
      Account(
        serverId = p.serverId,
        serverName = p.serverName,
        userId = p.userId,
        userName = p.userName.ifEmpty { session.user.username },
        serverUrl = p.serverUrl,
        addresses = AddressPicker.merge(p.addresses, session.addresses),
        signedInAt = Instant.now(),
      )
    accountFile.write(a)
    _account.value = a
    router.start(if (AddressPicker.isOwn(exchanged.base, a.serverUrl, a.addresses)) exchanged.base else null)
    _phase.value = Phase.Ready
    _pendingReplace.value = null
    publishState()
    if (_inForeground.value) {
      becameActive()
    } else {
      // Delivered in the background (a Data Layer wake): no foreground timers and no home pick;
      // the gate, then the books that waited for it.
      router.leaveHome(a)
      checkServer()
    }
  }

  /**
   * Switch to the account the blocked pair message is for: `discard` drops the listening that
   * waits (an explicit choice); without it, the switch is blocked again if listening waits.
   */
  fun replace(discard: Boolean) {
    inbox.trySend {
      val p = pendingPair ?: return@trySend
      signIn(p, discard)
    }
  }

  /** Keep this account: the blocked pair message is dropped, and its books can't come now. */
  fun keepAccount() {
    pendingPair?.let { held.giveUp(it.accountId, Instant.now()) }
    pendingPair = null
    _pendingReplace.value = null
    publishState()
  }

  /** Drop everything of the account (AccountRules was asked first). Sign-out (W4a pass 2) ends here too. */
  internal fun forgetAccount() {
    // Definitely gone now (a blocked or failed replace never gets here): no titles of it stay.
    held.forget(_account.value?.accountId ?: accountFile.read()?.accountId, Instant.now())
    removeAllBooks()
    library.clear()
    files.items.deleteRecursively()
    acks.clear()
    outbox.discardAll()
    router.reset()
    serverFile.write(null)
    _server.value = null
    _pendingReplace.value = null
    pendingPair = null
    tokens.setToken(null)
    accountFile.write(null)
    _account.value = null
  }

  // The phone's view of the watch

  /** Work out `watch-state` now and hand it on when it is news (PhoneLink puts it, W4a pass 2). */
  fun publishState() {
    val who = _account.value?.accountId
    // A row goes only for a record a kill can't lose (a full disk keeps it in memory alone), and
    // not for a failed one: sent again, that book still wants the retry `enqueue` gives it.
    val records = downloads.records.value
    val onWatch = if (downloads.saved) records.filter { it.state != WatchStateBook.State.FAILED }.map { it.ref } else emptyList()
    held.settle(who, onWatch, Instant.now())
    if (_heldBooks.value != held.books) _heldBooks.value = held.books
    val rows = held.stateRows(who)
    // One entry per book: a row kept beside its record speaks for it until it settles.
    val rowRefs = rows.map { it.ref }.toSet()
    val books =
      records.filter { it.ref !in rowRefs }.map { r: DownloadRecord ->
        WatchStateBook(r.ref, r.title, r.state, if (r.state == WatchStateBook.State.READY) r.bytes else null)
      } + rows
    val a = _account.value
    val state =
      WatchState(
        signedIn = a != null,
        serverId = a?.serverId,
        userId = a?.userId,
        appVersion = ApiClient.APP_VERSION,
        books = books,
        unsentEvents = outbox.unsentCount,
        couldntSync = outbox.couldNotSync().size,
        lastSyncAt = outbox.state.lastSyncAt,
      )
    if (statePublication.update(state)) onState?.invoke(state)
  }

  companion object {
    /** How often the foreground tries again while events wait (SyncSchedule.FOREGROUND_RETRY). */
    private const val RETRY_INTERVAL_MS = 60_000L

    const val EXPIRED = "That sign-in has expired. Send again from your phone."

    @Volatile private var instance: AppModel? = null

    fun get(context: Context): AppModel =
      instance ?: synchronized(this) { instance ?: AppModel(context.applicationContext).also { instance = it } }
  }
}
