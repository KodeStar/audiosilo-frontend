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
/// for, the rate command, Voice Boost (VoiceBoostTap.swift) and Smart Speed (SmartSpeed.swift).
/// The CarPlay side reads this engine through AudioEngine+CarPlay.swift.
final class AudioEngine: NSObject {
  /// The engine the module created (there is one per module instance). Weak: the module owns
  /// it. CarPlay (AudioEngine+CarPlay.swift) reaches the loaded book through this.
  private(set) static weak var shared: AudioEngine?

  private let player = AVQueuePlayer()
  private(set) var tracks: [TrackRecord] = []
  /// Items currently in the player, paired with their index in `tracks`.
  private var queued: [(index: Int, item: AVPlayerItem)] = []
  private(set) var currentIndex = 0
  /// The listener's speed (the BASE rate). Smart Speed boosts on top of it (`effectiveRate`);
  /// Now Playing always shows this one.
  private var rate: Float = 1.0
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
  /// The clip Now Playing currently shows (nil in whole-file mode). Changes post
  /// `AudioEngine.chaptersDidChange`.
  private(set) var nowPlayingClip: Int?
  /// A remote move (lock screen, headset, CarPlay) that rebuilt the queue and is waiting for
  /// its deferred start seek: `onRemoteMove` goes out once that seek lands, not before (JS
  /// would otherwise save the pre-seek 0). Cleared by any newer rebuild.
  private var remoteMovePending = false
  /// Seeks issued and not yet completed. While non-zero the playhead isn't settled, so Smart
  /// Speed neither boosts nor trusts `currentTime()` (boundary observers don't fire on seeks).
  /// Only Smart Speed reads it. A rebuild zeroes it and bumps `seekGeneration`, so a
  /// completion that never comes (a seek on an item torn down) can't hold it up for longer
  /// than until the next load or skip.
  private var seeksInFlight = 0
  private var seekGeneration = 0
  /// Voice Boost taps are attached to items only once the switch has been on in this engine's
  /// life: a listener who never enables it keeps the exact pre-Phase-6 audio path (no audio
  /// mix on any item). Once attached, a tap stays and is bypassed inside (`VoiceBoost.isEnabled`),
  /// so toggling never rebuilds or re-mixes an item.
  private var voiceBoostAttached = false
  private lazy var smart = SmartSpeed(host: self)

