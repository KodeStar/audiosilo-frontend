// The watch app's state: the account (one per watch, decision 4), sign-in from the phone's
// `pair` message (and, in DEBUG builds, from the launch environment), the server gate (decision
// 5), the address in use, Continue listening, the books on the watch, the player, and Sync v2:
// the outbox is sent at launch, on coming to the foreground and after each closed span, and in
// the background as a background URLSession upload with `clock_offset` (decision 10) plus a
// best-effort refresh task. Signing out or replacing the account is blocked while events wait,
// unless the listener discards them (decision 9).
import Foundation
import WatchKit

/// Another device's place offered for the loaded book (Jump / Stay).
struct OfferPrompt: Identifiable, Equatable {
  var ref: BookRef
  var offer: PlaceOffer
  var row: ProgressRow

  var id: String { "\(ref.key)|\(offer.key)" }
}

@MainActor
final class AppModel: ObservableObject {
  static let shared = AppModel()
  /// How long the pull before play waits for the server.
  static let PULL_TIMEOUT: TimeInterval = 5
  /// The best-effort refresh task's interval (decision 10).
  static let REFRESH_INTERVAL: TimeInterval = 15 * 60
  static let refreshTask = "sync"
  /// How often the foreground tries again while events wait (the reconnect trigger: a flush
  /// that gets an answer makes the server reachable, so the 15 s cuts start again).
  static let RETRY_INTERVAL: TimeInterval = 60

  enum SetupStatus: Equatable {
    /// Nothing received yet: "Open AudioSilo on your iPhone".
    case waiting
    case signingIn
    /// The pairing token was past `expires_at`: "Send again from your iPhone".
    case expired
    case failed(String)
  }

  enum Phase: Equatable {
    case setup(SetupStatus)
    /// The server lacks `listening_sync` or the watch rendition (needs 2.6 or later).
    case tooOld(version: String?)
    case ready
  }

  /// A pair message for another account, on Home until it is settled (decision 9).
  enum PendingReplace: Equatable {
    /// Listening waited when it came: sync it (or discard it), then switch, or keep this account.
    case waiting
    /// Signing in to the other account: nothing plays until it is done, so no listening made
    /// meanwhile is dropped with this account's.
    case switching
    /// It did not happen (an expired sign-in, a refusal, no answer): why, in plain words.
    case failed(String)
  }

  @Published private(set) var phase: Phase
  @Published private(set) var account: Account?
  @Published private(set) var pendingReplace: PendingReplace?
  @Published private(set) var server: ServerInfo?
  @Published var offerPrompt: OfferPrompt?
  /// Bumped whenever the outbox or its state changes (Sync status reads the outbox).
  @Published private(set) var syncRevision = 0
  @Published private(set) var syncing = false
  /// False until the scene first becomes active: a launch for a background wake is not in front.
  @Published private(set) var inForeground = false

  let router = AddressRouter()
  let library = ContinueListening()
  let downloads = DownloadManager()
  let acks = AckStore(url: Files.acks)
  let places = PlaceStore(url: Files.places)
  let outbox: Outbox
  let spans: SpanRecorder
  let engine: WatchAudioEngine
  private let offers = OfferThrottle()
  /// The pair message a blocked replace waits on.
  private var pendingPair: PairMessage?
  /// Books the phone sent for `pendingPair`'s account, queued once that sign-in succeeds.
  private var pendingBooks: [BookMessage] = []
  /// The phone's messages, handled one at a time in order (`receive`).
  private var inbox: Task<Void, Never>?
  private let afterEmit = Relay()
  private var retryTimer: Timer?
  /// The newest ask to play: one still pulling its row when another came goes no further.
  private var playGeneration = 0

