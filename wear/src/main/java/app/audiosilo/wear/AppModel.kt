// The Wear app's state, the port of targets/watch/AppModel.swift: one process-wide model the UI,
// the workers, the media service and the Data Layer listener share, with StateFlows to the
// screens. The account (one per watch, decision 3), sign-in from the phone's `pair` (decision 12),
// the server gate (`listening_sync` + the watch rendition, else the too-old screen), the address in
// use, Continue listening, the books on the watch, the books the phone sent that wait (HeldBooks),
// the player and Sync v2.
//
// Sync (decision 9, SyncSchedule): in front, the outbox is sent at launch (after the open span a
// kill left is recovered), on coming to the foreground, after each closed span, every 60 s while
// events wait and when a network comes up; in the background the SyncWorker sends it (expedited on
// a closed span or on going to the background, a 15 minute backstop while events wait). Signing
// out or replacing the account is blocked while events wait unless the listener discards them.
// PhoneLink calls `receive` for each of the phone's items and puts `watch-state` (`onState`).
package app.audiosilo.wear

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Looper
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
import app.audiosilo.wear.core.FileSpanStore
import app.audiosilo.wear.core.HeldBook
import app.audiosilo.wear.core.HeldBooks
import app.audiosilo.wear.core.JsonFile
import app.audiosilo.wear.core.ListeningStart
import app.audiosilo.wear.core.OfferThrottle
import app.audiosilo.wear.core.Offers
import app.audiosilo.wear.core.Outbox
import app.audiosilo.wear.core.PairMessage
import app.audiosilo.wear.core.PhoneMessage
import app.audiosilo.wear.core.PhoneMessages
import app.audiosilo.wear.core.PlaceOffer
import app.audiosilo.wear.core.PlaceStore
import app.audiosilo.wear.core.ProgressRow
import app.audiosilo.wear.core.RemoveTicket
import app.audiosilo.wear.core.Resume
import app.audiosilo.wear.core.ServerInfo
import app.audiosilo.wear.core.SignOutGate
import app.audiosilo.wear.core.SpanRecorder
import app.audiosilo.wear.core.StatePublication
import app.audiosilo.wear.core.SyncSchedule
import app.audiosilo.wear.core.WatchState
import app.audiosilo.wear.core.WatchStateBook
import app.audiosilo.wear.core.orNull
import app.audiosilo.wear.net.AddressRouter
import app.audiosilo.wear.net.ApiClient
import app.audiosilo.wear.net.BookWorker
import app.audiosilo.wear.net.ContinueListening
import app.audiosilo.wear.net.SyncWorker
import app.audiosilo.wear.playback.LoadedBook
import app.audiosilo.wear.playback.PlayerEngine
import app.audiosilo.wear.storage.DeviceIdentity
import app.audiosilo.wear.storage.Files
import app.audiosilo.wear.storage.KeystoreCipher
import app.audiosilo.wear.storage.TokenStore
import java.io.File
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
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
import kotlinx.coroutines.withTimeoutOrNull