  init(send: @escaping (String, [String: Any]) -> Void) {
    // Every onState also reaches the CarPlay side (AudioEngine.playbackStateDidChange), on main
    // like the JS event.
    self.send = { name, body in
      send(name, body)
      guard name == "onState" else { return }
      DispatchQueue.main.async {
        NotificationCenter.default.post(name: AudioEngine.playbackStateDidChange, object: nil, userInfo: body)
      }
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
    // Voice Boost: flip the flag every tap reads (ramped inside the tap). The first enable
    // attaches taps to the items already queued; later items get one in makeItem.
    VoiceBoost.isEnabled = c.voiceBoost
    if c.voiceBoost && !voiceBoostAttached {
      voiceBoostAttached = true
      for q in queued { VoiceBoost.attach(to: q.item) { _ in } }
    }
    smart.setEnabled(c.smartSpeed)
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
    // The tap attaches asynchronously once the asset's tracks load; the item plays meanwhile
    // (it never waits for the tap).
    if voiceBoostAttached { VoiceBoost.attach(to: item) { _ in } }
    return item
  }

  func load(tracks: [TrackRecord], startIndex: Int, position: Double, chapters: [ChapterRecord]) {
    self.tracks = tracks
    clips = Self.validClips(chapters, trackCount: tracks.count)
    nowPlayingClip = nil
    smart.load(trackURLs: tracks.map { URL(string: $0.url) })
    rebuildQueue(from: max(0, min(startIndex, tracks.count - 1)), position: position)
    send("onState", ["state": "ready"])
    postChaptersDidChange()
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
    seeksInFlight = 0
    seekGeneration += 1
    smart.cancelBoost(restoreRate: false)
    startObs?.invalidate()
    startObs = nil
    player.pause()
    player.removeAllItems()
    queued.removeAll()
    guard startIndex < tracks.count else { rebuilding = false; pendingSeek = 0; return }
    for i in startIndex..<tracks.count {
      guard let item = makeItem(tracks[i]) else { continue }
      queued.append((index: i, item: item))
      player.insert(item, after: nil)
    }
    currentIndex = startIndex
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
    smart.playheadMoved()
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
    let done = beginSeek()
    item.seek(to: CMTime(seconds: target, preferredTimescale: 1000)) { [weak self] finished in
      Self.onMain {
        guard let self = self else { return }
        done()
        // Start playback only now, so audio begins at the resumed position not at 0.
        if self.wantsPlay {
          self.wantsPlay = false
          self.player.rate = self.effectiveRate
        }
        self.sendProgress(self.player.currentTime().seconds)
        self.updateNowPlayingInfo()
        // The remote move this rebuild was for has landed (a newer rebuild clears the flag,
        // and a stale item never gets here: see the guard above).
        if self.remoteMovePending, item === self.player.currentItem {
          self.remoteMovePending = false
          if finished { self.emitRemoteMove() }
        }
        self.smart.playheadMoved()
      }
    }
  }

  /// Count a seek in flight for Smart Speed; the returned closure ends it (main thread). A
  /// rebuild in between makes it a no-op (see `seekGeneration`).
  private func beginSeek() -> () -> Void {
    seeksInFlight += 1
    let generation = seekGeneration
    return { [weak self] in
      guard let self = self, self.seekGeneration == generation else { return }
      self.seeksInFlight = max(0, self.seeksInFlight - 1)
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
        if self.player.rate != 0, self.player.rate != self.effectiveRate {
          self.player.rate = self.effectiveRate
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

  /// The rate the player should run at: the base rate, or Smart Speed's boost while the
  /// playhead is inside a known silence. Every path that starts or re-asserts playback uses
  /// this, so a boost is applied on top of the base and dropped with it.
  private var effectiveRate: Float { smart.boostedRate ?? rate }

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
    smart.cancelBoost(restoreRate: false)
    if autoRewindMax > 0, let p = pausedAt, let item = player.currentItem {
      let elapsed = Date().timeIntervalSince(p)
      let rewind = min(autoRewindMax, elapsed)
      if rewind > 0.5 {
        // Auto-rewind is the engine's own move, never a remote one: no onRemoteMove.
        let target = max(0, item.currentTime().seconds - rewind)
        let done = beginSeek()
        item.seek(to: CMTime(seconds: target, preferredTimescale: 1000)) { [weak self] _ in
          Self.onMain {
            done()
            self?.smart.playheadMoved()
          }
        }
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
    player.rate = rate
    updateNowPlayingInfo()
    smart.evaluate()
  }

  func pause() {
    wantsPlay = false
    // Close any Smart Speed boost first: it counts the time saved up to the pause, and the
    // next play() starts from the base rate.
    smart.cancelBoost(restoreRate: false)
    player.pause()
    pausedAt = Date()
    updateNowPlayingInfo()
  }

  /// Seek within the current file. `remote` = the lock screen, a headset or CarPlay asked
  /// (never the JS API): `onRemoteMove` goes out once the seek has landed, after its
  /// `onProgress`.
  func seek(to seconds: Double, remote: Bool = false) {
    smart.cancelBoost(restoreRate: true)
    let done = beginSeek()
    player.seek(to: CMTime(seconds: max(0, seconds), preferredTimescale: 1000)) { [weak self] finished in
      Self.onMain {
        guard let self = self else { return }
        done()
        self.sendProgress(self.player.currentTime().seconds)
        self.updateNowPlayingInfo()
        // A superseded seek (finished == false) didn't land: the newer one reports.
        if remote && finished { self.emitRemoteMove() }
        self.smart.playheadMoved()
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
    // Close a boost measured against the old base; re-evaluated against the new one below.
    smart.cancelBoost(restoreRate: false)
    rate = Float(r)
    if player.rate != 0 { player.rate = rate }
    updateNowPlayingInfo()
    smart.evaluate()
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
    smart.reset()
    player.pause()
    player.removeAllItems()
    queued.removeAll()
    tracks = []
    clips = ChapterClips()
    nowPlayingClip = nil
    currentIndex = 0
    pausedAt = nil
    artworkURL = nil
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    send("onState", ["state": "idle"])
    postChaptersDidChange()
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
    send("onProgress", ["position": position, "duration": currentDuration(), "silenceSaved": smart.silenceSaved])
  }

  /// `onRemoteMove` with where the engine now is (file index + seconds in that file).
  private func emitRemoteMove() {
    guard !tracks.isEmpty else { return }
    send("onRemoteMove", ["trackIndex": currentIndex, "position": currentPosition()])
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
          // Paused from outside our pause() (the queue ended, a route change, the OS):
          // close any Smart Speed boost so the next play starts at the base rate.
          self.smart.cancelBoost(restoreRate: false)
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
        self.send("onState", ["state": state])
      }
    }
    itemObs = player.observe(\.currentItem, options: [.new]) { [weak self] p, _ in
      DispatchQueue.main.async {
        guard let self = self, !self.rebuilding else { return }
        if let cur = p.currentItem, let match = self.queued.first(where: { $0.item === cur }) {
          self.observeItemFailure() // re-attach to the now-current item
          if match.index != self.currentIndex {
            // A natural file advance: never a remote move. A boost from the previous file's
            // last silence must not carry into the next file's first words.
            self.smart.cancelBoost(restoreRate: true)
            self.currentIndex = match.index
            self.updateNowPlayingInfo()
            self.send("onTrackChange", ["index": self.currentIndex])
            self.smart.playheadMoved()
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
      self.smart.tick()
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
      self.setRate(Double(e.playbackRate))
      self.send("onRateChange", ["rate": Double(e.playbackRate)])
      return .success
    }
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

  /// Now Playing's rate: the listener's speed while playing (never Smart Speed's boost, which
  /// would make the lock screen's clock race through a silence), 0 while paused.
  private var nowPlayingRate: Float { player.rate != 0 ? rate : 0 }

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
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    loadArtwork(t.artwork, headers: t.headers)
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
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  private func setNowPlayingClip(_ ci: Int?) {
    guard ci != nowPlayingClip else { return }
    nowPlayingClip = ci
    postChaptersDidChange()
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

  /// Send an event to JS (used by the CarPlay side for its bookmark event).
  func emit(_ name: String, _ body: [String: Any]) {
    send(name, body)
  }

  deinit {
    if let timeObserver = timeObserver { player.removeTimeObserver(timeObserver) }
    smart.reset()
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

// MARK: - Smart Speed host

extension AudioEngine: SmartSpeedHost {
  var smartSpeedPlayer: AVQueuePlayer { player }
  var smartSpeedBaseRate: Float { rate }

  func smartSpeedPlayhead() -> (fileIndex: Int, time: Double, item: AVPlayerItem)? {
    guard !rebuilding, pendingSeek == 0, seeksInFlight == 0,
          let item = player.currentItem, item.status == .readyToPlay,
          let match = queued.first(where: { $0.item === item }) else { return nil }
    let t = item.currentTime().seconds
    guard t.isFinite else { return nil }
    return (match.index, t, item)
  }
}
