import AVFoundation
import Foundation

// Smart Speed on iOS (decision 6): DOWNLOADED books only (every track a file:// URL). The
// look-ahead decodes the local file with AVAssetReader on a background queue (~60 s ahead of
// the playhead), the pure `SilenceDetector` finds the silences with Android's rules, and
// boundary time observers raise the player's rate to base x 3 (capped) only inside the middle
// of each known silence, back to base before the next word. A streaming book, or the switch
// off, leaves every rate path exactly as it was: `boostedRate` stays nil.
//
// Every boost is undone by whatever moves or stops the playhead: the engine calls
// `cancelBoost` before a pause, a seek, a queue rebuild and a file advance, and `playheadMoved`
// once the move landed (boundary observers never fire for a seek, so the plan is re-evaluated
// there). A restore timer runs beside the boundary observer while boosted, so a missed
// boundary can never leave the book running fast into a word.

/// What Smart Speed needs from the engine. Main thread only.
protocol SmartSpeedHost: AnyObject {
  var smartSpeedPlayer: AVQueuePlayer { get }
  /// The listener's speed (Now Playing shows this one, never the boost).
  var smartSpeedBaseRate: Float { get }
  /// The current item, its file index and its time, or nil while the playhead is not settled
  /// (a queue rebuild, a deferred start seek or any seek still in flight).
  func smartSpeedPlayhead() -> (fileIndex: Int, time: Double, item: AVPlayerItem)?
}

final class SmartSpeed {
  /// How far ahead of the playhead the silence map reaches before reading stops.
  static let lookAhead: Double = 60
  /// One AVAssetReader pass.
  static let chunk: Double = 30
  /// Boundary observers registered at once (two per span); the rest follow as the plan moves.
  static let maxObservedSpans = 200

  private struct FileAnalysis {
    /// Distinguishes this analysis from a newer one for the same file (a seek outside the
    /// analysed range starts over), so a late chunk can't land in the wrong map.
    var token: Int
    var detector: SilenceDetector?
    var from: Double
    var until: Double
    var spans: [BoostSpan] = []
    var eof = false
    var inFlight = false
    var failed = false
  }

  private weak var host: SmartSpeedHost?
  private var enabled = false
  /// The local files of the loaded book; empty for a streaming (or partly streaming) book.
  private var fileURLs: [URL] = []
  private var files: [Int: FileAnalysis] = [:]
  private var nextToken = 0
  private let queue = DispatchQueue(label: "app.audiosilo.player.smartspeed", qos: .utility)
  private var boundaryObserver: Any?
  /// The file the boundary observer was registered for (nil = none registered).
  private var observedFile: Int?
  private var restoreWork: DispatchWorkItem?
  private var meter = SavedTimeMeter()
  /// The rate while boosting, else nil. The engine plays `boostedRate ?? base`.
  private(set) var boostedRate: Float?

  init(host: SmartSpeedHost) {
    self.host = host
  }

  var isActive: Bool { enabled && !fileURLs.isEmpty }

  /// Book seconds saved since the engine was created (monotonic).
  var silenceSaved: Double { meter.total }

  // MARK: Engine hooks (main thread)

  func setEnabled(_ on: Bool) {
    guard on != enabled else { return }
    enabled = on
    if on {
      playheadMoved()
    } else {
      cancelBoost(restoreRate: true)
      clearPlan()
    }
  }

  /// A new book (or the same one reloaded): only local files qualify.
  func load(trackURLs: [URL?]) {
    cancelBoost(restoreRate: false)
    clearPlan()
    let urls = trackURLs.compactMap { $0 }
    fileURLs = (!urls.isEmpty && urls.count == trackURLs.count && urls.allSatisfy { $0.isFileURL }) ? urls : []
  }

  func reset() {
    cancelBoost(restoreRate: false)
    clearPlan()
    fileURLs = []
  }

  /// Stop boosting now: before a pause, a seek, a rebuild or a file advance, and when the
  /// switch turns off. Counts the time saved up to here. `restoreRate` puts the player back
  /// on the base rate when it is still playing (a pause or rebuild stops it anyway).
  func cancelBoost(restoreRate: Bool) {
    restoreWork?.cancel()
    restoreWork = nil
    guard boostedRate != nil else { return }
    boostedRate = nil
    if let host = host {
      let player = host.smartSpeedPlayer
      meter.end(bookTime: player.currentTime().seconds, wallTime: ProcessInfo.processInfo.systemUptime)
      if restoreRate, player.rate != 0 { player.rate = host.smartSpeedBaseRate }
    } else {
      meter.discard()
    }
  }

