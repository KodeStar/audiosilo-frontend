import ExpoModulesCore
import AVFoundation
import MediaPlayer
import UIKit

// MARK: - Records

struct TrackRecord: Record {
  @Field var id: String = ""
  @Field var url: String = ""
  @Field var headers: [String: String]? = nil
  @Field var title: String = ""
  @Field var album: String? = nil
  @Field var artist: String? = nil
  @Field var artwork: String? = nil
  @Field var duration: Double? = nil
}

struct ConfigRecord: Record {
  @Field var autoRewindMax: Double = 0
  @Field var jumpForward: Double = 30
  @Field var jumpBackward: Double = 15
}

/// Chapter clips passed by the shared bridge for the Android lock screen. iOS accepts
/// them (so the `load` argument count matches) but ignores them — iOS plays file items
/// and uses MPRemoteCommandCenter for lock-screen controls.
struct ChapterRecord: Record {
  @Field var fileIndex: Int = 0
  @Field var startInFile: Double = 0
  @Field var endInFile: Double = 0
  @Field var title: String = ""
}

private extension Array {
  subscript(safe index: Int) -> Element? {
    indices.contains(index) ? self[index] : nil
  }
}

// MARK: - Engine

/// Whole-book gapless playback via AVQueuePlayer, plus background audio session,
/// Now Playing metadata and lock-screen remote commands. Positions are per-track;
/// the JS store maps them onto the whole-book timeline.
final class AudioEngine: NSObject {
  private let player = AVQueuePlayer()
  private var tracks: [TrackRecord] = []
  /// Items currently in the player, paired with their index in `tracks`.
  private var queued: [(index: Int, item: AVPlayerItem)] = []
  private var currentIndex = 0
  private var rate: Float = 1.0
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
  /// A play() was requested while a pendingSeek was still in flight — start the
  /// instant the seek lands, so audio never briefly begins at 0.
  private var wantsPlay = false
  /// Observes the current item's readiness to run the deferred start seek.
  private var startObs: NSKeyValueObservation?
  /// Whether playback was active when an audio-session interruption began — only
  /// then do we auto-resume on .ended (so the charging chime can't resume a book
  /// the user had paused).
  private var wasPlayingBeforeInterruption = false
  private let send: (String, [String: Any]) -> Void

  init(send: @escaping (String, [String: Any]) -> Void) {
    self.send = send
    super.init()
    configureSession()
    setupRemoteCommands()
    observePlayer()
    observeNotifications()
    startProgressTimer()
  }

  // MARK: Session

