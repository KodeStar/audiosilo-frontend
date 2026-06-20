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
  private var artworkURL: String?
  /// Suppresses transient state/track events while the queue is being rebuilt
  /// (removeAllItems briefly sets currentItem to nil).
  private var rebuilding = false
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
    player.pause()
    player.removeAllItems()
    queued.removeAll()
    guard startIndex < tracks.count else { rebuilding = false; return }
    for i in startIndex..<tracks.count {
      guard let item = makeItem(tracks[i]) else { continue }
      queued.append((index: i, item: item))
      player.insert(item, after: nil)
    }
    currentIndex = startIndex
    if position > 0, let first = player.currentItem {
      first.seek(to: CMTime(seconds: position, preferredTimescale: 1000), completionHandler: nil)
    }
    reassertRateWhenReady()
    rebuilding = false
    updateNowPlayingInfo()
    send("onTrackChange", ["index": currentIndex])
    send("onProgress", ["position": position, "duration": currentDuration()])
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

  // MARK: Transport

  func play() {
    if autoRewindMax > 0, let p = pausedAt, let item = player.currentItem {
      let elapsed = Date().timeIntervalSince(p)
      let rewind = min(autoRewindMax, elapsed)
      if rewind > 0.5 {
        let target = max(0, item.currentTime().seconds - rewind)
        item.seek(to: CMTime(seconds: target, preferredTimescale: 1000), completionHandler: nil)
      }
    }
    pausedAt = nil
    player.rate = rate
    updateNowPlayingInfo()
  }

  func pause() {
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
    let wasPlaying = player.rate != 0
    rebuildQueue(from: index, position: position)
    if wasPlaying { player.rate = rate }
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
      case .playing: state = "playing"
      case .waitingToPlayAtSpecifiedRate: state = "loading"
      case .paused: state = (p.currentItem == nil && !self.tracks.isEmpty) ? "ended" : "paused"
      @unknown default: state = "paused"
      }
      self.send("onState", ["state": state])
    }
    itemObs = player.observe(\.currentItem, options: [.new]) { [weak self] p, _ in
      guard let self = self, !self.rebuilding else { return }
      if let cur = p.currentItem, let match = self.queued.first(where: { $0.item === cur }) {
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
      guard let self = self, self.player.currentItem != nil else { return }
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
  }

  @objc private func handleInterruption(_ n: Notification) {
    guard let info = n.userInfo,
          let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    switch type {
    case .began:
      pause()
    case .ended:
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
    let cc = MPRemoteCommandCenter.shared()
    cc.playCommand.addTarget { [weak self] _ in self?.play(); return .success }
    cc.pauseCommand.addTarget { [weak self] _ in self?.pause(); return .success }
    cc.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let self = self else { return .commandFailed }
      if self.player.rate != 0 { self.pause() } else { self.play() }
      return .success
    }
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

    AsyncFunction("load") { [weak self] (tracks: [TrackRecord], startIndex: Int, position: Double) in
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
