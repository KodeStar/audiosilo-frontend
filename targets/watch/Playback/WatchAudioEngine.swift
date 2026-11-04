// The watch's player: one AVQueuePlayer over a downloaded book's watch rendition files, built
// from a file index (the phone engine's model, `modules/audiosilo-player/ios/AudioEngine.swift`),
// with a seek deferred until the first item is ready and the player started only once it landed,
// so the audio begins at the place, not at the file's start. The session is `.playback` /
// `.spokenAudio` / `.longFormAudio`, so watchOS routes it to Bluetooth (the route picker shows
// when needed, W0); the built-in speaker plays only after a one-time confirmation (decision 11).
// Now Playing shows the chapter (title, times within it); the remote commands are play, pause,
// skip 15 / 30, previous / next chapter and the chapter scrubber.
//
// Every position is whole-book seconds (Timeline). The engine tells the SpanRecorder what
// happens: a span opens on play; closes on pause, a move, a stop, the end (then `finish`) and the
// sleep timer; is cut every 15 s while the server is reachable (else after an hour), on a rate
// change and on going to the background; and is kept every 5 s. The rules are Core's
// (SpanRecorder, PlayerRules, SleepTimer); this file carries them out.
import AVFoundation
import Foundation
import MediaPlayer

/// A downloaded book ready to play.
struct LoadedBook: Equatable {
  var ref: BookRef
  var title: String
  var author: String?
  var timeline: Timeline
  /// The local file per timeline file, in order.
  var urls: [URL]

  var playing: PlayingBook { PlayingBook(ref: ref, audioDuration: timeline.audio) }
}

@MainActor
final class WatchAudioEngine: NSObject, ObservableObject {
  static let TICK: TimeInterval = 0.5
  /// A play after this long paused is a book picked up again: another device may have moved its
  /// place on (the phone's `LONG_PAUSE_MS`).
  static let PICKED_UP_AFTER: TimeInterval = 60
  /// An interruption's `began` can arrive just after the system paused the player for it.
  private static let INTERRUPTION_SLACK: TimeInterval = 2
  /// The speed a book with none of its own plays at: the one last chosen here (the watch has no
  /// default speed setting). A book keeps its own (`load`), as on the phone.
  private static let speedKey = "watch.playbackSpeed"
  private static let speakerKey = "watch.speakerConfirmed"

  @Published private(set) var book: LoadedBook?
  @Published private(set) var playing = false
  /// Starting: the session is being activated (the route picker may be up).
  @Published private(set) var starting = false
  @Published private(set) var position: Double = 0
  @Published private(set) var rate: Double
  @Published private(set) var sleep: SleepTimer?
  @Published private(set) var times: NowPlayingTimes?
  /// The route is the watch's own speaker and the listener has not said yes to it yet.
  @Published var speakerPrompt = false
  @Published private(set) var problem: String?

  /// Whether the server answered the last sync (the 15 s cut runs only then).
  var reachable: () -> Bool = { true }
  /// Told when the loaded book plays again after `PICKED_UP_AFTER` of pause.
  var onPickedUp: (() -> Void)?

  private let spans: SpanRecorder
  private let places: PlaceStore
  private let player = AVQueuePlayer()
  /// The queue's items, in order; `items[0]` is file `firstIndex`.
  private var items: [AVPlayerItem] = []
  private var firstIndex = 0
  private var pendingSeek: Double?
  /// The deferred seek was asked for (an item's status can be delivered twice).
  private var seekAsked = false
  /// A rebuilt queue's first item has not landed yet (ready, and at its place). Until then the
  /// player's status says nothing: asked to play a new item, it drops to rate 0 by itself for a
  /// few ms and comes back (`controlChanged`).
  private var settling = false
  /// One per item in the queue: a file further on can fail too.
  private var statusObservations: [NSKeyValueObservation] = []
  private var controlObservation: NSKeyValueObservation?
  private var timeObserver: Any?
  /// The item and interruption observers (blocks on the main queue).
  private var observers: [NSObjectProtocol] = []
  private var lastTick = Date()
  private var lastKeep = Date()
  private var lastCut = Date()
  /// It was playing when an interruption began: it plays on if that ends with `shouldResume`.
  private var resumeAfterInterruption = false
  /// When the system last paused the player (a pause the listener made clears it).
  private var systemPausedAt: Date?
  /// When it last paused, for `onPickedUp`.
  private var pausedAt: Date?
  /// Which `play` a session activation is for: a pause or a stop meanwhile ends that one.
  private var startToken = 0
  /// When the place last moved while playing (where a late-noticed stop ends its span).
  private var lastAdvance = Date()
  /// The book played to its end: the next play starts it again. Only then: a queue emptied by a
  /// file that failed plays on from the place.
  private var ended = false

