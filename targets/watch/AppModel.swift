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

  @Published private(set) var phase: Phase
  @Published private(set) var account: Account?
  /// A pair message for another account while events wait (decision 9): the count waiting.
  @Published private(set) var replaceBlocked: Int?
  @Published private(set) var server: ServerInfo?
  @Published var offerPrompt: OfferPrompt?
  /// Bumped whenever the outbox or its state changes (Sync status reads the outbox).
  @Published private(set) var syncRevision = 0
  @Published private(set) var syncing = false
  @Published private(set) var inForeground = true

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
  private let afterEmit = Relay()
  private var retryTimer: Timer?

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
    downloads.client = { [weak self] in self?.client() }
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
      guard phase == .ready else { return }
      await flush()
      if let api = client() {
        downloads.resumeAll()
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
    guard let info = try? await APIClient(base: router.base(for: a), token: nil).serverInfo() else { return }
    server = info
    ServerCache.save(info)
    phase = info.supportsWatch ? .ready : .tooOld(version: info.version)
  }

  // MARK: - Sync

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
    guard phase == .ready, let api = client(), outbox.unsentCount > 0 else { return }
    syncing = true
    await outbox.flush(via: api)
    syncing = false
    syncRevision += 1
    publishState()
  }

  /// Decision 10: the outbox's first chunk, with `clock_offset`, for the system to send.
  private func uploadInBackground() {
    guard phase == .ready, let a = account, let api = client(), let body = outbox.backgroundBody() else { return }
    SyncUploader.shared.enqueue(body, api: api, accountId: a.accountId)
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
    guard phase == .ready, outbox.unsentCount > 0 else { return }
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
  /// Core rule, and offer another device's place when that rule keeps this one.
  func play(_ record: DownloadRecord) async {
    guard record.state == .ready else { return }
    if engine.loadedBook == record.ref {
      engine.play()
      return
    }
    guard let timeline = ItemCache.load(record.ref)?.timeline else { return }
    let byPath = Dictionary(record.files.map { ($0.path, $0) }, uniquingKeysWith: { a, _ in a })
    let urls = timeline.files.compactMap { f in byPath[f.path].map { downloads.localURL(record, file: $0) } }
    guard urls.count == timeline.files.count, !urls.isEmpty else { return }
    let row = await pull(record.ref)
    let plan = Resume.plan(local: places.place(record.ref), row: row, deviceId: Files.deviceId,
                           ackVersion: acks.ackVersion(record.ref), total: timeline.total)
    if plan.tookRow, let row { acks.ackResume(row) }
    engine.load(LoadedBook(ref: record.ref, title: record.title, author: record.author, timeline: timeline, urls: urls),
                plan: plan)
    if !plan.tookRow, let row { checkOffer([row]) }
    engine.play()
  }

  /// The book's row from the server, nil offline (waits `PULL_TIMEOUT` at most).
  private func pull(_ ref: BookRef) async -> ProgressRow? {
    guard let api = client() else { return nil }
    return await withTaskGroup(of: ProgressRow?.self) { group in
      group.addTask { try? await api.progress(ref) }
      group.addTask {
        try? await Task.sleep(nanoseconds: UInt64(Self.PULL_TIMEOUT * 1_000_000_000))
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first
    }
  }

  /// Offer another device's place for the loaded book (Offers.offerOf + the throttles).
  private func checkOffer(_ rows: [ProgressRow]) {
    guard let ref = engine.loadedBook, offerPrompt == nil, let row = rows.first(where: { $0.ref == ref }) else { return }
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

  // MARK: - Messages from the phone

  private func receive(_ m: PhoneMessage) {
    switch m {
    case .pair(let p): Task { await signIn(p) }
    case .book(let b):
      // Only for the account this watch is signed in to.
      guard account?.accountId == b.accountId, phase == .ready else { return }
      downloads.enqueue(b.ref, title: b.title, author: b.author)
    }
  }

  /// Sign in from a `pair` message: exchange its token (base_url, then away, then home under
  /// pairingFallback's rule), keep the token in the keychain, then gate on the server.
  /// `discard`: the listener chose to drop what waits to replace the account.
  func signIn(_ p: PairMessage, discard: Bool = false) async {
    if account != nil && account?.accountId != p.accountId {
      // The open span goes into the outbox before the rule is asked.
      engine.stop()
    }
    let change = AccountRules.change(current: account?.accountId, incoming: p.accountId, unsent: outbox.unsentCount,
                                     discard: discard)
    if case .blocked(let n) = change {
      replaceBlocked = n
      pendingPair = p
      return
    }
    replaceBlocked = nil
    pendingPair = nil
    if p.expired(now: Date()) {
      if account == nil { phase = .setup(.expired) }
      return
    }
    if account == nil { phase = .setup(.signingIn) }
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
      if change == .replace { forgetAccount() }
      guard Keychain.setToken(session.token) else {
        if account == nil { phase = .setup(.failed("The watch could not keep its sign-in.")) }
        return
      }
      let a = Account(
        serverId: p.serverId, serverName: p.serverName, userId: p.userId,
        userName: p.userName.isEmpty ? session.user.username : p.userName, serverURL: p.serverURL,
        addresses: session.addresses ?? p.addresses, signedInAt: Date())
      Account.save(a)
      account = a
      router.start(at: AddressPicker.isOwn(base, serverURL: a.serverURL, addresses: a.addresses) ? base : nil)
      phase = .ready
      publishState()
      becameActive()
    } catch let e as APIError {
      if account == nil {
        phase = .setup(.failed(e.status == 401 || e.status == 404 ? "That sign-in has expired. Send again from your iPhone." : "Your server refused the sign-in (\(e.status))."))
      }
    } catch is WrongServer {
      if account == nil { phase = .setup(.failed("Another server answered. Send again from your iPhone.")) }
    } catch {
      if account == nil { phase = .setup(.failed("Can't reach your server. Send again from your iPhone when the watch is online.")) }
    }
  }

  /// Replace the account after all, dropping the listening that waits (an explicit choice).
  func replaceDiscarding() async {
    guard let p = pendingPair else { return }
    await signIn(p, discard: true)
  }

  /// Keep this account (the blocked pair message is dropped).
  func keepAccount() {
    pendingPair = nil
    replaceBlocked = nil
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
    acks.clear()
    places.clear()
    outbox.discardAll()
    SyncUploader.shared.cancelAll()
    router.reset()
    ServerCache.save(nil)
    server = nil
    offerPrompt = nil
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
        if let json = env["AUDIOSILO_DEBUG_BOOK"], let m = PhoneMessages.decodeJSON(json) { receive(m) }
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