  private init() {
    let acks = self.acks
    let outbox = Outbox(directory: Files.root, acks: acks, deviceId: Files.deviceId)
    let relay = afterEmit
    self.outbox = outbox
    let spans = SpanRecorder(store: FileSpanStore(), acks: acks, emit: { events in
      outbox.append(events)
      relay.call?()
    })
    self.spans = spans
    engine = WatchAudioEngine(spans: spans, places: places)
    let account = Keychain.token() == nil ? nil : Account.load()
    let server = ServerCache.load()
    self.account = account
    self.server = server
    if account == nil {
      phase = .setup(.waiting)
    } else if let s = server, !s.supportsWatch {
      phase = .tooOld(version: s.version)
    } else {
      phase = .ready
    }
    relay.call = { [weak self] in self?.spanClosed() }
    engine.reachable = { [weak self] in !(self?.outbox.lastFlushFailed ?? true) }
    engine.onPickedUp = { [weak self] in
      guard let self else { return }
      Task { await self.reconcileLoaded() }
    }
    downloads.client = { [weak self] in self?.client() }
    downloads.homeAddress = { [weak self] in self?.account?.addresses?.home }
    downloads.willRemove = { [weak self] ref in
      // Removing the playing book stops it and closes its span first (decision 8).
      if self?.engine.loadedBook == ref { self?.engine.stop() }
      self?.places.remove(ref)
    }
    downloads.onChange = { [weak self] in self?.publishState() }
    outbox.onChange = { [weak self] in
      self?.syncRevision += 1
      self?.publishState()
    }
    outbox.onAnswer = { [weak self] rows in self?.checkOffer(rows) }
    SyncUploader.shared.handler = { [weak self] answer in
      MainActor.assumeIsolated { self?.applyUpload(answer) }
    }
    PhoneLink.shared.onMessage = { [weak self] m in self?.receive(m) }
    // A span a kill left open goes into the outbox before anything else (sent on becoming active).
    spans.recover()
    #if DEBUG
      debugSignIn()
    #endif
  }

  /// The client for the account's address now, with its token; nil when signed out.
  func client() -> APIClient? {
    guard let a = account, let token = Keychain.token() else { return nil }
    return APIClient(base: router.base(for: a), token: token)
  }

  // MARK: - Life cycle