  init(spans: SpanRecorder, places: PlaceStore) {
    self.spans = spans
    self.places = places
    rate = PlaybackSpeed.book(saved: nil, defaultRate: UserDefaults.standard.double(forKey: Self.speedKey))
    super.init()
    player.actionAtItemEnd = .advance
    player.automaticallyWaitsToMinimizeStalling = false
    timeObserver = player.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: Self.TICK, preferredTimescale: 600), queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.tick() }
    }
    // On the main queue: AVPlayerItem may post its notifications on another thread, where
    // `MainActor.assumeIsolated` would trap.
    let nc = NotificationCenter.default
    observers = [
      nc.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] n in
        MainActor.assumeIsolated { self?.itemEnded(n) }
      },
      nc.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: nil, queue: .main) { [weak self] n in
        MainActor.assumeIsolated { self?.itemFailed(n) }
      },
      nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
        MainActor.assumeIsolated { self?.interrupted(n) }
      },
    ]
    // The system can pause the player itself (the app suspended, headphones gone): a pause
    // like any other, so the span closes where the audio stopped.
    controlObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.controlChanged() } }
    }
    setUpRemoteCommands()
  }

  /// Read here, not as observed: a rebuild pauses the player and starts it again in one go, and
  /// only a player still paused now was stopped. Not while a rebuilt queue settles: a deferred
  /// seek holds it paused on purpose, and it dips to rate 0 by itself while the item loads.
  private func controlChanged() {
    guard playing, !settling, player.currentItem != nil, player.timeControlStatus == .paused, player.rate == 0
    else { return }
    systemPausedAt = Date()
    pause(stoppedAt: lastAdvance)
  }

  var loadedBook: BookRef? { book?.ref }

  // MARK: - The place

  /// The file playing and the seconds into it.
  private func where_() -> (index: Int, positionInTrack: Double)? {
    guard let item = player.currentItem, let i = items.firstIndex(of: item) else { return nil }
    if let pending = pendingSeek, i == 0 { return (firstIndex, pending) }
    let t = item.currentTime().seconds
    // Not a number is not the file's start: the last known place stands.
    return t.isFinite ? (firstIndex + i, t) : nil
  }

  /// The place now as a span end (nil when the engine reports nothing that is a number).
  private func spanEnd() -> SpanEnd? {
    guard let b = book else { return nil }
    let w = where_() ?? b.timeline.locate(position)
    return b.timeline.spanEnd(index: w.index, positionInTrack: w.positionInTrack)
  }

  /// Kept only as the book plays or moves, with the time that happened (`at`, else now): a place
  /// stamped later than it was heard would read as newer than another device's real one.
  private func savePlace(at: Date? = nil) {
    guard let b = book, let end = spanEnd() else { return }
    places.set(b.ref, LocalPlace(end, at: at ?? Date(), speed: rate))
  }

  // MARK: - Loading

  /// Load `book` at `plan`'s place and at its own speed, `savedSpeed` (a book already playing is
  /// stopped first, its span closed).
  func load(_ next: LoadedBook, plan: ResumePlan, savedSpeed: Double?) {
    if book != nil { stop() }
    book = next
    problem = nil
    rate = PlaybackSpeed.book(saved: savedSpeed, defaultRate: UserDefaults.standard.double(forKey: Self.speedKey))
    player.defaultRate = Float(rate)
    spans.prepareStart(plan.start, unfinish: plan.unfinish)
    let place = next.timeline.resumePlace(position: plan.position, file: plan.file, filePos: plan.filePos)
    position = next.timeline.bookPosition(index: place.index, positionInTrack: place.positionInTrack)
    rebuild(from: place.index, at: place.positionInTrack)
    refreshTimes(force: true)
  }

  /// Replace the queue with the files from `index` on, `seconds` into the first.
  private func rebuild(from index: Int, at seconds: Double) {
    guard let b = book, b.urls.indices.contains(index) else { return }
    statusObservations = []
    ended = false
    seekAsked = false
    settling = true
    player.pause()
    player.removeAllItems()
    items = b.urls[index...].map { url in
      let item = AVPlayerItem(url: url)
      item.audioTimePitchAlgorithm = .timeDomain
      return item
    }
    firstIndex = index
    for item in items { player.insert(item, after: nil) }
    pendingSeek = seconds > 0 ? seconds : nil
    statusObservations = items.map { item in
      item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
        DispatchQueue.main.async { MainActor.assumeIsolated { self?.itemStatus(item) } }
      }
    }
  }

  private func itemStatus(_ item: AVPlayerItem) {
    guard let i = items.firstIndex(of: item) else { return }
    switch item.status {
    case .readyToPlay:
      guard i == 0 else { return }
      if let s = pendingSeek {
        guard !seekAsked else { return }
        seekAsked = true
        item.seek(to: CMTime(seconds: s, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) {
          [weak self, weak item] _ in
          DispatchQueue.main.async {
            MainActor.assumeIsolated {
              // This queue's seek only: a rebuild meanwhile has its own `pendingSeek`.
              guard let self, let item, item === self.items.first else { return }
              self.pendingSeek = nil
              self.settling = false
              // Only now, so the audio begins at the place, not at the file's start.
              if self.playing { self.startPlayer() }
            }
          }
        }
      } else {
        settling = false
        // A rate set before the item was ready can be dropped (the phone's reassertRateWhenReady).
        if playing { startPlayer() }
      }
    case .failed:
      // AVQueuePlayer skips a failed file by itself, which would carry the listener past it. One
      // further on waits its turn (the file playing may have hours left: `itemEnded`).
      let current = player.currentItem.flatMap { items.firstIndex(of: $0) } ?? items.count
      if i <= current { fail() }
    default: break
    }
  }

  // MARK: - Transport

  /// Play: the session first (the route picker may show), the speaker asked about once.
  func play() {
    guard let b = book, !playing, !starting else { return }
    problem = nil
    if ended {
      // Played to the end: start again (an `unfinish`, then a `restart` span).
      spans.prepareStart(.restart, unfinish: true)
      position = 0
      rebuild(from: 0, at: 0)
    } else if player.items().isEmpty {
      // The queue emptied short of the end (a file failed): try again from the place, a plain
      // resume (never a restart, which the server would apply as a move to 0).
      let place = b.timeline.locate(position)
      rebuild(from: place.index, at: place.positionInTrack)
    }
    startToken += 1
    let token = startToken
    starting = true
    Task {
      let refused = await activateSession()
      // Paused or stopped while the session was asked for: this play is over.
      guard token == startToken else { return }
      starting = false
      problem = refused ?? problem
      guard refused == nil, book != nil else { return }
      if onBuiltInSpeaker() && !UserDefaults.standard.bool(forKey: Self.speakerKey) {
        speakerPrompt = true
        return
      }
      startPlaying()
    }
  }

  /// The listener said yes to the watch's speaker (once, kept).
  func confirmSpeaker() {
    UserDefaults.standard.set(true, forKey: Self.speakerKey)
    speakerPrompt = false
    startPlaying()
  }

  func declineSpeaker() {
    speakerPrompt = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func startPlaying() {
    // No queue: a file failed while the session was asked for, and `problem` says so.
    guard let b = book, !playing, !items.isEmpty else { return }
    if let s = sleep {
      sleep = s.resumed(at: Date())
    }
    let now = Date()
    let pickedUp = pausedAt.map { now.timeIntervalSince($0) >= Self.PICKED_UP_AFTER } ?? false
    pausedAt = nil
    playing = true
    // With a deferred seek out, the player starts when it lands.
    if pendingSeek == nil { startPlayer() }
    lastTick = now
    lastKeep = now
    lastCut = now
    lastAdvance = now
    if let at = spanEnd() { spans.open(b.playing, at: at, speed: rate) }
    refreshTimes(force: true)
    if pickedUp { onPickedUp?() }
  }

  private func startPlayer() {
    player.defaultRate = Float(rate)
    player.play()
    player.rate = Float(rate)
  }

  /// A `play` still asking for the session goes no further.
  private func cancelStart() {
    startToken += 1
    starting = false
  }

  /// The listener's pause (also what stops a play still starting).
  func pause() {
    cancelStart()
    resumeAfterInterruption = false
    systemPausedAt = nil
    pause(stoppedAt: nil)
  }

  private func pause(stoppedAt: Date?) {
    guard playing else { return }
    player.pause()
    playing = false
    pausedAt = stoppedAt ?? Date()
    spans.close(at: spanEnd(), stoppedAt: stoppedAt)
    savePlace(at: stoppedAt)
    sleep?.paused(at: Date())
    refreshTimes(force: true)
  }

  func toggle() { playing || starting ? pause() : play() }

  /// Stop and unload (removing the playing book, signing out, another book loading). A book not
  /// playing keeps the place it has: a place it was never heard at (a restart declined) or a
  /// newer time on an old one would read as more than it is.
  func stop() {
    pause()
    pausedAt = nil
    speakerPrompt = false
    spans.close(at: nil)
    statusObservations = []
    player.removeAllItems()
    items = []
    pendingSeek = nil
    settling = false
    ended = false
    book = nil
    times = nil
    sleep = nil
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  /// Move to `target` (whole-book seconds). `reason` nil: a jump, or moved back when behind.
  func seek(to target: Double, reason: ListeningStart? = nil) {
    guard let b = book else { return }
    let to = Skips.target(position: target, by: 0, total: b.timeline.total)
    let place = b.timeline.locate(to)
    let target = b.timeline.spanEnd(index: place.index, positionInTrack: place.positionInTrack)
    // Previous at the book's start: nothing moves, so no span and no newer time on the place.
    if reason == nil, Spans.movesNowhere(from: spanEnd(), to: target) { return }
    // Moved back into a book that played to its end: it is finished on the server and a listen
    // never unfinishes, so the next play sends the `unfinish` (its reason stays the move's).
    if ended { spans.prepareStart(spans.nextStart, unfinish: true) }
    spans.move(b.playing, to: target, from: spanEnd(), reason: reason, playing: playing, speed: rate)
    ended = false
    if let w = where_(), w.index == place.index, pendingSeek == nil, player.currentItem?.status == .readyToPlay {
      player.seek(to: CMTime(seconds: place.positionInTrack, preferredTimescale: 1000), toleranceBefore: .zero,
                  toleranceAfter: .zero)
    } else {
      rebuild(from: place.index, at: place.positionInTrack)
      // With a deferred seek out, the player starts when it lands.
      if playing && pendingSeek == nil { startPlayer() }
    }
    position = to
    // A chapter timer's stop crossed while paused has nothing left to stop: the next play must
    // not end at once on it (the phone's `fire`).
    if !playing, let s = sleep, s.due(position: to) { sleep = nil }
    if let target { places.set(b.ref, LocalPlace(target, at: Date(), speed: rate)) }
    lastKeep = Date()
    lastCut = Date()
    refreshTimes(force: true)
  }

  func skip(_ delta: Double) {
    seek(to: Skips.target(position: position, by: delta, total: book?.timeline.total ?? 0))
  }

  func previousChapter() {
    guard let b = book, let to = ChapterNav.previous(b.timeline.chapters, position) else { return skip(-Skips.BACK) }
    seek(to: to)
  }

  func nextChapter() {
    guard let b = book, let to = ChapterNav.next(b.timeline.chapters, position) else { return }
    seek(to: to)
  }

  func setRate(_ r: Double) {
    let next = PlaybackSpeed.clamp(r)
    guard next != rate else { return }
    if let b = book { spans.cut(b.playing, at: spanEnd(), playing: playing, speed: next) }
    rate = next
    UserDefaults.standard.set(next, forKey: Self.speedKey)
    player.defaultRate = Float(next)
    if playing && pendingSeek == nil { player.rate = Float(next) }
    // The book's own from now on. Its place's time stays: the place did not move.
    if let b = book, var kept = places.place(b.ref) {
      kept.speed = next
      places.set(b.ref, kept)
    }
    refreshTimes(force: true)
  }

  func setSleep(_ mode: SleepMode?) {
    guard let mode, let b = book else {
      sleep = nil
      return
    }
    sleep = SleepTimer.arm(mode, position: position, rate: rate, chapters: b.timeline.chapters, total: b.timeline.total)
    if !playing { sleep?.paused(at: Date()) }
  }

  /// Going to the background while playing: the span is cut (Sync v2's trigger), and the place
  /// kept. Paused, the place was kept when it stopped.
  func cutForBackground() {
    guard playing, let b = book else { return }
    spans.cut(b.playing, at: spanEnd(), playing: true, speed: rate)
    savePlace()
  }

  /// An offer answered with Stay: the next span is a deliberate move.
  func stay() {
    guard let b = book else { return }
    spans.standBy(b.playing, at: spanEnd(), playing: playing, speed: rate)
  }

  // MARK: - Ticks

  private func tick() {
    guard let b = book else { return }
    let now = Date()
    let wall = now.timeIntervalSince(lastTick)
    lastTick = now
    if let w = where_() {
      let p = b.timeline.bookPosition(index: w.index, positionInTrack: w.positionInTrack)
      if p.isFinite {
        if playing && p != position { lastAdvance = now }
        position = p
      }
    }
    refreshTimes(force: false)
    guard playing else { return }
    if var s = sleep {
      s.played(wall)
      sleep = s
      if s.due(position: position) {
        sleep = nil
        pause()
        return
      }
    }
    var moved = false
    if now.timeIntervalSince(lastKeep) >= Spans.OPEN_SPAN_KEEP {
      lastKeep = now
      spans.keep(at: spanEnd())
      moved = true
    }
    if now.timeIntervalSince(lastCut) >= Spans.CUT_INTERVAL {
      lastCut = now
      spans.tick(b.playing, at: spanEnd(), playing: true, reachable: reachable(), speed: rate)
      moved = true
    }
    if moved { savePlace() }
  }

  private func itemEnded(_ note: Notification) {
    guard let item = note.object as? AVPlayerItem, let i = items.firstIndex(of: item), let b = book else { return }
    guard firstIndex + i == b.timeline.files.count - 1 else {
      // The next file failed before its turn: the player would skip it (`itemStatus`).
      if items.indices.contains(i + 1), items[i + 1].status == .failed { fail() }
      return
    }
    // The book's end: its last span closed, then one `finish`.
    let last = b.timeline.files.count - 1
    let lastDuration = b.timeline.files[last].duration
    let end = b.timeline.spanEnd(index: last, positionInTrack: lastDuration > 0 ? lastDuration : item.currentTime().seconds)
    resumeAfterInterruption = false
    playing = false
    ended = true
    spans.finish(b.playing, at: end)
    position = b.timeline.total
    places.set(b.ref, LocalPlace(position: b.timeline.total, file: nil, filePos: nil, at: Date(), speed: rate))
    sleep = nil
    refreshTimes(force: true)
  }

  private func itemFailed(_ note: Notification) {
    guard let item = note.object as? AVPlayerItem, items.contains(item) else { return }
    fail()
  }

  /// The queue goes first: the place then comes from the last tick, not from wherever the player
  /// skipped to, and a play tries the file again from there (`play`).
  private func fail() {
    cancelStart()
    statusObservations = []
    player.removeAllItems()
    items = []
    pendingSeek = nil
    settling = false
    pause(stoppedAt: nil)
    problem = "This book can't be played. Remove it from the watch and download it again."
  }

  private func interrupted(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw)
    else { return }
    let resume = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt)
      .map { AVAudioSession.InterruptionOptions(rawValue: $0).contains(.shouldResume) } ?? false
    switch type {
    case .began:
      // Either order: the system may have paused the player just before this arrives.
      let justPaused = systemPausedAt.map { Date().timeIntervalSince($0) < Self.INTERRUPTION_SLACK } ?? false
      resumeAfterInterruption = playing || justPaused
      pause(stoppedAt: nil)
    case .ended:
      let again = resumeAfterInterruption && resume
      resumeAfterInterruption = false
      if again { play() }
    @unknown default: break
    }
  }

  // MARK: - The session

  /// Nil once the session is active; else why not, in plain words.
  private func activateSession() async -> String? {
    let s = AVAudioSession.sharedInstance()
    do {
      try s.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio, options: [])
    } catch {
      return "The watch could not start its audio."
    }
    let ok: Bool = await withCheckedContinuation { c in
      let once = Once()
      s.activate(options: []) { ok, _ in once.run { c.resume(returning: ok) } }
      // The route picker can wait for an answer: give up after a minute.
      DispatchQueue.main.asyncAfter(deadline: .now() + 60) { once.run { c.resume(returning: false) } }
    }
    return ok ? nil : "Choose where to listen (headphones or the watch speaker), then play again."
  }

  private func onBuiltInSpeaker() -> Bool {
    AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType == .builtInSpeaker }
  }

  // MARK: - Now Playing

  private func refreshTimes(force: Bool) {
    guard let b = book else { return }
    let t = NowPlayingTimes.of(chapters: b.timeline.chapters, position: position, total: b.timeline.total,
                               bookTitle: b.title)
    let chapterChanged = t.chapterIndex != times?.chapterIndex
    if t != times { times = t }
    guard force || chapterChanged else { return }
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: t.title,
      MPMediaItemPropertyAlbumTitle: b.title,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: t.elapsed,
      MPMediaItemPropertyPlaybackDuration: t.duration,
      MPNowPlayingInfoPropertyPlaybackRate: playing ? rate : 0,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: rate,
    ]
    if let a = b.author, !a.isEmpty { info[MPMediaItemPropertyArtist] = a }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  private func setUpRemoteCommands() {
    let c = MPRemoteCommandCenter.shared()
    c.playCommand.addTarget { [weak self] _ in self?.command { $0.play() } ?? .commandFailed }
    c.pauseCommand.addTarget { [weak self] _ in self?.command { $0.pause() } ?? .commandFailed }
    c.togglePlayPauseCommand.addTarget { [weak self] _ in self?.command { $0.toggle() } ?? .commandFailed }
    c.skipBackwardCommand.preferredIntervals = [NSNumber(value: Skips.BACK)]
    c.skipBackwardCommand.addTarget { [weak self] _ in self?.command { $0.skip(-Skips.BACK) } ?? .commandFailed }
    c.skipForwardCommand.preferredIntervals = [NSNumber(value: Skips.FORWARD)]
    c.skipForwardCommand.addTarget { [weak self] _ in self?.command { $0.skip(Skips.FORWARD) } ?? .commandFailed }
    c.previousTrackCommand.addTarget { [weak self] _ in self?.command { $0.previousChapter() } ?? .commandFailed }
    c.nextTrackCommand.addTarget { [weak self] _ in self?.command { $0.nextChapter() } ?? .commandFailed }
    c.changePlaybackPositionCommand.addTarget { [weak self] e in
      guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      return self?.command { engine in
        // The scrubber is the chapter's: its start plus the time asked for.
        let start = engine.book.flatMap { b in engine.times?.chapterIndex.map { b.timeline.chapters[$0].bookOffset } } ?? 0
        engine.seek(to: start + e.positionTime)
      } ?? .commandFailed
    }
  }

  private nonisolated func command(_ run: @escaping @MainActor (WatchAudioEngine) -> Void) -> MPRemoteCommandHandlerStatus {
    MainActor.assumeIsolated {
      guard book != nil else { return .noActionableNowPlayingItem }
      run(self)
      return .success
    }
  }
}

/// Runs its closure once (a continuation resumed by whichever comes first).
private final class Once: @unchecked Sendable {
  private let lock = NSLock()
  private var done = false

  func run(_ f: () -> Void) {
    lock.lock()
    let first = !done
    done = true
    lock.unlock()
    if first { f() }
  }
}
