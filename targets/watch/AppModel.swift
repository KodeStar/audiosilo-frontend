// The watch app's state: the account (one per watch, decision 4), sign-in from the phone's
// `pair` message, the server gate (decision 5), the address in use, Continue listening, the
// books on the watch, and the Sync v2 pieces (acks, outbox, spans) the player wires up in pass 2.
import Foundation
import WatchKit

@MainActor
final class AppModel: ObservableObject {
  static let shared = AppModel()

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

  let router = AddressRouter()
  let library = ContinueListening()
  let downloads = DownloadManager()
  let acks = AckStore(url: Files.acks)
  let outbox: Outbox
  let spans: SpanRecorder
  /// PASS 2: the player (WatchAudioEngine).
  var player: WatchPlayer?

  private init() {
    let acks = self.acks
    let outbox = Outbox(directory: Files.root, acks: acks, deviceId: Files.deviceId)
    self.outbox = outbox
    spans = SpanRecorder(store: FileSpanStore(), acks: acks, emit: { outbox.append($0) })
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
    downloads.client = { [weak self] in self?.client() }
    downloads.willRemove = { [weak self] ref in
      if self?.player?.loadedBook == ref { self?.player?.stop() }
    }
    downloads.onChange = { [weak self] in self?.publishState() }
    outbox.onChange = { [weak self] in self?.publishState() }
    PhoneLink.shared.onMessage = { [weak self] m in self?.receive(m) }
    // A span a kill left open goes into the outbox before anything else (pass 2 sends it).
    spans.recover()
  }

  /// The client for the account's address now, with its token; nil when signed out.
  func client() -> APIClient? {
    guard let a = account, let token = Keychain.token() else { return nil }
    return APIClient(base: router.base(for: a), token: token)
  }

  // MARK: - Life cycle

  /// Launch and every return to the foreground.
  func becameActive() {
    guard let a = account else { return }
    router.startRechecks { [weak self] in self?.account }
    Task {
      await router.repick(a)
      await checkServer()
      if phase == .ready, let api = client() {
        downloads.resumeAll()
        await library.refresh(api)
      }
      // PASS 2: flush the outbox here (launch, foreground), after each closed span, on
      // reconnect; pull the book's row before play.
    }
  }

  func wentToBackground() {
    router.stopRechecks()
    if let a = account { router.leaveHome(a) }
    downloads.pause()
    // PASS 2: cut the playing span and enqueue the background upload of the outbox
    // (Outbox.backgroundBody, clock_offset), plus the WKApplicationRefreshBackgroundTask flush.
  }

  /// Ask the server whether it can serve the watch (kept for offline launches).
  func checkServer() async {
    guard let a = account else { return }
    guard let info = try? await APIClient(base: router.base(for: a), token: nil).serverInfo() else { return }
    server = info
    ServerCache.save(info)
    phase = info.supportsWatch ? .ready : .tooOld(version: info.version)
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
  func signIn(_ p: PairMessage) async {
    let replacing = account != nil && account?.accountId != p.accountId
    if replacing && outbox.unsentCount > 0 {
      // Decision 9: listening not yet synced blocks replacing the account. PASS 2: the
      // Sign out screen offers sending it, or discarding it explicitly.
      replaceBlocked = outbox.unsentCount
      return
    }
    replaceBlocked = nil
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
      if replacing { forgetAccount() }
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

  /// Drop everything of the account (its outbox is empty: decision 9 was checked first).
  private func forgetAccount() {
    player?.stop()
    downloads.removeAll()
    library.clear()
    acks.clear()
    outbox.discardAll()
    router.reset()
    ServerCache.save(nil)
    server = nil
    Keychain.setToken(nil)
    Account.save(nil)
    account = nil
  }

  // MARK: - The phone's view of the watch

  func publishState() {
    let books = downloads.records.map { r in
      WatchStateBook(ref: r.ref, title: r.title, state: r.state,
                     bytes: r.state == .ready ? r.files.compactMap(\.bytes).reduce(0, +) : nil)
    }
    PhoneLink.shared.publish(WatchState(
      signedIn: account != nil, serverId: account?.serverId, userId: account?.userId, appVersion: appVersion,
      books: books, unsentEvents: outbox.unsentCount, couldntSync: outbox.couldNotSync().count,
      lastSyncAt: outbox.state.lastSyncAt))
  }
}