/** Another device's place offered for the loaded book (Jump / Stay). */
data class OfferPrompt(val ref: BookRef, val offer: PlaceOffer, val row: ProgressRow)

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
  val places = PlaceStore(files.places)

  /** Closed spans go into the outbox, then a send is scheduled (SyncSchedule's SPAN_CLOSED). */
  val spans =
    SpanRecorder(
      FileSpanStore(files.openSpan),
      acks,
      emit = { events ->
        outbox.append(events)
        // Posted, not run inside the recorder's own call (a cut opens the next span after this).
        scope.launch(Dispatchers.Main) { schedule(SyncSchedule.Trigger.SPAN_CLOSED) }
      },
    )
  val engine = PlayerEngine(context, spans, places)
  private val offers = OfferThrottle()

  /** What `watch-state` the phone is owed (PhoneLink puts it). */
  val statePublication = StatePublication()

  /** Told each `watch-state` that is news (PhoneLink puts it). */
  @Volatile var onState: ((WatchState) -> Unit)? = null

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

  /** In front now (written on the main thread; the workers and PhoneLink read the model from theirs). */
  @Volatile private var inForeground = false

  /** A send runs now (Sync now shows it). */
  private val _syncing = MutableStateFlow(false)
  val syncing: StateFlow<Boolean> = _syncing.asStateFlow()

  /** Another device's place to offer for the loaded book. */
  private val _offerPrompt = MutableStateFlow<OfferPrompt?>(null)
  val offerPrompt: StateFlow<OfferPrompt?> = _offerPrompt.asStateFlow()

  /** The newest ask to play: one still pulling its row when another came goes no further. */
  private var playGeneration = 0

  /** Whether the backstop is scheduled, as far as this process knows (null: not asked yet). */
  private var backstopOn: Boolean? = null

  /** A network coming up while in front: a trigger only, never a gate (decision 3). */
  private var networkCallback: ConnectivityManager.NetworkCallback? = null

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
    outbox.onAnswer = { rows -> scope.launch { checkOffer(rows) } }
    engine.reachable = { !outbox.lastFlushFailed }
    engine.onPickedUp = { scope.launch { reconcileLoaded() } }
    scope.launch { for (work in inbox) work() }
    // A span a kill left open goes into the outbox before anything else (sent at launch, or by the
    // worker when this start is a background one), and its place, newer than the saved one when the
    // kill came between two saves (the 5 s tick keeps the place in memory only), becomes the book's.
    spans.recover()?.let(places::recover)
    // Held across a kill: aged, and queued if a sign-in finished just before it.
    releaseHeld()
    publishState()
    // A book's stage moving is news for the phone (its Preparing and Downloading rows), whoever
    // moved it: a BookWorker run with the app closed too, as this model is the process's.
    scope.launch { downloads.stages.collect { publishState() } }
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
    inForeground = true
    releaseHeld()
    val a = _account.value ?: return
    router.startRechecks { _account.value }
    retryTimer?.cancel()
    retryTimer =
      scope.launch {
        while (isActive) {
          delay(RETRY_INTERVAL_MS)
          if (SyncSchedule.foregroundTimer(outbox.unsentCount, inForeground) && !_syncing.value) flush()
        }
      }
    watchNetwork(true)
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
      // A book loaded and not playing: another device may have moved it on (an offer only).
      if (inForeground && !engine.isPlaying) reconcileLoaded()
      client()?.let { library.refresh(it) }
    }
  }

  fun wentToBackground() {
    inForeground = false
    router.stopRechecks()
    retryTimer?.cancel()
    retryTimer = null
    _account.value?.let { router.leaveHome(it) }
    watchNetwork(false)
    // Sync v2: the playing span is cut, then the SyncWorker takes what waits.
    engine.cutForBackground()
    schedule(SyncSchedule.Trigger.BACKGROUND)
  }

  /** Register (or drop) the foreground's network trigger. */
  private fun watchNetwork(on: Boolean) {
    val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
    networkCallback?.let {
      try {
        cm.unregisterNetworkCallback(it)
      } catch (_: Exception) {}
    }
    networkCallback = null
    if (!on) return
    val cb =
      object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          scope.launch { schedule(SyncSchedule.Trigger.NETWORK) }
        }
      }
    try {
      cm.registerDefaultNetworkCallback(cb)
      networkCallback = cb
    } catch (_: Exception) {}
  }

  /** Ask the server whether it can serve the watch (kept for offline launches). */
  suspend fun checkServer() {
    val a = _account.value ?: return
    val info = orNull { ApiClient(router.base(a), null).serverInfo() } ?: return
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
    val fresh = orNull { api.addresses() } ?: return
    val now = _account.value ?: return
    if (now.accountId != a.accountId) return
    val merged = AddressPicker.merge(now.addresses, fresh)
    if (merged == now.addresses) return
    val next = now.copy(addresses = merged)
    accountFile.write(next)
    _account.value = next
    if (inForeground) router.repick(next)
  }

  /**
   * Whether what waits can be sent. The listening needs only Sync v2: a server without the watch
   * rendition still takes it, so it is not held until it is discarded.
   */
  private val canSync: Boolean
    get() = _account.value != null && (_phase.value == Phase.Ready || _server.value?.capabilities?.listeningSync == true)

  /** What one trigger does (SyncSchedule): send from the app, or hand it to the worker, and the backstop. */
  private fun schedule(trigger: SyncSchedule.Trigger) {
    if (!canSync) return
    val plan = SyncSchedule.plan(trigger, outbox.unsentCount, inForeground)
    if (plan.flushNow) scope.launch { flush() }
    if (plan.expedite) SyncWorker.expedite(context)
    setBackstop(plan.backstop)
  }

  private fun setBackstop(on: Boolean) {
    if (backstopOn == on) return
    backstopOn = on
    SyncWorker.backstop(context, on)
  }

  /** Send what waits from the app (the foreground's triggers and Sync now). */
  suspend fun flush() {
    if (!canSync || outbox.unsentCount == 0) return
    val api = client() ?: return
    _syncing.value = true
    try {
      outbox.flush(api)
    } finally {
      _syncing.value = false
    }
    setBackstop(outbox.unsentCount > 0)
    publishState()
  }

  /**
   * The SyncWorker's run (decision 9): its own address pick, the tokenless probe allowed (so home
   * works in the background too), then the outbox, whose body is built now with a fresh `sent_at`.
   * Flushed again while spans close meanwhile, a few rounds at most.
   */
  suspend fun syncInBackground(): SyncSchedule.Outcome {
    val a = _account.value
    val token = tokens.token()
    if (!canSync || a == null || token == null) {
      setBackstop(false)
      return SyncSchedule.outcome(false, outbox.unsentCount, outbox.lastFlushFailed)
    }
    if (outbox.unsentCount > 0) {
      val base =
        if (inForeground) router.base(a) else AddressPicker.pick(a.serverUrl, a.addresses, a.serverId) { ApiClient.probeServerId(it) }
      // Signed out or switched while it picked: this account's token goes nowhere now.
      if (_account.value?.accountId != a.accountId) return SyncSchedule.Outcome.DONE
      val api = ApiClient(base, token)
      _syncing.value = true
      try {
        for (round in 1..SyncSchedule.WORKER_ROUNDS) {
          outbox.flush(api)
          if (outbox.unsentCount == 0 || outbox.lastFlushFailed) break
        }
      } finally {
        _syncing.value = false
      }
    }
    setBackstop(outbox.unsentCount > 0)
    publishState()
    return SyncSchedule.outcome(canSync, outbox.unsentCount, outbox.lastFlushFailed)
  }

  // Playing

  /**
   * Play a book on the watch: pull its row first (a few seconds at most), resume by the Core rule,
   * and offer another device's place when that rule keeps this one. With no answer, the server's
   * place kept for it stands in (Continue listening's last read, or the one read when its download
   * started), so an in-progress book never opens at 0 offline.
   */
  suspend fun play(record: DownloadRecord) {
    if (record.state != WatchStateBook.State.READY || _pendingReplace.value == PendingReplace.Switching) return
    val who = _account.value?.accountId ?: return
    playGeneration += 1
    val mine = playGeneration
    if (engine.loadedBook == record.ref) {
      engine.play()
      return
    }
    val cache = files.loadItem(record.ref) ?: return
    val timeline = cache.timeline
    val byPath = record.files.associateBy { it.path }
    val local = timeline.files.mapNotNull { f -> byPath[f.path]?.let { File(files.folder(record), it.local) } }
    if (local.isEmpty() || local.size != timeline.files.size) return
    val pulled = pull(record.ref)
    // Asked to play something else (or the same book again), a switch or a sign-out, or the book
    // removed meanwhile: this one no longer plays.
    if (
      mine != playGeneration ||
        _account.value?.accountId != who ||
        _pendingReplace.value == PendingReplace.Switching ||
        downloads.record(record.ref)?.state != WatchStateBook.State.READY
    ) {
      return
    }
    val row =
      when (pulled) {
        is Pulled.Answered -> pulled.row
        Pulled.NoAnswer -> listOfNotNull(library.keptPlace(record.ref), cache.serverPlace).maxByOrNull { it.version }
      }
    val kept = places.place(record.ref)
    val plan =
      Resume.plan(
        kept,
        row,
        deviceId,
        acks.ackVersion(record.ref),
        timeline.total,
        waiting = outbox.events.any { it.ref == record.ref },
      )
    if (plan.tookRow && row != null) acks.ackResume(row)
    engine.load(LoadedBook(record.ref, record.title, record.author, timeline, local), plan, Resume.savedSpeed(plan, kept, row))
    // Offered only from the server's answer, never from a kept place.
    if (!plan.tookRow && pulled is Pulled.Answered && pulled.row != null) checkOffer(listOf(pulled.row))
    engine.play()
  }

  /** Start `play` in the model's scope (a screen left meanwhile does not cut it short). */
  fun startPlay(record: DownloadRecord): Job = scope.launch { play(record) }

  /** What the pull before play got: the server's answer (maybe no row at all), or none. */
  private sealed interface Pulled {
    data class Answered(val row: ProgressRow?) : Pulled

    data object NoAnswer : Pulled
  }

  private suspend fun pull(ref: BookRef): Pulled {
    val api = client() ?: return Pulled.NoAnswer
    return withTimeoutOrNull(PULL_TIMEOUT_MS) { orNull { Pulled.Answered(api.progress(ref)) } } ?: Pulled.NoAnswer
  }

  /**
   * Ask the server about the loaded book, which plays from the engine's place with no pull of its
   * own: on coming to the foreground while it is not playing, and when it plays again after a long
   * pause. Offers only, never moves it.
   */
  private suspend fun reconcileLoaded() {
    val ref = engine.loadedBook ?: return
    val pulled = pull(ref)
    if (pulled is Pulled.Answered && pulled.row != null && engine.loadedBook == ref) checkOffer(listOf(pulled.row))
  }

  /** Offer another device's place for the loaded book (Offers.offerOf + the throttles); not over the speaker question. */
  private fun checkOffer(rows: List<ProgressRow>) {
    val ref = engine.loadedBook ?: return
    if (_offerPrompt.value != null || engine.state.value.speakerPrompt) return
    val row = rows.firstOrNull { it.ref == ref } ?: return
    val offer = Offers.offerOf(row, deviceId, acks.ackVersion(ref), engine.currentPosition, acks.answered(ref)) ?: return
    if (!offers.shouldShow(offer, ref, Instant.now())) return
    _offerPrompt.value = OfferPrompt(ref, offer, row)
  }

  /** Jump: move to the offered place (acknowledging the row). */
  fun jump(p: OfferPrompt) {
    acks.answerOffer(p.ref, p.row, p.offer.key)
    _offerPrompt.value = null
    if (engine.loadedBook == p.ref) engine.seek(p.offer.position, ListeningStart.JUMP)
  }

  /** Stay: this place stands (acknowledged), and the next span is a deliberate move. */
  fun stay(p: OfferPrompt) {
    acks.answerOffer(p.ref, p.row, p.offer.key)
    _offerPrompt.value = null
    if (engine.loadedBook == p.ref) engine.stay()
  }

  /** The offer closed with neither (swiped away): not offered again, nothing acknowledged. */
  fun ignore(p: OfferPrompt) {
    acks.ignoreOffer(p.ref, p.offer.key)
    _offerPrompt.value = null
  }

  // Books

  /** The Download button (and Try again): queue the book and start its worker. */
  fun download(row: ContinueRow) {
    queue(row.ref, row.title, row.author, sentAt = null)
    publishState()
  }

  /** Queue a book's record and start its worker; `sentAt` is the phone's, for a book it sent. */
  private fun queue(ref: BookRef, title: String, author: String?, sentAt: Instant?) {
    if (downloads.enqueue(ref, title, author, Instant.now(), sentAt)) BookWorker.enqueue(context, ref)
  }

  /** Q3: the listener chose the phone's connection (slow) for this book. */
  fun useSlowConnection(ref: BookRef) {
    downloads.update(ref) { it.copy(slow = true, waitingForWifi = false, message = null) } ?: return
    BookWorker.enqueue(context, ref, restart = true)
  }

  /** Remove a book from the watch: its work, its files, its item and its record. */
  fun removeBook(ref: BookRef) {
    val r = downloads.record(ref) ?: return
    // Removing the playing book stops it and closes its span first (decision 3).
    willRemove(ref)
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
      willRemove(r.ref)
      files.folder(r).deleteRecursively()
    }
    files.books.deleteRecursively()
  }

  private fun willRemove(ref: BookRef) {
    if (engine.loadedBook == ref) engine.stop()
    places.remove(ref)
    if (_offerPrompt.value?.ref == ref) _offerPrompt.value = null
  }

  // Messages from the phone

  /**
   * One of the phone's messages (PhoneLink's entry point), handled one at a time in
   * the order they came: a `book` that follows its `pair` is handled once that sign-in is done.
   * Returns when this message's turn is over, so the caller can put its receipt after.
   */
  suspend fun receive(m: PhoneMessage) {
    when (m) {
      is PhoneMessage.Pair -> serially { signIn(m.message) }
      is PhoneMessage.Book -> {
        // On disk now, not when its turn comes: a sign-in ahead of it can take a while, and the
        // phone has said "Sent", so a kill meanwhile must not lose it.
        held.hold(m.message, Instant.now())
        publishState()
        serially { releaseHeld() }
      }
      is PhoneMessage.Remove -> {
        val ticket = held.noteRemove(m.message)
        serially { remove(ticket) }
      }
    }
  }

  /** Give `work` its turn in the inbox and wait until that turn is over. */
  private suspend fun serially(work: suspend () -> Unit) {
    val done = CompletableDeferred<Unit>()
    inbox.trySend {
      try {
        work()
      } finally {
        done.complete(Unit)
      }
    }
    done.await()
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
    for (b in held.due(_account.value?.accountId, ready, Instant.now())) queue(b.ref, b.title, b.author, b.sentAt)
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
    // The open span goes into the outbox before the rule is asked.
    if (another) engine.stop()
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
      leaveAccount()
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
    if (inForeground) {
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

  /** The debug sign-in's word on a bad extra, on the setup screen (signed out only). */
  fun showSetupProblem(message: String) {
    if (_account.value == null) _phase.value = Phase.Setup(SetupStatus.Failed(message))
  }

  /** Keep this account: the blocked pair message is dropped, and its books can't come now. */
  fun keepAccount() {
    pendingPair?.let { held.giveUp(it.accountId, Instant.now()) }
    pendingPair = null
    _pendingReplace.value = null
    publishState()
  }

  /**
   * Sign out (decision 3): the player stops first (its span closes), then blocked while events wait
   * unless `discard`.
   */
  fun signOut(discard: Boolean): SignOutGate {
    engine.stop()
    val gate = AccountRules.signOut(outbox.unsentCount, discard)
    if (gate != SignOutGate.Allowed) return gate
    leaveAccount()
    _phase.value = Phase.Setup(SetupStatus.Waiting)
    publishState()
    return gate
  }

  /**
   * Forget the account and end its token on its server too. The client is taken first: forgetting
   * drops the token it needs. Quiet when the server can't be told (the watch has forgotten it).
   */
  private fun leaveAccount() {
    val leaving = client()
    forgetAccount()
    if (leaving != null) scope.launch { orNull { leaving.logout() } }
  }

  /** Drop everything of the account (AccountRules was asked first). */
  internal fun forgetAccount() {
    engine.stop()
    // Definitely gone now (a blocked or failed replace never gets here): no titles of it stay.
    held.forget(_account.value?.accountId ?: accountFile.read()?.accountId, Instant.now())
    removeAllBooks()
    library.clear()
    files.items.deleteRecursively()
    acks.clear()
    places.clear()
    outbox.discardAll()
    SyncWorker.cancelAll(context)
    backstopOn = false
    _offerPrompt.value = null
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

  /**
   * Work out `watch-state` now and hand it on when it is news (PhoneLink puts it). Always on the
   * main thread, one whole reading at a time: a book's worker and PhoneLink call it from their
   * own threads, and an older reading landing after a newer one would leave the phone with the
   * older state. Posted rather than locked: `HeldBooks.finishRemove` publishes while it holds its
   * own lock, which a lock here would deadlock against.
   */
  fun publishState() {
    if (!Looper.getMainLooper().isCurrentThread) {
      scope.launch { publishState() }
      return
    }
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
      records.filter { it.ref !in rowRefs }.map(DownloadRecord::stateBook) + rows
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
    private const val RETRY_INTERVAL_MS = (SyncSchedule.FOREGROUND_RETRY * 1000).toLong()

    /** How long the pull before play waits for the server. */
    private const val PULL_TIMEOUT_MS = 5_000L

    const val EXPIRED = "That sign-in has expired. Send again from your phone."

    @Volatile private var instance: AppModel? = null

    fun get(context: Context): AppModel =
      instance ?: synchronized(this) { instance ?: AppModel(context.applicationContext).also { instance = it } }
  }
}
