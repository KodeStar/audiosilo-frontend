import AVFoundation
import MediaPlayer
import UIKit

fileprivate extension Array {
  subscript(safe index: Int) -> Element? {
    indices.contains(index) ? self[index] : nil
  }
}

// MARK: - Engine

/// Whole-book gapless playback via AVQueuePlayer, plus background audio session,
/// Now Playing metadata and lock-screen remote commands. Positions are per-track;
/// the JS store maps them onto the whole-book timeline.
///
/// Phase 6 additions: chapter-relative Now Playing + chapter next/previous when `load` got 2+
/// chapter clips (ChapterClips.swift), `onRemoteMove` for every move the JS API did not ask
/// for, the rate command and Voice Boost (VoiceBoostTap.swift). The CarPlay side reads this
/// engine through AudioEngine+CarPlay.swift.
///
/// No Smart Speed on iOS (withdrawn in Phase 6 after a device test): the design raised
/// `player.rate` inside silences and put it back before the next word, and every AVPlayer rate
/// change while playing is an audible dropout on a real iPhone, so it stuttered at every pause.
/// `config.smartSpeed` is accepted and ignored; `onProgress` carries no `silenceSaved`.
final class AudioEngine: NSObject {
  /// The engine the module created (there is one per module instance). Weak: the module owns
  /// it. CarPlay (AudioEngine+CarPlay.swift) reaches the loaded book through this.
  private(set) static weak var shared: AudioEngine?

  private let player = AVQueuePlayer()
  private(set) var tracks: [TrackRecord] = []
  /// Items currently in the player, paired with their index in `tracks`.
  private var queued: [(index: Int, item: AVPlayerItem)] = []
  private(set) var currentIndex = 0
  /// The listener's speed: what `player.rate` is set to whenever we play.
  /// Named `baseRate` (not `rate`): CarPlay reads the speed through `CarPlayPlayerAccess.rate`.
  private(set) var baseRate: Float = 1.0
  /// Output gain (0...1) last asked for by JS - the sleep timer's fade-out. Held here
  /// (not just on the player) because the queue is torn down and rebuilt on every
  /// load/skip/retry; without re-applying it, a fade-in-progress would jump back to
  /// full volume the moment anything rebuilt the queue.
  private var volume: Float = 1.0
  private var autoRewindMax: Double = 0
  private var jumpForward: Double = 30
  private var jumpBackward: Double = 15
  private var pausedAt: Date?
  private var timeObserver: Any?
  private var statusObs: NSKeyValueObservation?
  private var itemObs: NSKeyValueObservation?
  private var itemStatusObs: NSKeyValueObservation?
  /// Observes the current item's `.failed` status so a stream that dies (server
  /// gone, network drop, unplayable) is reported as a sustained `loading` rather
  /// than a silent stall or a misleading `paused`. The shared JS store owns the
  /// stall→`error` decision (one 3s grace for every engine, never instant); this
  /// module only reports the raw transport state. Re-attached whenever the current
  /// item changes.
  private var failureObs: NSKeyValueObservation?
  private var artworkURL: String?
  /// Suppresses transient state/track events while the queue is being rebuilt
  /// (removeAllItems briefly sets currentItem to nil).
  private var rebuilding = false
  /// Start position (seconds) to apply once the current item is ready to play.
  /// 0 = none. Seeking a not-yet-ready AVPlayerItem is silently dropped, so the
  /// resume/skip seek is deferred until .readyToPlay (see applyPendingSeek).
  private var pendingSeek: Double = 0
  /// A play() was requested while a pendingSeek was still in flight - start the
  /// instant the seek lands, so audio never briefly begins at 0.
  private var wantsPlay = false
  /// Observes the current item's readiness to run the deferred start seek.
  private var startObs: NSKeyValueObservation?
  /// Whether playback was active when an audio-session interruption began - only
  /// then do we auto-resume on .ended (so the charging chime can't resume a book
  /// the user had paused).
  private var wasPlayingBeforeInterruption = false
  /// Retained handler tokens for the shared MPRemoteCommandCenter so deinit can remove
  /// them. The center is an app-wide singleton that retains each added block for the
  /// app's lifetime; without removal a recreated engine leaks its predecessor's handlers
  /// (they linger as [weak self] no-ops on the shared center). Paired with their command.
  private var commandTargets: [(command: MPRemoteCommand, target: Any)] = []
  private let send: (String, [String: Any]) -> Void