  private func configureSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio)
      try session.setActive(true)
    } catch {
      // best effort — playback still works without long-form policy
    }
  }

  func setConfig(_ c: ConfigRecord) {
    autoRewindMax = c.autoRewindMax
    jumpForward = c.jumpForward
    jumpBackward = c.jumpBackward
    let cc = MPRemoteCommandCenter.shared()
    cc.skipForwardCommand.preferredIntervals = [NSNumber(value: jumpForward)]
    cc.skipBackwardCommand.preferredIntervals = [NSNumber(value: jumpBackward)]
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

  func load(tracks: [TrackRecord], startIndex: Int, position: Double) {
    self.tracks = tracks
    rebuildQueue(from: max(0, min(startIndex, tracks.count - 1)), position: position)
    send("onState", ["state": "ready"])
  }

  /// Rebuild the player queue starting at `startIndex`. AVQueuePlayer plays its
  /// remaining items gaplessly; arbitrary skips rebuild from the target index.
  private func rebuildQueue(from startIndex: Int, position: Double) {
    rebuilding = true
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
    // Defer the start seek until the item is actually ready. Seeking a freshly
    // created AVPlayerItem before .readyToPlay is silently dropped — especially
    // for streaming assets — which made resume play the book from 0.
    pendingSeek = max(0, position)
    applyPendingSeek()
    reassertRateWhenReady()
    observeItemFailure()
    rebuilding = false
    updateNowPlayingInfo()
    send("onTrackChange", ["index": currentIndex])
    send("onProgress", ["position": position, "duration": currentDuration()])
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
    startObs?.invalidate()
    startObs = nil
    guard pendingSeek > 0 else { return }
    let target = pendingSeek
    pendingSeek = 0
    item.seek(to: CMTime(seconds: target, preferredTimescale: 1000)) { [weak self] _ in
      guard let self = self else { return }
      // Start playback only now, so audio begins at the resumed position not at 0.
      if self.wantsPlay {
        self.wantsPlay = false
        self.player.rate = self.rate
      }
      self.send("onProgress", ["position": self.player.currentTime().seconds, "duration": self.currentDuration()])
      self.updateNowPlayingInfo()
    }
  }

  /// AVPlayer can silently drop a `rate` set on a not-yet-ready item back to 1.0 once
  /// that item becomes ready — which made the chosen speed revert to 1x when a
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
        if self.player.rate != 0, self.player.rate != self.rate {
          self.player.rate = self.rate
        }
      }
    }
  }

  /// Watch the current item for a fatal `.failed` status and report it as a sustained
  /// `loading` to JS. A failed item parks the player at `.paused`, which would look
  /// like a user pause; reporting `loading` instead lets the shared JS stall watchdog
  /// promote it to `error` after the same grace as a mid-stream stall — uniform, and
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

  @objc private func handleItemFailedToEnd(_ n: Notification) {
    // A stream that was playing and then became unreachable mid-item fires this
    // rather than flipping `.status` to `.failed`. Report a sustained `loading` so the
    // shared JS stall watchdog surfaces `error` after its grace — every failure path
    // converges on the same consistent, non-instant feedback.
    guard !rebuilding else { return }
    DispatchQueue.main.async { self.send("onState", ["state": "loading"]) }
  }

  /// Fired when playback stalls mid-item (buffer underrun). Report `loading`; the
  /// shared JS stall watchdog promotes a stall that doesn't recover within its grace
  /// to `error`.
  @objc private func handlePlaybackStalled(_ n: Notification) {
    guard !rebuilding else { return }
    send("onState", ["state": "loading"])
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
    // — another app may have taken it since we last played.
    try? AVAudioSession.sharedInstance().setActive(true)
    if autoRewindMax > 0, let p = pausedAt, let item = player.currentItem {
      let elapsed = Date().timeIntervalSince(p)
      let rewind = min(autoRewindMax, elapsed)
      if rewind > 0.5 {
        let target = max(0, item.currentTime().seconds - rewind)
        item.seek(to: CMTime(seconds: target, preferredTimescale: 1000), completionHandler: nil)
      }
    }
    pausedAt = nil
    // A resume/skip seek hasn't landed yet — start the moment it does, so playback
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
  }

  func pause() {
    wantsPlay = false
    player.pause()
    pausedAt = Date()
    updateNowPlayingInfo()
  }

  func seek(to seconds: Double) {
    player.seek(to: CMTime(seconds: max(0, seconds), preferredTimescale: 1000)) { [weak self] _ in
      guard let self = self else { return }
      self.send("onProgress", ["position": self.player.currentTime().seconds, "duration": self.currentDuration()])
      self.updateNowPlayingInfo()
    }
  }

  func seek(by delta: Double) {
    seek(to: player.currentTime().seconds + delta)
  }

  func skip(to index: Int, position: Double) {
    guard index >= 0, index < tracks.count else { return }
    let wasPlaying = player.timeControlStatus != .paused || wantsPlay
    rebuildQueue(from: index, position: position)
    // Route through play() so a non-zero target waits for the deferred seek before
    // starting, instead of beginning at 0 on the freshly-rebuilt (not-ready) item.
    if wasPlaying { play() }
  }

  func skipToNext() {
    if currentIndex + 1 < tracks.count { skip(to: currentIndex + 1, position: 0) }
  }

  func skipToPrevious() {
    if currentIndex - 1 >= 0 { skip(to: currentIndex - 1, position: 0) } else { seek(to: 0) }
  }

  func setRate(_ r: Double) {
    rate = Float(r)
    if player.rate != 0 { player.rate = rate }
    updateNowPlayingInfo()
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
    player.pause()
    player.removeAllItems()
    queued.removeAll()
    tracks = []
    currentIndex = 0
    pausedAt = nil
    artworkURL = nil
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    send("onState", ["state": "idle"])
  }

  private func currentDuration() -> Double {
    if let d = player.currentItem?.duration.seconds, d.isFinite, d > 0 { return d }
    return tracks[safe: currentIndex]?.duration ?? 0
  }

  // MARK: Observers

  private func observePlayer() {
    statusObs = player.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
      guard let self = self, !self.rebuilding else { return }
      let state: String
      switch p.timeControlStatus {
      case .playing:
        state = "playing"
      case .waitingToPlayAtSpecifiedRate:
        // Wants to play but can't (buffering / underrun). With
        // automaticallyWaitsToMinimizeStalling on (the default), this is where a
        // stalled stream lands — report 'loading'; the shared JS stall watchdog
        // promotes a stall that doesn't recover within its grace to 'error'.
        state = "loading"
      case .paused:
        // A failed item also parks the player at .paused — keep reporting 'loading'
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
    itemObs = player.observe(\.currentItem, options: [.new]) { [weak self] p, _ in
      guard let self = self, !self.rebuilding else { return }
      if let cur = p.currentItem, let match = self.queued.first(where: { $0.item === cur }) {
        self.observeItemFailure() // re-attach to the now-current item
        if match.index != self.currentIndex {
          self.currentIndex = match.index
          self.updateNowPlayingInfo()
          self.send("onTrackChange", ["index": self.currentIndex])
        }
      } else if p.currentItem == nil && !self.tracks.isEmpty {
        self.send("onState", ["state": "ended"])
      }
    }
  }

  private func startProgressTimer() {
    let interval = CMTime(seconds: 1.0, preferredTimescale: 1)
    timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
      // Don't report progress while a (re)load is in flight: a fresh AVPlayerItem
      // reads currentTime() == 0 until it's ready AND the deferred resume seek has
      // applied. Emitting that 0 would clobber the saved position in JS — which made
      // a retry after a failed reload resume the book from the start.
      guard let self = self,
            self.pendingSeek == 0,
            let item = self.player.currentItem,
            item.status == .readyToPlay else { return }
      let pos = time.seconds.isFinite ? time.seconds : 0
      self.send("onProgress", ["position": pos, "duration": self.currentDuration()])
      self.updateNowPlayingElapsed(pos)
    }
  }

  private func observeNotifications() {
    let nc = NotificationCenter.default
    nc.addObserver(self, selector: #selector(handleInterruption(_:)),
                   name: AVAudioSession.interruptionNotification, object: nil)
    nc.addObserver(self, selector: #selector(handleRouteChange(_:)),
                   name: AVAudioSession.routeChangeNotification, object: nil)
    nc.addObserver(self, selector: #selector(handleItemFailedToEnd(_:)),
                   name: AVPlayerItem.failedToPlayToEndTimeNotification, object: nil)
    nc.addObserver(self, selector: #selector(handlePlaybackStalled(_:)),
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
      // the user had paused — e.g. playback starting when the phone is plugged in.
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

  // MARK: Remote commands / Now Playing

  private func setupRemoteCommands() {
    // Receive hardware remote-control events (Bluetooth/AVRCP earbud, wired headset).
    UIApplication.shared.beginReceivingRemoteControlEvents()
    let cc = MPRemoteCommandCenter.shared()
    // A single earbud/headset press is a *toggle*, but iOS/AVRCP delivers it as a
    // discrete Play OR Pause chosen from iOS's own notion of our play state — which
    // on iOS a third-party app can't correct (MPNowPlayingInfoCenter.playbackState is
    // entitlement-gated and silently ignored, so iOS infers the state itself and can
    // get stuck on "paused"). When it guesses wrong it sends Play while we're already
    // playing, so the press no-ops and the user has to press a second time. Routing
    // Play, Pause and Toggle all through one real-state toggle makes a single press
    // always flip playback, regardless of what iOS believes.
    cc.playCommand.addTarget { [weak self] _ in self?.togglePlayback(); return .success }
    cc.pauseCommand.addTarget { [weak self] _ in self?.togglePlayback(); return .success }
    cc.togglePlayPauseCommand.addTarget { [weak self] _ in self?.togglePlayback(); return .success }
    cc.skipForwardCommand.preferredIntervals = [NSNumber(value: jumpForward)]
    cc.skipForwardCommand.addTarget { [weak self] event in
      guard let self = self else { return .commandFailed }
      self.seek(by: (event as? MPSkipIntervalCommandEvent)?.interval ?? self.jumpForward)
      return .success
    }
    cc.skipBackwardCommand.preferredIntervals = [NSNumber(value: jumpBackward)]
    cc.skipBackwardCommand.addTarget { [weak self] event in
      guard let self = self else { return .commandFailed }
      self.seek(by: -((event as? MPSkipIntervalCommandEvent)?.interval ?? self.jumpBackward))
      return .success
    }
    cc.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let self = self, let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      self.seek(to: e.positionTime)
      return .success
    }
    cc.nextTrackCommand.addTarget { [weak self] _ in self?.skipToNext(); return .success }
    cc.previousTrackCommand.addTarget { [weak self] _ in self?.skipToPrevious(); return .success }
  }

  private func updateNowPlayingInfo() {
    guard currentIndex < tracks.count else { return }
    let t = tracks[currentIndex]
    var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
    info[MPMediaItemPropertyTitle] = t.title
    info[MPMediaItemPropertyArtist] = t.artist ?? ""
    info[MPMediaItemPropertyAlbumTitle] = t.album ?? t.title
    info[MPMediaItemPropertyPlaybackDuration] = currentDuration()
    info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = player.currentTime().seconds
    info[MPNowPlayingInfoPropertyPlaybackRate] = player.rate
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    loadArtwork(t.artwork, headers: t.headers)
  }

  private func updateNowPlayingElapsed(_ pos: Double) {
    var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
    info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = pos
    info[MPNowPlayingInfoPropertyPlaybackRate] = player.rate
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
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
    itemStatusObs?.invalidate()
    failureObs?.invalidate()
    startObs?.invalidate()
    NotificationCenter.default.removeObserver(self)
  }
}