  /// Launch and every return to the foreground.
  func becameActive() {
    inForeground = true
    guard let a = account else { return }
    router.startRechecks { [weak self] in self?.account }
    retryTimer?.invalidate()
    retryTimer = Timer.scheduledTimer(withTimeInterval: Self.RETRY_INTERVAL, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self, self.outbox.unsentCount > 0, !self.syncing else { return }
        await self.flush()
      }
    }
    Task {
      await router.repick(a)
      await checkServer()
      await refreshAddresses(of: a)
      // Before the gate: a server without the watch rendition still takes the listening.
      await flush()
      guard phase == .ready else { return }
      if let api = client() {
        // Not when the app went to the background meanwhile (the downloads were paused).
        if inForeground {
          downloads.resumeAll()
          if !engine.playing && !engine.starting { await reconcileLoaded() }
        }
        await library.refresh(api)
      }
    }
  }

  func wentToBackground() {
    inForeground = false
    router.stopRechecks()
    retryTimer?.invalidate()
    retryTimer = nil
    if let a = account { router.leaveHome(a) }
    downloads.pause()
    // Sync v2: the playing span is cut, then what waits goes as a background upload.
    engine.cutForBackground()
    uploadInBackground()
    scheduleRefresh()
  }

  /// Ask the server whether it can serve the watch (kept for offline launches).
  func checkServer() async {
    guard let a = account else { return }
    guard let info = try? await APIClient(base: router.base(for: a), token: nil).serverInfo(),
      // Signed out (or switched) while it was asked: the answer is no longer this account's.
      account?.accountId == a.accountId
    else { return }
    server = info
    ServerCache.save(info)
    phase = info.supportsWatch ? .ready : .tooOld(version: info.version)
  }

  /// Keep what the server says its addresses are now (the phone's `refreshAddresses`): one moved
  /// since the pairing would otherwise go on failing here. Quiet on any failure.
  private func refreshAddresses(of a: Account) async {
    guard server?.capabilities?.addresses == true, let api = client(), let fresh = try? await api.addresses(),
      // Signed out or switched while it was asked: the answer is no longer this account's.
      var now = account, now.accountId == a.accountId
    else { return }
    let merged = AddressPicker.merge(prior: now.addresses, fresh: fresh)
    guard merged != now.addresses else { return }
    now.addresses = merged
    Account.save(now)
    account = now
    // Not in the background: leaving home dropped the home pick, and no probe runs there.
    if inForeground { await router.repick(now) }
  }

  // MARK: - Sync

  /// Whether what waits can be sent. The listening needs only Sync v2: a server without the watch
  /// rendition (`.tooOld`, ffmpeg gone) still takes it, so it is not held until it is discarded.
  private var canSync: Bool {
    account != nil && (phase == .ready || server?.capabilities?.listeningSync == true)
  }

  /// A span closed into the outbox: send it. In the background (audio keeps the app running)
  /// it is tried the same way, and what still waits goes to the background upload.
  private func spanClosed() {
    Task {
      await flush()
      if !inForeground && outbox.unsentCount > 0 { uploadInBackground() }
    }
  }

  /// Send what waits now (one flush at a time; the outbox coalesces calls).
  func flush() async {
    guard canSync, let api = client(), outbox.unsentCount > 0 else { return }
    syncing = true
    await outbox.flush(via: api)
    syncing = false
    syncRevision += 1
    publishState()
  }

  /// Decision 10: the outbox's first chunk, with `clock_offset`, for the system to send. Never
  /// to the home address, whatever the pick: the system may send it on another network, where
  /// nothing runs the `server_id` probe first (a home-only server syncs in the foreground).
  private func uploadInBackground() {
    guard canSync, let a = account, let token = Keychain.token(),
      let base = AddressPicker.unattended(serverURL: a.serverURL, addresses: a.addresses),
      let body = outbox.backgroundBody()
    else { return }
    SyncUploader.shared.enqueue(body, api: APIClient(base: base, token: token), accountId: a.accountId)
  }

  /// A background upload's answer (a later wake, or while running): applied like a foreground one.
  private func applyUpload(_ answer: SyncUploadAnswer) {
    guard BackgroundSync.applies(answer.tag, accountId: account?.accountId),
      case .answered(let response) = answer.outcome
    else { return }
    outbox.applyBackground(response, sentIds: answer.tag.ids)
    if !inForeground, outbox.unsentCount > 0 { uploadInBackground() }
  }

  /// The best-effort refresh task (decision 10): flush, else leave the background upload.
  func backgroundRefresh() async {
    guard canSync, outbox.unsentCount > 0 else { return }
    await flush()
    if outbox.unsentCount > 0 {
      uploadInBackground()
      scheduleRefresh()
    }
  }

  private func scheduleRefresh() {
    guard outbox.unsentCount > 0 else { return }
    WKApplication.shared().scheduleBackgroundRefresh(
      withPreferredDate: Date().addingTimeInterval(Self.REFRESH_INTERVAL),
      userInfo: Self.refreshTask as NSString
    ) { _ in }
  }

  // MARK: - Playing

  /// Play a book on the watch: pull its row first (a few seconds at most), resume by the
  /// Core rule, and offer another device's place when that rule keeps this one. With no
  /// answer, the server's place kept for it stands in (the last Continue listening refresh's,
  /// or the one read when its download started), so an in-progress book never opens at 0
  /// offline (the phone's keepServerPlace).
  func play(_ record: DownloadRecord) async {
    guard record.state == .ready, pendingReplace != .switching, let who = account?.accountId else { return }
    playGeneration += 1
    let mine = playGeneration
    if engine.loadedBook == record.ref {
      engine.play()
      return
    }
    guard let cache = ItemCache.load(record.ref) else { return }
    let timeline = cache.timeline
    let byPath = Dictionary(record.files.map { ($0.path, $0) }, uniquingKeysWith: { a, _ in a })
    let urls = timeline.files.compactMap { f in byPath[f.path].map { downloads.localURL(record, file: $0) } }
    guard urls.count == timeline.files.count, !urls.isEmpty else { return }
    let pulled = await pull(record.ref)
    // Asked to play something else (or the same book again), a switch or a sign-out, or the book
    // removed meanwhile: this one no longer plays.
    guard mine == playGeneration, account?.accountId == who, pendingReplace != .switching,
      downloads.record(record.ref)?.state == .ready
    else { return }
    let row: ProgressRow?
    switch pulled {
    case .answered(let r): row = r  // nil: the server has no place for it
    case .noAnswer: row = [library.keptPlace(record.ref), cache.serverPlace].compactMap { $0 }.max { $0.version < $1.version }
    }
    let local = places.place(record.ref)
    let plan = Resume.plan(local: local, row: row, deviceId: Files.deviceId, ackVersion: acks.ackVersion(record.ref),
                           total: timeline.total, waiting: outbox.events.contains { $0.ref == record.ref })
    if plan.tookRow, let row { acks.ackResume(row) }
    engine.load(LoadedBook(ref: record.ref, title: record.title, author: record.author, timeline: timeline, urls: urls),
                plan: plan, savedSpeed: Resume.savedSpeed(plan, local: local, row: row))
    // Offered only from the server's answer, never from a kept place.
    if !plan.tookRow, case .answered(let r?) = pulled { checkOffer([r]) }
    engine.play()
  }

  /// The book's row from the server (`.answered(nil)`: it has none), or `.noAnswer` offline
  /// (waits `PULL_TIMEOUT` at most).
  private func pull(_ ref: BookRef) async -> PulledRow {
    guard let api = client() else { return .noAnswer }
    return await withTaskGroup(of: PulledRow.self) { group in
      group.addTask {
        do { return .answered(try await api.progress(ref)) } catch { return .noAnswer }
      }
      group.addTask {
        try? await Task.sleep(for: .seconds(Self.PULL_TIMEOUT))
        return .noAnswer
      }
      let first = await group.next() ?? .noAnswer
      group.cancelAll()
      return first
    }
  }

  /// Ask the server about the loaded book, which plays from the engine's place with no pull of
  /// its own: on coming to the foreground while it is not playing, and when it plays again after
  /// a long pause (the phone's `reconcileLoadedPlace`). Offers only, never moves it.
  private func reconcileLoaded() async {
    guard let ref = engine.loadedBook, case .answered(let row?) = await pull(ref), engine.loadedBook == ref else { return }
    checkOffer([row])
  }

  /// Offer another device's place for the loaded book (Offers.offerOf + the throttles). Not over
  /// the speaker question: it comes again with the next answer.
  private func checkOffer(_ rows: [ProgressRow]) {
    guard let ref = engine.loadedBook, offerPrompt == nil, !engine.speakerPrompt,
      let row = rows.first(where: { $0.ref == ref })
    else { return }
    guard let offer = Offers.offerOf(row, deviceId: Files.deviceId, ackVersion: acks.ackVersion(ref),
                                     enginePosition: engine.position, answered: acks.answered(ref)),
      offers.shouldShow(offer, for: ref, now: Date())
    else { return }
    offerPrompt = OfferPrompt(ref: ref, offer: offer, row: row)
  }

  /// Jump: move to the offered place (acknowledging the row).
  func jump(_ p: OfferPrompt) {
    acks.answerOffer(p.ref, row: p.row, key: p.offer.key)
    offerPrompt = nil
    if engine.loadedBook == p.ref { engine.seek(to: p.offer.position, reason: .jump) }
  }

  /// Stay: this place stands (acknowledged), and the next span is a deliberate move.
  func stay(_ p: OfferPrompt) {
    acks.answerOffer(p.ref, row: p.row, key: p.offer.key)
    offerPrompt = nil
    if engine.loadedBook == p.ref { engine.stay() }
  }

  /// The offer closed with neither (swiped away): not offered again, nothing acknowledged (the
  /// phone's toast timing out, `ignoreOffer`). After Jump or Stay its key is noted already.
  func ignore(_ p: OfferPrompt) {
    acks.ignoreOffer(p.ref, key: p.offer.key)
  }

  // MARK: - Messages from the phone

  /// The phone's messages, one at a time in order (the listener's switch queues the same way):
  /// a `book` that follows its `pair` (the phone sends both to a watch not signed in to that
  /// connection) is handled once that sign-in is done.
  private func receive(_ m: PhoneMessage) {
    serially { await self.handle(m) }
  }

  private func serially(_ work: @escaping @MainActor () async -> Void) {
    let previous = inbox
    inbox = Task {
      await previous?.value
      await work()
    }
  }

  /// Until the messages the phone has handed over are handled (a background wake for them).
  func messagesHandled() async {
    // What the delegate hopped to the main queue joins the inbox first.
    await Task.yield()
    var last: Task<Void, Never>?
    while let tail = inbox, tail != last {
      last = tail
      await tail.value
    }
  }

  private func handle(_ m: PhoneMessage) async {
    switch m {
    case .pair(let p): await signIn(p)
    case .book(let b):
      if account?.accountId == b.accountId, phase == .ready {
        downloads.enqueue(b.ref, title: b.title, author: b.author)
      } else if pendingPair?.accountId == b.accountId {
        // For the account a blocked replace waits on: queued once that sign-in succeeds.
        pendingBooks.append(b)
      }
    }
  }

  /// Sign in from a `pair` message: exchange its token (base_url, then away, then home under
  /// pairingFallback's rule), keep the token in the keychain, then gate on the server.
  /// `discard`: the listener chose to drop what waits to replace the account.
  func signIn(_ p: PairMessage, discard: Bool = false) async {
    let another = account != nil && account?.accountId != p.accountId
    // An expired pairing token is never tried, and stops nothing.
    if p.expired(now: Date()) {
      if account == nil {
        phase = .setup(.expired)
      } else if another {
        pendingReplace = .failed("That sign-in has expired. Send again from your iPhone.")
        pendingPair = nil
        pendingBooks = []
      }
      return
    }
    if another {
      // The open span goes into the outbox before the rule is asked.
      engine.stop()
    }
    let change = AccountRules.change(current: account?.accountId, incoming: p.accountId, unsent: outbox.unsentCount,
                                     discard: discard)
    if case .blocked = change {
      pendingReplace = .waiting
      pendingPair = p
      pendingBooks.removeAll { $0.accountId != p.accountId }
      return
    }
    let held = pendingBooks.filter { $0.accountId == p.accountId }
    pendingBooks = []
    pendingPair = nil
    pendingReplace = change == .replace ? .switching : nil
    if account == nil { phase = .setup(.signingIn) }
    /// Why it failed: on the setup screen, or on Home when it was replacing another account
    /// (a same-account refresh fails quietly: its sign-in stands).
    func failed(_ message: String) {
      if account == nil {
        phase = .setup(.failed(message))
      } else if change == .replace {
        pendingReplace = .failed(message)
      }
    }
    struct WrongServer: Error {}
    let deviceName = WKInterfaceDevice.current().name
    do {
      let (session, base) = try await AddressPicker.exchange(
        base: p.baseURL, addresses: p.addresses, serverId: p.serverId,
        attempt: { url -> AuthSession in
          let s = try await APIClient(base: url, token: nil).exchange(pairingToken: p.pairingToken, deviceName: deviceName)
          guard s.serverId == p.serverId, s.user.id == p.userId else { throw WrongServer() }
          return s
        },
        isTimeout: APIClient.isTimeout, probe: APIClient.probeServerId)
      if change == .replace {
        // Its token ends on its server too (as Sign out does): this watch forgets it now. A sign-in
        // again for the same account keeps its old token, as the phone does.
        let leaving = client()
        forgetAccount()
        if let leaving { Task { try? await leaving.logout() } }
      } else if change == .signIn, Account.load()?.accountId != p.accountId {
        // The token was lost, and what is here is another account's: never sent under this one.
        forgetAccount()
      }
      guard Keychain.setToken(session.token) else {
        failed("The watch could not keep its sign-in.")
        return
      }
      let a = Account(
        serverId: p.serverId, serverName: p.serverName, userId: p.userId,
        userName: p.userName.isEmpty ? session.user.username : p.userName, serverURL: p.serverURL,
        addresses: AddressPicker.merge(prior: p.addresses, fresh: session.addresses), signedInAt: Date())
      Account.save(a)
      account = a
      router.start(at: AddressPicker.isOwn(base, serverURL: a.serverURL, addresses: a.addresses) ? base : nil)
      phase = .ready
      pendingReplace = nil
      publishState()
      for b in held { downloads.enqueue(b.ref, title: b.title, author: b.author) }
      if !inForeground {
        // A message delivered in the background (background audio, a wake): no foreground
        // timers and no home pick (dropped as on going to the background); the front runs
        // becameActive when the listener raises the watch.
        router.leaveHome(a)
        Task {
          await checkServer()
          await backgroundRefresh()
        }
      } else {
        becameActive()
      }
    } catch let e as APIError {
      failed(e.status == 401 || e.status == 404 ? "That sign-in has expired. Send again from your iPhone." : "Your server refused the sign-in (\(e.status)).")
    } catch is WrongServer {
      failed("Another server answered. Send again from your iPhone.")
    } catch {
      failed("Can't reach your server. Send again from your iPhone when the watch is online.")
    }
  }

  /// Switch to the account the blocked pair message is for: `discard` drops the listening that
  /// waits (an explicit choice); without it, the switch is blocked again if listening waits.
  func replace(discard: Bool) {
    serially {
      guard let p = self.pendingPair else { return }
      await self.signIn(p, discard: discard)
    }
  }

  /// Keep this account (the blocked pair message, and its books, are dropped).
  func keepAccount() {
    pendingPair = nil
    pendingBooks = []
    pendingReplace = nil
  }

  /// Sign out (decision 9): stops the player first (its span closes), then blocked while
  /// events wait unless `discard`.
  @discardableResult
  func signOut(discard: Bool) -> SignOutGate {
    engine.stop()
    let gate = AccountRules.signOut(unsent: outbox.unsentCount, discard: discard)
    guard gate == .allowed else { return gate }
    if let api = client() { Task { try? await api.logout() } }
    forgetAccount()
    phase = .setup(.waiting)
    publishState()
    return gate
  }

  /// Drop everything of the account (decision 9 was checked first).
  private func forgetAccount() {
    engine.stop()
    downloads.removeAll()
    library.clear()
    // Continue listening's item caches too (removeAll takes only the downloaded books').
    try? FileManager.default.removeItem(at: Files.items)
    acks.clear()
    places.clear()
    outbox.discardAll()
    SyncUploader.shared.cancelAll()
    router.reset()
    ServerCache.save(nil)
    server = nil
    offerPrompt = nil
    pendingReplace = nil
    pendingPair = nil
    pendingBooks = []
    Keychain.setToken(nil)
    Account.save(nil)
    account = nil
  }

  // MARK: - DEBUG sign-in

  #if DEBUG
    /// The simulator has no paired phone, and simctl cannot tap, so the launch environment
    /// stands in (`SIMCTL_CHILD_<NAME>=... xcrun simctl launch ...`; not in release builds):
    /// - `AUDIOSILO_DEBUG_PAIR`: a v1 `pair` message as JSON, signed in as if the phone had sent
    ///   it (ignored when already signed in to that account). `scripts/watch-debug-pair.mjs`
    ///   mints one.
    /// - `AUDIOSILO_DEBUG_BOOK`: a v1 `book` message as JSON, queued like the Download button.
    /// - `AUDIOSILO_DEBUG_PLAY=1`: play the first book on the watch once signed in.
    private func debugSignIn() {
      let env = ProcessInfo.processInfo.environment
      var pair: PairMessage?
      if let json = env["AUDIOSILO_DEBUG_PAIR"], !json.isEmpty {
        guard case .pair(let p)? = PhoneMessages.decodeJSON(json) else {
          phase = .setup(.failed("AUDIOSILO_DEBUG_PAIR is not a v1 pair message."))
          return
        }
        if account?.accountId != p.accountId { pair = p }
      }
      Task {
        if let pair { await signIn(pair) }
        if let json = env["AUDIOSILO_DEBUG_BOOK"], let m = PhoneMessages.decodeJSON(json) { await handle(m) }
        if env["AUDIOSILO_DEBUG_PLAY"] == "1", let r = downloads.records.first(where: { $0.state == .ready }) {
          await play(r)
        }
      }
    }
  #endif

  // MARK: - The phone's view of the watch

  func publishState() {
    let books = downloads.records.map { r in
      WatchStateBook(ref: r.ref, title: r.title, state: r.state,
                     bytes: r.state == .ready ? r.bytes : nil)
    }
    PhoneLink.shared.publish(WatchState(
      signedIn: account != nil, serverId: account?.serverId, userId: account?.userId, appVersion: appVersion,
      books: books, unsentEvents: outbox.unsentCount, couldntSync: outbox.couldNotSync().count,
      lastSyncAt: outbox.state.lastSyncAt))
  }
}

/// A late-bound callback (the span recorder's emit runs before `self` exists).
private final class Relay {
  var call: (() -> Void)?
}

/// What the pull before play got: the server's answer, which may be no row at all, or none
/// (offline, or slower than `PULL_TIMEOUT`). Only no answer lets a kept place stand in.
private enum PulledRow: Sendable {
  case answered(ProgressRow?)
  case noAnswer
}