  /// The loaded book's chapter clips (the same ones Android plays as clipped items). Active
  /// with 2+ clips; otherwise every path below keeps the whole-file behaviour.
  private(set) var clips = ChapterClips()
  /// `load`'s 5th argument: which book the queue is (nil from an older JS bundle). CarPlay
  /// names the loaded book with it (`loadedBookId`); cleared by `reset`.
  private(set) var book: BookRecord?
  /// The clip Now Playing currently shows (nil in whole-file mode). Changes post
  /// `.audiosiloPlayerDidChange`.
  private(set) var nowPlayingClip: Int?
  /// A remote move (lock screen, headset, CarPlay) that rebuilt the queue and is waiting for
  /// its deferred start seek: `onRemoteMove` goes out once that seek lands, not before (JS
  /// would otherwise save the pre-seek 0). Cleared by any newer rebuild.
  private var remoteMovePending = false
  /// Items a Voice Boost tap was requested for (see `attachVoiceBoostTaps`). Cleared with the
  /// queue on every rebuild, so an identifier is never compared against a freed item.
  private var tapRequested = Set<ObjectIdentifier>()

  init(send: @escaping (String, [String: Any]) -> Void) {
    // Every onState also tells the CarPlay templates (`.audiosiloPlayerDidChange`, the one
    // engine -> CarPlay notification; the play state is read back from the engine).
    self.send = { name, body in
      send(name, body)
      if name == "onState" { AudioEngine.postPlayerDidChange() }
    }
    super.init()
    configureSession()
    setupRemoteCommands()
    observePlayer()
    observeNotifications()
    startProgressTimer()
    AudioEngine.shared = self
  }

  // MARK: Session