  /// The playhead landed somewhere new (a seek completed, a rebuild's start seek landed, the
  /// next file began): re-plan around it.
  func playheadMoved() {
    guard isActive else { removeBoundaryObserver(); return }
    ensureLookAhead()
    registerBoundaries()
    evaluate()
  }

  /// The engine's 1 s tick: keep the look-ahead ahead and re-check the boost (a backstop for
  /// the boundary observer and the restore timer).
  func tick() {
    guard isActive else { return }
    ensureLookAhead()
    // A file that became current while unsettled (its item not ready yet when the engine
    // reported the move) never had its boundaries registered: do it now.
    if let head = host?.smartSpeedPlayhead(), observedFile != head.fileIndex { registerBoundaries() }
    evaluate()
  }

  /// The base rate changed (setRate / the lock screen's rate command) or play started: boost
  /// from the new base if the playhead is inside a silence.
  func evaluate() {
    guard isActive, let host = host, let head = host.smartSpeedPlayhead() else {
      cancelBoost(restoreRate: true)
      return
    }
    let player = host.smartSpeedPlayer
    guard player.rate != 0 else {
      // Paused (by us, the OS or the end of the queue): nothing to boost, nothing to restore.
      cancelBoost(restoreRate: false)
      return
    }
    let spans = files[head.fileIndex]?.spans ?? []
    guard let i = SmartSpeedPlanner.spanIndex(containing: head.time, in: spans) else {
      cancelBoost(restoreRate: true)
      return
    }
    let base = host.smartSpeedBaseRate
    if boostedRate == nil {
      guard let boosted = SmartSpeedPlanner.boostedRate(base: base, canPlayFastForward: head.item.canPlayFastForward) else { return }
      boostedRate = boosted
      meter.begin(bookTime: head.time, wallTime: ProcessInfo.processInfo.systemUptime, baseRate: base, boostedRate: boosted)
      player.rate = boosted
    }
    scheduleRestore(spanEnd: spans[i].end, from: head.time)
  }

  // MARK: Plan

  private func clearPlan() {
    removeBoundaryObserver()
    files.removeAll()
  }