// MARK: - Module

public class AudiosiloPlayerModule: Module {
  private var engine: AudioEngine?

  public func definition() -> ModuleDefinition {
    Name("AudiosiloPlayer")

    Events("onState", "onProgress", "onTrackChange")

    AsyncFunction("setup") { [weak self] in
      self?.onMain { self?.ensureEngine() }
    }

    AsyncFunction("setConfig") { [weak self] (config: ConfigRecord) in
      self?.onMain { self?.ensureEngine().setConfig(config) }
    }

    // The 4th arg (chapters) is Android-only (clipped media items for the lock screen);
    // iOS accepts it for bridge-arity parity and ignores it.
    AsyncFunction("load") {
      [weak self] (tracks: [TrackRecord], startIndex: Int, position: Double, _: [ChapterRecord]?) in
      self?.onMain { self?.ensureEngine().load(tracks: tracks, startIndex: startIndex, position: position) }
    }

    AsyncFunction("play") { [weak self] in self?.onMain { self?.engine?.play() } }
    AsyncFunction("pause") { [weak self] in self?.onMain { self?.engine?.pause() } }
    AsyncFunction("seekTo") { [weak self] (seconds: Double) in self?.onMain { self?.engine?.seek(to: seconds) } }
    AsyncFunction("skipToTrack") { [weak self] (index: Int, seconds: Double) in
      self?.onMain { self?.engine?.skip(to: index, position: seconds) }
    }
    AsyncFunction("setRate") { [weak self] (rate: Double) in self?.onMain { self?.engine?.setRate(rate) } }
    AsyncFunction("reset") { [weak self] in self?.onMain { self?.engine?.reset() } }

    OnDestroy { [weak self] in
      self?.onMain {
        self?.engine?.reset()
        self?.engine = nil
      }
    }
  }

  /// AVFoundation / MPRemoteCommandCenter must be touched on the main thread.
  private func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
  }

  @discardableResult
  private func ensureEngine() -> AudioEngine {
    if let engine = engine { return engine }
    let engine = AudioEngine(send: { [weak self] name, body in
      DispatchQueue.main.async { self?.sendEvent(name, body) }
    })
    self.engine = engine
    return engine
  }
}