  private func configureSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio)
      try session.setActive(true)
    } catch {
      // best effort - playback still works without long-form policy
    }
  }

  func setConfig(_ c: ConfigRecord) {
    autoRewindMax = c.autoRewindMax
    jumpForward = c.jumpForward
    jumpBackward = c.jumpBackward
    let cc = MPRemoteCommandCenter.shared()
    cc.skipForwardCommand.preferredIntervals = [NSNumber(value: jumpForward)]
    cc.skipBackwardCommand.preferredIntervals = [NSNumber(value: jumpBackward)]
    // Voice Boost: only flip the flag every tap reads (the tap ramps toward it). Every item
    // already carries its tap (`attachVoiceBoostTaps`), so a toggle never touches `audioMix`.
    VoiceBoost.isEnabled = c.voiceBoost
  }

  // MARK: Queue

  private func makeItem(_ t: TrackRecord) -> AVPlayerItem? {
    guard let url = URL(string: t.url) else { return nil }
    let asset: AVURLAsset
    if let headers = t.headers, !headers.isEmpty {
      // "AVURLAssetHTTPHeaderFieldsKey" is the undocumented/unofficial AVFoundation
      // option for injecting request headers (no public symbol exists). It is the
      // mechanism we rely on for the Authorization header on streams; if Apple ever
      // changes it, native stream auth breaks (cover art uses a separate URLRequest).
      asset = AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])
    } else {
      asset = AVURLAsset(url: url)
    }
    let item = AVPlayerItem(asset: asset)
    item.audioTimePitchAlgorithm = .timeDomain // pitch-corrected speed for speech
    return item
  }

  /// Give the current item and the two after it their Voice Boost tap, whatever the switch
  /// (bypassed inside while it is off). Why every item, switch on or not: setting `audioMix` on
  /// an item that is PLAYING rebuilds its render chain, an audible ~1 s dropout on a device
  /// (found on an iPhone Air when the switch only attached taps on its first enable). So the
  /// mix is set while an item is still waiting (the asset's tracks load before the item can
  /// play, and the first item's resume seek waits for readiness too), and a toggle afterwards
  /// only flips `VoiceBoost.isEnabled`.
  ///
  /// Why a window and not the whole queue: `loadTracks` on a streamed asset reads the file's
  /// header over HTTP, and a book can be a hundred files. Two ahead means the next item got its
  /// tap a whole file earlier, before AVQueuePlayer prerolls it for the gapless hand-over.
  /// Playback never waits for a tap: an item whose tracks are slow to load plays untapped
  /// meanwhile (`VoiceBoost.attach` is asynchronous).
  private func attachVoiceBoostTaps() {
    guard let cur = player.currentItem,
          let start = queued.firstIndex(where: { $0.item === cur }) else { return }
    for q in queued[start..<min(queued.count, start + 3)] {
      let id = ObjectIdentifier(q.item)
      guard !tapRequested.contains(id) else { continue }
      tapRequested.insert(id)
      VoiceBoost.attach(to: q.item)
    }
  }

  func load(tracks: [TrackRecord], startIndex: Int, position: Double, chapters: [ChapterRecord], book: BookRecord?) {
    self.tracks = tracks
    self.book = book
    clips = Self.validClips(chapters, trackCount: tracks.count)
    nowPlayingClip = nil
    rebuildQueue(from: max(0, min(startIndex, tracks.count - 1)), position: position)
    send("onState", ["state": "ready"])
  }

  /// The clips `load` received, or none when any is unusable (a file index outside the
  /// tracks): the same safe fallback to file mode `buildChapterClips` takes in JS.
  private static func validClips(_ chapters: [ChapterRecord], trackCount: Int) -> ChapterClips {
    var out: [ChapterClip] = []
    for c in chapters {
      guard c.fileIndex >= 0, c.fileIndex < trackCount, c.startInFile.isFinite, c.endInFile.isFinite else {
        return ChapterClips()
      }
      out.append(ChapterClip(fileIndex: c.fileIndex, startInFile: max(0, c.startInFile),
                             endInFile: c.endInFile, title: c.title))
    }
    return ChapterClips(out)
  }

  /// Rebuild the player queue starting at `startIndex`. AVQueuePlayer plays its
  /// remaining items gaplessly; arbitrary skips rebuild from the target index.
  ///
  /// `remote`: a lock-screen / headset / CarPlay move. `onRemoteMove` goes out once the target
  /// has landed: at once for a 0 target (no deferred seek), else when the deferred seek lands.
  private func rebuildQueue(from startIndex: Int, position: Double, remote: Bool = false) {
    rebuilding = true
    remoteMovePending = false
    startObs?.invalidate()
    startObs = nil
    player.pause()
    player.removeAllItems()
    queued.removeAll()
    tapRequested.removeAll()
    guard startIndex < tracks.count else { rebuilding = false; pendingSeek = 0; return }
    for i in startIndex..<tracks.count {
      guard let item = makeItem(tracks[i]) else { continue }
      queued.append((index: i, item: item))
      player.insert(item, after: nil)
    }
    currentIndex = startIndex
    attachVoiceBoostTaps()
    // Re-assert the intended gain on the rebuilt queue. Today the AVQueuePlayer instance
    // itself is reused (only its items are swapped), so this is belt-and-braces - but if
    // it is ever recreated here, a fade must not silently reset to full volume.
    player.volume = volume
    // Defer the start seek until the item is actually ready. Seeking a freshly
    // created AVPlayerItem before .readyToPlay is silently dropped - especially
    // for streaming assets - which made resume play the book from 0.
    pendingSeek = max(0, position)
    remoteMovePending = remote && pendingSeek > 0
    applyPendingSeek()
    reassertRateWhenReady()
    observeItemFailure()
    rebuilding = false
    updateNowPlayingInfo()
    send("onTrackChange", ["index": currentIndex])
    sendProgress(position)
    if remote && !remoteMovePending && pendingSeek == 0 { emitRemoteMove() }
  }

  /// Apply the queued start position once the current item can honor it. If it's
  /// already ready, seek now; otherwise wait for .readyToPlay (mirrors
  /// reassertRateWhenReady, which exists for the same not-ready-yet reason).
  private func applyPendingSeek() {
    guard pendingSeek > 0, let item = player.currentItem else { pendingSeek = 0; return }
    if item.status == .readyToPlay {
      performPendingSeek(on: item)
      return
    }
    startObs?.invalidate()
    startObs = item.observe(\.status, options: [.new]) { [weak self] item, _ in
      guard let self = self, item.status == .readyToPlay else { return }
      DispatchQueue.main.async { self.performPendingSeek(on: item) }
    }
  }

  private func performPendingSeek(on item: AVPlayerItem) {
    // A deferred readiness callback hops to main async, so a newer load() can swap the
    // current item before it runs. Ignore a stale item: proceeding would invalidate the
    // NEW load's startObs and consume its pendingSeek, then seek the old item - leaving
    // the new book stuck at 0 (its deferred resume seek never fires).
    guard item === player.currentItem else { return }
    startObs?.invalidate()
    startObs = nil
    guard pendingSeek > 0 else { return }
    let target = pendingSeek
    pendingSeek = 0
    item.seek(to: CMTime(seconds: target, preferredTimescale: 1000)) { [weak self] finished in
      Self.onMain {
        guard let self = self else { return }
        // Start playback only now, so audio begins at the resumed position not at 0.
        if self.wantsPlay {
          self.wantsPlay = false
          self.player.rate = self.baseRate
        }
        self.sendProgress(self.player.currentTime().seconds)
        self.updateNowPlayingInfo()
        // The remote move this rebuild was for has landed (a newer rebuild clears the flag,
        // and a stale item never gets here: see the guard above).
        if self.remoteMovePending, item === self.player.currentItem {
          self.remoteMovePending = false
          if finished { self.emitRemoteMove() }
        }
      }
    }
  }

  /// AVPlayer can silently drop a `rate` set on a not-yet-ready item back to 1.0 once
  /// that item becomes ready - which made the chosen speed revert to 1x when a
  /// mid-playback download swap replaced the streaming item with the local file (the
  /// JS state still showed the old speed because the engine never reads `rate` back).
  /// Watch the freshly-current item and re-assert the intended rate once it's ready.
  private func reassertRateWhenReady() {
    itemStatusObs?.invalidate()
    itemStatusObs = nil
    guard let item = player.currentItem, item.status != .readyToPlay else { return }
    itemStatusObs = item.observe(\.status, options: [.new]) { [weak self] item, _ in
      guard let self = self, item.status == .readyToPlay else { return }
      DispatchQueue.main.async {
        if self.player.rate != 0, self.player.rate != self.baseRate {
          self.player.rate = self.baseRate
        }
      }
    }
  }

  /// Watch the current item for a fatal `.failed` status and report it as a sustained
  /// `loading` to JS. A failed item parks the player at `.paused`, which would look
  /// like a user pause; reporting `loading` instead lets the shared JS stall watchdog
  /// promote it to `error` after the same grace as a mid-stream stall - uniform, and
  /// never instant (an instant error caused a rapid-retry race). Re-attach on every
  /// current-item change (skip/advance/rebuild).
  private func observeItemFailure() {
    failureObs?.invalidate()
    failureObs = nil
    guard let item = player.currentItem else { return }
    if item.status == .failed {
      send("onState", ["state": "loading"])
      return
    }
    failureObs = item.observe(\.status, options: [.new]) { [weak self] item, _ in
      guard let self = self, !self.rebuilding, item.status == .failed else { return }
      DispatchQueue.main.async { self.send("onState", ["state": "loading"]) }
    }
  }

  /// Shared handler for both mid-item trouble notifications: `failedToPlayToEndTime`
  /// (a stream that was playing became unreachable - fires instead of flipping
  /// `.status` to `.failed`) and `playbackStalled` (buffer underrun). Report a
  /// sustained `loading` so the shared JS stall watchdog surfaces `error` after its
  /// grace - every failure path converges on the same consistent, non-instant feedback.
  /// The observers are registered with object:nil (they fire for ANY item), so filter
  /// to the current item - a stale/queued item tearing down must not be attributed to
  /// the live stream and trip a spurious error. Capture n.object now, compare on main.
  @objc private func reportLoadingIfCurrent(_ n: Notification) {
    let item = n.object as? AVPlayerItem
    DispatchQueue.main.async {
      guard !self.rebuilding, item === self.player.currentItem else { return }
      self.send("onState", ["state": "loading"])
    }
  }

  // MARK: Transport

  /// Flip playback from the *real* transport state. All remote play/pause/toggle
  /// commands route here (see setupRemoteCommands) so a single earbud press always
  /// toggles, even when iOS's idea of our state is stale. A pending resume seek
  /// (wantsPlay) counts as "playing" so the press pauses it.
  private func togglePlayback() {
    if player.timeControlStatus != .paused || wantsPlay {
      pause()
    } else {
      play()
    }
  }

  func play() {
    // Reclaim the audio session so we're the active Now Playing app when (re)starting
    // - another app may have taken it since we last played.
    try? AVAudioSession.sharedInstance().setActive(true)
    if autoRewindMax > 0, let p = pausedAt, let item = player.currentItem {
      let elapsed = Date().timeIntervalSince(p)
      let rewind = min(autoRewindMax, elapsed)
      if rewind > 0.5 {
        // Auto-rewind is the engine's own move, never a remote one: no onRemoteMove.
        let target = max(0, item.currentTime().seconds - rewind)
        item.seek(to: CMTime(seconds: target, preferredTimescale: 1000))
      }
    }
    pausedAt = nil
    // A resume/skip seek hasn't landed yet - start the moment it does, so playback
    // begins at the saved position instead of at 0.
    if pendingSeek > 0 {
      wantsPlay = true
      // We want to play but are waiting for the item to become ready (resume/retry):
      // report 'loading' so the UI shows a spinner instead of an idle play button. The
      // shared JS stall watchdog surfaces `error` if it never becomes ready (dead stream).
      send("onState", ["state": "loading"])
      updateNowPlayingInfo()
      return
    }
    player.rate = baseRate
    updateNowPlayingInfo()
  }

  func pause() {
    wantsPlay = false
    player.pause()
    pausedAt = Date()
    updateNowPlayingInfo()
  }

  /// Seek within the current file. `remote` = the lock screen, a headset or CarPlay asked
  /// (never the JS API): `onRemoteMove` goes out once the seek has landed, after its
  /// `onProgress`.
  func seek(to seconds: Double, remote: Bool = false) {
    player.seek(to: CMTime(seconds: max(0, seconds), preferredTimescale: 1000)) { [weak self] finished in
      Self.onMain {
        guard let self = self else { return }
        self.sendProgress(self.player.currentTime().seconds)
        self.updateNowPlayingInfo()
        // A superseded seek (finished == false) didn't land: the newer one reports.
        if remote && finished { self.emitRemoteMove() }
      }
    }
  }

  func seek(by delta: Double, remote: Bool = false) {
    seek(to: player.currentTime().seconds + delta, remote: remote)
  }

  /// Jump to a file at a position. `remote`: see `seek(to:remote:)`; a non-zero target lands
  /// only once the rebuilt item is ready, so the event waits for the deferred seek.
  func skip(to index: Int, position: Double, remote: Bool = false) {
    guard index >= 0, index < tracks.count else { return }
    let wasPlaying = player.timeControlStatus != .paused || wantsPlay
    rebuildQueue(from: index, position: position, remote: remote)
    // Route through play() so a non-zero target waits for the deferred seek before
    // starting, instead of beginning at 0 on the freshly-rebuilt (not-ready) item.
    if wasPlaying { play() }
  }

  func skipToNext(remote: Bool = false) {
    if currentIndex + 1 < tracks.count { skip(to: currentIndex + 1, position: 0, remote: remote) }
  }

  func skipToPrevious(remote: Bool = false) {
    if currentIndex - 1 >= 0 {
      skip(to: currentIndex - 1, position: 0, remote: remote)
    } else {
      seek(to: 0, remote: remote)
    }
  }

  func setRate(_ r: Double) {
    baseRate = Float(r)
    if player.rate != 0 { player.rate = baseRate }
    updateNowPlayingInfo()
  }

  /// Set the player's own output gain (0...1). This is AVPlayer.volume - our audio,
  /// independent of the device/ringer volume - so a fade to 0 silences the book without
  /// touching the user's system volume. Sticky by design (see `volume`): whoever faded
  /// down is responsible for restoring it.
  func setVolume(_ v: Double) {
    volume = Float(max(0, min(1, v)))
    player.volume = volume
  }

  func reset() {
    itemStatusObs?.invalidate()
    itemStatusObs = nil
    failureObs?.invalidate()
    failureObs = nil
    startObs?.invalidate()
    startObs = nil
    pendingSeek = 0
    wantsPlay = false
    remoteMovePending = false
    player.pause()
    player.removeAllItems()
    queued.removeAll()
    tapRequested.removeAll()
    tracks = []
    book = nil
    clips = ChapterClips()
    nowPlayingClip = nil
    currentIndex = 0
    pausedAt = nil
    artworkURL = nil
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    syncPlaybackState()
    send("onState", ["state": "idle"])
  }

  private func currentDuration() -> Double {
    if let d = player.currentItem?.duration.seconds, d.isFinite, d > 0 { return d }
    return tracks[safe: currentIndex]?.duration ?? 0
  }

  /// Where the current file is, or is about to be: the deferred start seek's target while it
  /// is still pending (the fresh item reads 0 until it lands).
  func currentPosition() -> Double {
    if pendingSeek > 0 { return pendingSeek }
    let t = player.currentTime().seconds
    return t.isFinite ? t : 0
  }

  /// Whether the engine is playing or about to (a start waiting for its deferred seek).
  var isPlaying: Bool { player.timeControlStatus != .paused || wantsPlay }

  private func sendProgress(_ position: Double) {
    send("onProgress", ["position": position, "duration": currentDuration()])
  }

  /// `onRemoteMove` with where the engine now is (file index + seconds in that file).
  private func emitRemoteMove() {
    guard !tracks.isEmpty else { return }
    send("onRemoteMove", ["trackIndex": currentIndex, "position": currentPosition()])
  }

  /// CarPlay's bookmark button: `onRemoteBookmark` with the file and position right now (a
  /// pending start seek's target while one is waiting).
  func emitRemoteBookmark() {
    guard !tracks.isEmpty else { return }
    send("onRemoteBookmark", ["trackIndex": currentIndex, "position": currentPosition()])
  }

  /// Run on the main thread: AVFoundation's seek completion handlers don't promise a queue.
  private static func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
  }

  // MARK: Observers

  private func observePlayer() {
    // Both KVO callbacks can fire on an internal AVFoundation thread. Hop to main
    // before touching engine state (currentIndex, queued, Now Playing) so they stay
    // serialized with the main-thread mutators (rebuildQueue/skip); otherwise
    // currentIndex tears. This mirrors the item observers, which already hop. Re-reading
    // p.* on main also avoids acting on a value already superseded by a newer rebuild
    // (e.g. the transient nil currentItem during removeAllItems).
    statusObs = player.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
      DispatchQueue.main.async {
        guard let self = self, !self.rebuilding else { return }
        let state: String
        switch p.timeControlStatus {
        case .playing:
          state = "playing"
        case .waitingToPlayAtSpecifiedRate:
          // Wants to play but can't (buffering / underrun). With
          // automaticallyWaitsToMinimizeStalling on (the default), this is where a
          // stalled stream lands - report 'loading'; the shared JS stall watchdog
          // promotes a stall that doesn't recover within its grace to 'error'.
          state = "loading"
        case .paused:
          // A failed item also parks the player at .paused - keep reporting 'loading'
          // there so the JS watchdog treats it as a dead stream, not a user pause.
          if p.currentItem?.status == .failed {
            state = "loading"
          } else {
            state = (p.currentItem == nil && !self.tracks.isEmpty) ? "ended" : "paused"
          }
        @unknown default:
          state = "paused"
        }
        self.syncPlaybackState()
        self.send("onState", ["state": state])
      }
    }
    itemObs = player.observe(\.currentItem, options: [.new]) { [weak self] p, _ in
      DispatchQueue.main.async {
        guard let self = self, !self.rebuilding else { return }
        if let cur = p.currentItem, let match = self.queued.first(where: { $0.item === cur }) {
          self.observeItemFailure() // re-attach to the now-current item
          // Slide the Voice Boost window: the item two ahead gets its tap now, a whole file
          // before it plays.
          self.attachVoiceBoostTaps()
          if match.index != self.currentIndex {
            // A natural file advance: never a remote move.
            self.currentIndex = match.index
            self.updateNowPlayingInfo()
            self.send("onTrackChange", ["index": self.currentIndex])
          }
        } else if p.currentItem == nil && !self.tracks.isEmpty {
          self.send("onState", ["state": "ended"])
        }
      }
    }
  }

  private func startProgressTimer() {
    let interval = CMTime(seconds: 1.0, preferredTimescale: 1)
    timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
      // Don't report progress while a (re)load is in flight: a fresh AVPlayerItem
      // reads currentTime() == 0 until it's ready AND the deferred resume seek has
      // applied. Emitting that 0 would clobber the saved position in JS - which made
      // a retry after a failed reload resume the book from the start.
      guard let self = self,
            self.pendingSeek == 0,
            let item = self.player.currentItem,
            item.status == .readyToPlay else { return }
      let pos = time.seconds.isFinite ? time.seconds : 0
      self.sendProgress(pos)
      self.updateNowPlayingElapsed(pos)
    }
  }

  private func observeNotifications() {
    let nc = NotificationCenter.default
    nc.addObserver(self, selector: #selector(handleInterruption(_:)),
                   name: AVAudioSession.interruptionNotification, object: nil)
    nc.addObserver(self, selector: #selector(handleRouteChange(_:)),
                   name: AVAudioSession.routeChangeNotification, object: nil)
    nc.addObserver(self, selector: #selector(reportLoadingIfCurrent(_:)),
                   name: AVPlayerItem.failedToPlayToEndTimeNotification, object: nil)
    nc.addObserver(self, selector: #selector(reportLoadingIfCurrent(_:)),
                   name: AVPlayerItem.playbackStalledNotification, object: nil)
  }

  @objc private func handleInterruption(_ n: Notification) {
    guard let info = n.userInfo,
          let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    switch type {
    case .began:
      // Capture intent *before* pausing (pause() clears wantsPlay).
      wasPlayingBeforeInterruption = player.timeControlStatus != .paused || wantsPlay
      pause()
    case .ended:
      // Only auto-resume if we were actually playing when the interruption began.
      // The charging chime (and other brief system sounds) fire an interruption
      // whose .ended carries .shouldResume; without this guard that resumes a book
      // the user had paused - e.g. playback starting when the phone is plugged in.
      guard wasPlayingBeforeInterruption else { return }
      if let optsRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt,
         AVAudioSession.InterruptionOptions(rawValue: optsRaw).contains(.shouldResume) {
        play()
      }
    @unknown default:
      break
    }
  }

  @objc private func handleRouteChange(_ n: Notification) {
    guard let info = n.userInfo,
          let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
    if reason == .oldDeviceUnavailable { pause() } // e.g. headphones unplugged
  }

  // MARK: Remote commands

  /// The speeds the lock screen / CarPlay rate button offer (`changePlaybackRateCommand`).
  static let supportedRates: [NSNumber] = [0.75, 1, 1.25, 1.5, 1.75, 2]

  /// Add a remote-command handler and retain its token so deinit can remove it.
  private func addCommand(_ command: MPRemoteCommand,
                          _ handler: @escaping (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus) {
    commandTargets.append((command, command.addTarget(handler: handler)))
  }

  private func setupRemoteCommands() {
    // Receive hardware remote-control events (Bluetooth/AVRCP earbud, wired headset).
    UIApplication.shared.beginReceivingRemoteControlEvents()
    let cc = MPRemoteCommandCenter.shared()
    // A single earbud/headset press is a *toggle*, but iOS/AVRCP delivers it as a
    // discrete Play OR Pause chosen from iOS's own notion of our play state - which
    // on iOS a third-party app can't correct (MPNowPlayingInfoCenter.playbackState is
    // entitlement-gated and silently ignored, so iOS infers the state itself and can
    // get stuck on "paused"). When it guesses wrong it sends Play while we're already
    // playing, so the press no-ops and the user has to press a second time. Routing
    // Play, Pause and Toggle all through one real-state toggle makes a single press
    // always flip playback, regardless of what iOS believes.
    addCommand(cc.playCommand) { [weak self] _ in self?.togglePlayback(); return .success }
    addCommand(cc.pauseCommand) { [weak self] _ in self?.togglePlayback(); return .success }
    addCommand(cc.togglePlayPauseCommand) { [weak self] _ in self?.togglePlayback(); return .success }
    // Every move below is a REMOTE move (onRemoteMove once it lands): the JS store treats it
    // as the listener's own and lowers the resume floor (decision 11).
    cc.skipForwardCommand.preferredIntervals = [NSNumber(value: jumpForward)]
    addCommand(cc.skipForwardCommand) { [weak self] event in
      guard let self = self else { return .commandFailed }
      self.seek(by: (event as? MPSkipIntervalCommandEvent)?.interval ?? self.jumpForward, remote: true)
      return .success
    }
    cc.skipBackwardCommand.preferredIntervals = [NSNumber(value: jumpBackward)]
    addCommand(cc.skipBackwardCommand) { [weak self] event in
      guard let self = self else { return .commandFailed }
      self.seek(by: -((event as? MPSkipIntervalCommandEvent)?.interval ?? self.jumpBackward), remote: true)
      return .success
    }
    addCommand(cc.changePlaybackPositionCommand) { [weak self] event in
      guard let self = self, let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      self.remoteScrub(to: e.positionTime)
      return .success
    }
    addCommand(cc.nextTrackCommand) { [weak self] _ in self?.remoteNext(); return .success }
    addCommand(cc.previousTrackCommand) { [weak self] _ in self?.remotePrevious(); return .success }
    // CarPlay's Now Playing rate button needs this command (and the rates it may offer). The
    // engine applies the rate, then tells JS so the store's speed follows (it doesn't call
    // setRate back).
    cc.changePlaybackRateCommand.supportedPlaybackRates = Self.supportedRates
    addCommand(cc.changePlaybackRateCommand) { [weak self] event in
      guard let self = self, let e = event as? MPChangePlaybackRateCommandEvent,
            e.playbackRate > 0 else { return .commandFailed }
      self.setRateFromRemote(Double(e.playbackRate))
      return .success
    }
  }

  /// A speed chosen outside the app (the rate command, CarPlay's rate button): apply it, then
  /// send `onRateChange` once so the store's speed follows (the store doesn't call setRate back).
  func setRateFromRemote(_ r: Double) {
    guard r > 0, r.isFinite else { return }
    setRate(r)
    send("onRateChange", ["rate": r])
  }

  /// The clip the playhead is in (nil in whole-file mode).
  func currentClip() -> Int? {
    guard clips.isActive else { return nil }
    return clips.index(fileIndex: currentIndex, position: currentPosition())
  }

  /// Move to a chapter target from a remote command. Same file and a settled item: a plain
  /// seek. Another file, or an item still waiting for its deferred start seek (a seek on a
  /// not-ready item is silently dropped): a rebuild through skip(to:position:), which owns
  /// that deferral.
  func moveRemotely(to target: ClipTarget) {
    if target.fileIndex == currentIndex, pendingSeek == 0, player.currentItem?.status == .readyToPlay {
      seek(to: target.position, remote: true)
    } else {
      skip(to: target.fileIndex, position: target.position, remote: true)
    }
  }

  /// The lock-screen scrubber. With chapters its time is chapter-relative (Now Playing shows
  /// the chapter), so it maps into the shown clip, clamped inside it.
  private func remoteScrub(to positionTime: Double) {
    guard let ci = nowPlayingClip ?? currentClip() else {
      seek(to: positionTime, remote: true)
      return
    }
    let fileDuration = currentDuration()
    guard let target = clips.filePosition(clip: ci, chapterTime: positionTime,
                                          fileDuration: fileDuration > 0 ? fileDuration : nil) else { return }
    moveRemotely(to: target)
  }

  /// Next chapter (the last chapter: nothing), or the next file without chapters.
  private func remoteNext() {
    guard let ci = currentClip() else { skipToNext(remote: true); return }
    guard let target = clips.next(from: ci) else { return }
    moveRemotely(to: target)
  }

  /// Previous chapter, or this chapter's start when more than 3 s in; the previous file
  /// without chapters.
  private func remotePrevious() {
    guard let ci = currentClip() else { skipToPrevious(remote: true); return }
    guard let target = clips.previous(from: ci, position: currentPosition()) else { return }
    moveRemotely(to: target)
  }

  // MARK: Now Playing

  /// Now Playing's rate: the listener's speed while playing, 0 while paused.
  private var nowPlayingRate: Float { player.rate != 0 ? baseRate : 0 }

  private func updateNowPlayingInfo() {
    guard currentIndex < tracks.count else { return }
    let t = tracks[currentIndex]
    var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
    let fileDuration = currentDuration()
    let pos = currentPosition()
    if clips.isActive, let ci = clips.index(fileIndex: currentIndex, position: pos) {
      // Chapter mode (decision 10): the chapter is the "track" (title, a chapter-relative
      // scrubber, chapter number/count), the book is the album.
      let c = clips.clips[ci]
      let times = clips.nowPlayingTimes(clip: ci, position: pos, fileDuration: fileDuration > 0 ? fileDuration : nil)
      info[MPMediaItemPropertyTitle] = c.title.isEmpty ? t.title : c.title
      info[MPMediaItemPropertyArtist] = t.artist ?? ""
      info[MPMediaItemPropertyAlbumTitle] = t.title
      info[MPMediaItemPropertyPlaybackDuration] = times.duration ?? max(0, fileDuration - c.startInFile)
      info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = times.elapsed
      // Zero-based, per MPNowPlayingInfoPropertyChapterNumber.
      info[MPNowPlayingInfoPropertyChapterNumber] = ci
      info[MPNowPlayingInfoPropertyChapterCount] = clips.count
      setNowPlayingClip(ci)
    } else {
      info[MPMediaItemPropertyTitle] = t.title
      info[MPMediaItemPropertyArtist] = t.artist ?? ""
      info[MPMediaItemPropertyAlbumTitle] = t.album ?? t.title
      info[MPMediaItemPropertyPlaybackDuration] = fileDuration
      info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = player.currentTime().seconds
      info[MPNowPlayingInfoPropertyChapterNumber] = nil
      info[MPNowPlayingInfoPropertyChapterCount] = nil
      setNowPlayingClip(nil)
    }
    info[MPNowPlayingInfoPropertyPlaybackRate] = nowPlayingRate
    // The listener's speed even while paused: CarPlay's rate button reads it (without it the
    // button shows 0x while paused, since PlaybackRate is 0 then).
    info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = baseRate
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    syncPlaybackState()
    loadArtwork(t.artwork, headers: t.headers)
  }

  /// Tell Now Playing whether we play. On a device iOS ignores this (it reads the audio
  /// session: MPNowPlayingInfoCenter.h, "This only applies on macOS"), but the iOS SIMULATOR is
  /// macOS underneath: without it mediaremoted keeps the app "Paused" forever (its log shows only
  /// `PlaybackState changed from Unknown to Paused`, on the pre-Phase-6 engine too), so CarPlay's
  /// Now Playing window showed a play button, a frozen 0:00 and a "0x" rate while the book
  /// played. Setting it there flips mediaremoted to Playing (checked in the Simulator). From the
  /// real transport state, so it can't disagree with the earbud toggle either.
  private func syncPlaybackState() {
    let state: MPNowPlayingPlaybackState = tracks.isEmpty ? .stopped : (isPlaying ? .playing : .paused)
    let center = MPNowPlayingInfoCenter.default()
    if center.playbackState != state { center.playbackState = state }
  }

  /// The 1 s tick: elapsed (and rate) only, unless the playhead crossed into another chapter,
  /// which needs the whole info (title, duration, number).
  private func updateNowPlayingElapsed(_ pos: Double) {
    if clips.isActive {
      let ci = clips.index(fileIndex: currentIndex, position: pos)
      if ci != nowPlayingClip {
        updateNowPlayingInfo()
        return
      }
    }
    var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
    if let ci = nowPlayingClip, let c = clips.clips[safe: ci] {
      info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, pos - c.startInFile)
    } else {
      info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = pos
    }
    info[MPNowPlayingInfoPropertyPlaybackRate] = nowPlayingRate
    info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = baseRate
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  private func setNowPlayingClip(_ ci: Int?) {
    guard ci != nowPlayingClip else { return }
    nowPlayingClip = ci
    Self.postPlayerDidChange()
  }

  private func loadArtwork(_ urlString: String?, headers: [String: String]?) {
    guard let urlString = urlString, let url = URL(string: urlString), artworkURL != urlString else { return }
    artworkURL = urlString
    var req = URLRequest(url: url)
    headers?.forEach { req.setValue($1, forHTTPHeaderField: $0) }
    URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
      guard let self = self, let data = data, let image = UIImage(data: data) else { return }
      let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
      DispatchQueue.main.async {
        guard self.artworkURL == urlString else { return }
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
        info[MPMediaItemPropertyArtwork] = artwork
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
      }
    }.resume()
  }

  deinit {
    if let timeObserver = timeObserver { player.removeTimeObserver(timeObserver) }
    statusObs?.invalidate()
    itemObs?.invalidate()
    itemStatusObs?.invalidate()
    failureObs?.invalidate()
    startObs?.invalidate()
    for (command, target) in commandTargets { command.removeTarget(target) }
    commandTargets.removeAll()
    NotificationCenter.default.removeObserver(self)
  }
}