  /// Restore the base rate at the span's end by wall clock too: whichever of this and the
  /// boundary observer fires first re-evaluates (the other then finds nothing to do).
  private func scheduleRestore(spanEnd: Double, from time: Double) {
    restoreWork?.cancel()
    guard let rate = boostedRate, rate > 0 else { return }
    let wall = max(0.02, (spanEnd - time) / Double(rate))
    let work = DispatchWorkItem { [weak self] in
      self?.restoreWork = nil
      self?.evaluate()
    }
    restoreWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + wall, execute: work)
  }

  private func removeBoundaryObserver() {
    if let obs = boundaryObserver, let host = host { host.smartSpeedPlayer.removeTimeObserver(obs) }
    boundaryObserver = nil
    observedFile = nil
  }

  /// Boundary observers for the current file's upcoming spans (start and end of each). They
  /// are in the CURRENT item's timeline, so the engine re-registers through `playheadMoved`
  /// whenever the item changes; each callback re-reads the clock rather than trusting which
  /// boundary fired (AVPlayer doesn't say).
  private func registerBoundaries() {
    removeBoundaryObserver()
    guard let host = host, let head = host.smartSpeedPlayhead() else { return }
    observedFile = head.fileIndex
    guard let spans = files[head.fileIndex]?.spans else { return }
    var times: [NSValue] = []
    var count = 0
    for s in spans where s.end > head.time {
      times.append(NSValue(time: CMTime(seconds: s.start, preferredTimescale: 1000)))
      times.append(NSValue(time: CMTime(seconds: s.end, preferredTimescale: 1000)))
      count += 1
      if count >= Self.maxObservedSpans { break }
    }
    guard !times.isEmpty else { return }
    boundaryObserver = host.smartSpeedPlayer.addBoundaryTimeObserver(forTimes: times, queue: .main) { [weak self] in
      self?.evaluate()
    }
  }

  /// Keep the current file's silence map `lookAhead` seconds ahead of the playhead, and start
  /// on the next file once this one is fully mapped and its end is near.
  private func ensureLookAhead() {
    guard let host = host, let head = host.smartSpeedPlayhead() else { return }
    let f = head.fileIndex
    let t = head.time
    // Inside the mapped range, or ahead of it by less than the look-ahead (the reader catches
    // up sequentially; restarting there would throw away a chunk still in flight).
    if let a = files[f], t >= a.from - 0.5, t <= a.until + Self.lookAhead {
      advance(file: f, playhead: t)
      if a.eof, f + 1 < fileURLs.count, files[f + 1] == nil {
        let duration = head.item.duration.seconds
        if duration.isFinite, duration - t < Self.lookAhead { startAnalysis(file: f + 1, at: 0) }
      }
      return
    }
    // Nothing mapped here yet (a new file, or a seek outside the mapped range): start over at
    // the playhead, and forget maps that are no longer near it.
    files = files.filter { abs($0.key - f) <= 1 && $0.key != f }
    startAnalysis(file: f, at: t)
  }

  private func startAnalysis(file f: Int, at t: Double) {
    guard f >= 0, f < fileURLs.count else { return }
    nextToken += 1
    files[f] = FileAnalysis(token: nextToken, detector: nil, from: max(0, t), until: max(0, t))
    advance(file: f, playhead: t)
  }

  /// Read the next chunk when the map is short of the look-ahead target.
  private func advance(file f: Int, playhead t: Double) {
    guard var a = files[f], !a.inFlight, !a.eof, !a.failed, a.until < t + Self.lookAhead else { return }
    a.inFlight = true
    files[f] = a
    let url = fileURLs[f]
    let from = a.until
    let to = from + Self.chunk
    let token = a.token
    let detector = a.detector
    Self.readChunk(url: url, from: from, to: to, detector: detector, queue: queue) { [weak self] result in
      DispatchQueue.main.async { self?.chunkRead(file: f, token: token, to: to, result: result) }
    }
  }

  private func chunkRead(file f: Int, token: Int, to: Double, result: ChunkResult) {
    guard var a = files[f], a.token == token else { return } // superseded by a newer analysis
    a.inFlight = false
    switch result {
    case .failed:
      a.failed = true
    case let .read(detector, silences, eof):
      a.detector = detector
      a.until = eof ? max(a.until, detector?.processedUntil ?? a.until) : to
      a.eof = eof
      a.spans.append(contentsOf: SmartSpeedPlanner.spans(silences))
    }
    files[f] = a
    guard isActive, let head = host?.smartSpeedPlayhead() else { return }
    if head.fileIndex == f {
      registerBoundaries()
      evaluate()
    }
    ensureLookAhead()
  }

  // MARK: Reading (background queue)

  enum ChunkResult {
    case read(SilenceDetector?, [Silence], eof: Bool)
    case failed
  }

  /// Decode [from, to) of a local file to 16-bit interleaved PCM and feed the detector. The
  /// track list is loaded asynchronously (never the blocking getter), then the reader runs on
  /// `queue`. EOF = the reader finished before reaching `to`.
  private static func readChunk(url: URL, from: Double, to: Double, detector: SilenceDetector?,
                                queue: DispatchQueue, completion: @escaping (ChunkResult) -> Void) {
    let asset = AVURLAsset(url: url)
    asset.loadTracks(withMediaType: .audio) { tracks, _ in
      queue.async {
        guard let track = tracks?.first else { completion(.failed); return }
        completion(decode(asset: asset, track: track, from: from, to: to, detector: detector))
      }
    }
  }

  private static func decode(asset: AVAsset, track: AVAssetTrack, from: Double, to: Double,
                             detector: SilenceDetector?) -> ChunkResult {
    guard let reader = try? AVAssetReader(asset: asset) else { return .failed }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false,
    ])
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { return .failed }
    reader.add(output)
    reader.timeRange = CMTimeRange(start: CMTime(seconds: from, preferredTimescale: 1000),
                                   end: CMTime(seconds: to, preferredTimescale: 1000))
    guard reader.startReading() else { return .failed }
    var det = detector
    var found: [Silence] = []
    while let sample = output.copyNextSampleBuffer() {
      let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
      guard pts.isFinite else { continue }
      if det == nil {
        guard let format = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee else { continue }
        det = SilenceDetector(sampleRate: asbd.mSampleRate, channels: Int(asbd.mChannelsPerFrame), from: from)
      }
      // A contiguous copy of the buffer's PCM (a block buffer may be fragmented).
      var blockBuffer: CMBlockBuffer?
      var abl = AudioBufferList()
      let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sample, bufferListSizeNeededOut: nil, bufferListOut: &abl,
        bufferListSize: MemoryLayout<AudioBufferList>.size, blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil, flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        blockBufferOut: &blockBuffer)
      guard status == noErr, let data = abl.mBuffers.mData else { continue }
      let count = Int(abl.mBuffers.mDataByteSize) / MemoryLayout<Int16>.size
      let samples = UnsafeBufferPointer(start: data.assumingMemoryBound(to: Int16.self), count: count)
      found.append(contentsOf: det!.consume(samples, at: pts))
    }
    if reader.status == .failed { return .failed }
    reader.cancelReading()
    let reached = det?.processedUntil ?? from
    let eof = reached < to - 0.5
    if eof, let tail = det?.finish() { found.append(tail) }
    return .read(det, found, eof: eof)
  }
}
