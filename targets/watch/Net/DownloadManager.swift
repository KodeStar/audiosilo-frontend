// The books on this watch (On this watch) and getting them here: a book from Continue
// listening's Download button or the phone's `book` message is queued, its item and chapters
// are read and kept (offline playback needs the timeline), its watch rendition is prepared and
// polled in the FOREGROUND until each file is ready (RenditionPlan), and each ready file goes to
// the background session. Free space is checked first: the rendition's bytes plus 200 MB
// (decision 8). Books are removed by hand.
import Foundation

/// A book's item and chapters, kept for offline playback (items/).
struct ItemCache: Codable, Equatable {
  var book: Book
  var chapters: ChaptersResponse?
  /// The server's place when the download started (the phone's keepServerPlace): what an
  /// offline first play opens at when Continue listening does not list the book.
  var serverPlace: ProgressRow?

  static func load(_ ref: BookRef) -> ItemCache? { JSONFile<ItemCache>(url: Files.item(ref)).read() }
  func save(_ ref: BookRef) { JSONFile<ItemCache>(url: Files.item(ref)).write(self) }
  var timeline: Timeline { Timeline(book: book, chapters: chapters) }
}

struct DownloadedFile: Codable, Equatable {
  /// The original file's rel path (the rendition's `path`).
  var path: String
  /// Its file name in the book's folder.
  var local: String
  var bytes: Int64?
  var done: Bool
  /// Its audio seconds (the timeline's), weighing it in the book's percent; nil on a record
  /// written before 2.7.0, where every file weighs the same.
  var duration: Double? = nil
}

struct DownloadRecord: Codable, Equatable, Identifiable {
  var ref: BookRef
  var title: String
  var author: String?
  /// The book's folder under downloads/.
  var folder: String
  var state: WatchStateBook.State
  /// In play order (the timeline's), filled once the item is read.
  var files: [DownloadedFile] = []
  /// Why it failed, or what it waits for.
  var message: String?
  var addedAt: Date

  var id: String { ref.key }
  var doneCount: Int { files.filter(\.done).count }
  /// The bytes on the watch (each file's size, set when it lands).
  var bytes: Int64 { files.compactMap(\.bytes).reduce(0, +) }

  /// Bytes came or the server answered: a wait the message named is over (a failure stays).
  mutating func endWait() {
    if DownloadWait(message: message) != nil { message = nil }
  }

  /// Every file has landed: the book is ready.
  mutating func readyIfDone() {
    guard !files.isEmpty, files.allSatisfy(\.done) else { return }
    state = .ready
    message = nil
  }
}

@MainActor
final class DownloadManager: ObservableObject {
  /// A staged file this old has lost its event.
  private static let STAGING_KEEP: TimeInterval = 10 * 60

  @Published private(set) var records: [DownloadRecord]
  /// How far each book downloading has come, 0...99 by audio time (`DownloadProgress.percent`),
  /// by book key. In memory: a suspended app hears of a file only when it lands.
  @Published private(set) var percents: [String: Int] = [:]
  /// False when the last write of the index failed (a full disk): `records` would not survive a kill.
  private(set) var indexSaved = true
  /// The files this launch handed to the background session (`DownloadTaskTag.key`).
  private var handedOff: Set<String> = []

  private let index = JSONFile<[DownloadRecord]>(url: Files.downloadsIndex)
  /// The client for the account's current address, nil when signed out.
  var client: () -> APIClient? = { nil }
  /// The account's home address, nil when it has none.
  var homeAddress: () -> String? = { nil }
  /// Told whenever the list changes (watch-state).
  var onChange: (() -> Void)?
  /// Removing the book that is playing stops it first and closes its span.
  var willRemove: ((BookRef) -> Void)?

  /// Whether the app is in the foreground: the rendition polling runs only then. False until it
  /// first gets there (a launch for a background wake polls nothing).
  private(set) var active = false
  private var working: [String: Task<Void, Never>] = [:]
  /// Which run `working` holds per book.
  private var runs: [String: UUID] = [:]
  /// Resume data for a file whose transfer broke (`book|path`).
  private var resumeData: [String: Data] = [:]
  /// The share of each file in flight that has come (0...1), by book key, then by the file's path.
  private var fractions: [String: [String: Double]] = [:]
  /// The files the server last said were ready, by book key (the phone's "n of m files").
  private var serverReady: [String: Set<String>] = [:]

  init() {
    records = index.read() ?? []
    for r in records { refreshPercent(r.id) }
    BackgroundDownloads.shared.handler = { [weak self] e in self?.handle(e) }
  }

  func record(_ ref: BookRef) -> DownloadRecord? { records.first { $0.ref == ref } }

  private func update(_ key: String, _ change: (inout DownloadRecord) -> Void) {
    guard let i = records.firstIndex(where: { $0.id == key }) else { return }
    change(&records[i])
    if records[i].state == .ready {
      // Nothing of it is on its way any more.
      fractions[key] = nil
      serverReady[key] = nil
    }
    refreshPercent(key)
    save()
  }

  private func save() {
    indexSaved = index.write(records)
    onChange?()
  }

  func folder(of r: DownloadRecord) -> URL {
    Files.downloads.appendingPathComponent(r.folder, isDirectory: true)
  }

  /// A downloaded file's location, for the player.
  func localURL(_ r: DownloadRecord, file: DownloadedFile) -> URL {
    folder(of: r).appendingPathComponent(file.local)
  }

  // MARK: - Queueing

  /// Queue a book (the Download button, the phone's `book`). A failed one is tried again; one
  /// already here or on its way is left alone.
  func enqueue(_ ref: BookRef, title: String, author: String?) {
    if let r = record(ref) {
      guard r.state == .failed else { return }
      update(r.id) {
        $0.state = .queued
        $0.message = nil
      }
    } else {
      records.append(DownloadRecord(ref: ref, title: title, author: author, folder: UUID().uuidString, state: .queued,
                                    addedAt: Date()))
      save()
    }
    process(ref.key)
  }

  /// The app came to the foreground (or signed in): carry on with every book not done.
  func resumeAll() {
    active = true
    sweepStaging(olderThan: Self.STAGING_KEEP)
    for r in records where r.state != .ready && r.state != .failed { process(r.id) }
  }

  /// The app went to the background: the polling stops (the background session goes on).
  func pause() {
    active = false
    for t in working.values { t.cancel() }
    working = [:]
    runs = [:]
  }

  /// Remove a book from the watch (its files, its record, its tasks).
  func remove(_ ref: BookRef) {
    guard let r = record(ref) else { return }
    willRemove?(ref)
    stopWork(r.id)
    BackgroundDownloads.shared.cancel(book: r.id)
    // A cancelled task brings no event: forget its hand-off and resume data here, or the same
    // book downloaded again would skip those files (and resume with this sign-in's request).
    for f in r.files {
      let k = DownloadTaskTag(book: r.id, path: f.path).key
      handedOff.remove(k)
      resumeData[k] = nil
    }
    fractions[r.id] = nil
    serverReady[r.id] = nil
    percents[r.id] = nil
    try? FileManager.default.removeItem(at: folder(of: r))
    try? FileManager.default.removeItem(at: Files.item(ref))
    records.removeAll { $0.id == r.id }
    save()
  }

  /// Remove every book (the account was replaced).
  func removeAll() {
    for r in records { remove(r.ref) }
    sweepStaging(olderThan: 0)
  }

  /// A staged file whose event never came (a kill just after the move): nothing else removes it.
  /// Not at launch: an event still on its way holds a staged file.
  private func sweepStaging(olderThan age: TimeInterval) {
    let fm = FileManager.default
    let key = URLResourceKey.contentModificationDateKey
    let files = (try? fm.contentsOfDirectory(at: Files.staging, includingPropertiesForKeys: [key])) ?? []
    for file in files {
      let written = (try? file.resourceValues(forKeys: [key]).contentModificationDate) ?? .distantPast
      if Date().timeIntervalSince(written) >= age { try? fm.removeItem(at: file) }
    }
  }

  // MARK: - Preparing

  /// Cancel a book's run (a new one may start at once: `process` skips a book with one).
  private func stopWork(_ key: String) {
    working[key]?.cancel()
    working[key] = nil
    runs[key] = nil
  }

  /// Start a book's run (`after` seconds from now: a refusal's wait), unless it has one.
  private func process(_ key: String, after wait: TimeInterval = 0) {
    guard active, working[key] == nil else { return }
    let run = UUID()
    runs[key] = run
    working[key] = Task { [weak self] in
      if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
      // Cancelled while it waited: whoever cancelled it has cleared its entries.
      if Task.isCancelled { return }
      await self?.run(key)
      // Only this run's own entry: a retry may have started the next one already.
      if self?.runs[key] == run {
        self?.working[key] = nil
        self?.runs[key] = nil
      }
    }
  }

  private func fail(_ key: String, _ message: String) {
    update(key) {
      $0.state = .failed
      $0.message = message
    }
  }

  private func run(_ key: String) async {
    guard let r0 = records.first(where: { $0.id == key }), client() != nil else { return }
    let ref = r0.ref
    /// Read for every request: a run can outlast the pick it began on (the watch left home), and
    /// the token must not go on following that address. Signed out meanwhile, the run is over.
    func current() throws -> APIClient {
      guard let api = client() else { throw CancellationError() }
      return api
    }
    if r0.files.isEmpty || r0.state == .queued {
      update(key) {
        $0.state = .preparing
        $0.message = nil
      }
    }
    do {
      // The item and chapters first: the timeline orders the files and lasts offline.
      if records.first(where: { $0.id == key })?.files.isEmpty ?? true {
        let book = try await current().item(ref)
        // Kept as "no chapters", a passing failure would stay in the book's timeline for good.
        let chapters: ChaptersResponse?
        do {
          chapters = try await current().chapters(ref)
        } catch let e as APIError where RenditionPlan.meansNoChapters(e) {
          chapters = nil
        }
        let serverPlace = try? await current().progress(ref)
        try Task.checkCancellation()
        let cache = ItemCache(book: book, chapters: chapters, serverPlace: serverPlace)
        cache.save(ref)
        let timeline = cache.timeline
        update(key) { rec in
          rec.title = book.title.isEmpty ? rec.title : book.title
          rec.author = book.author ?? rec.author
          rec.files = timeline.files.enumerated().map { i, f in
            DownloadedFile(path: f.path, local: String(format: "%03d.m4a", i), bytes: nil, done: false,
                           duration: f.duration)
          }
        }
      }
      var answer = try await current().prepareRenditions(ref)
      stopWaiting(key)
      guard checkSpace(key, answer) else { return }
      while !Task.isCancelled {
        guard answerCovers(key, answer) else { return }
        let step = RenditionPlan.step(answer)
        noteServerReady(key, step.ready)
        if !step.ready.isEmpty {
          // What the session carries now, a previous launch's transfers too: never handed twice.
          let inFlight = await BackgroundDownloads.shared.inFlight()
          let api = try current()
          for f in step.ready { startFile(key, f, api: api, inFlight: inFlight) }
        }
        switch step.action {
        case .done:
          markIfDone(key)
          return
        case .failed:
          fail(key, RenditionPlan.message(.failed(retryAfter: nil)) ?? "")
          return
        case .poll(let after):
          try await Task.sleep(for: .seconds(after))
          answer = try await current().renditionStatus(ref)
        case .prepareAgain(let after):
          try await Task.sleep(for: .seconds(after))
          answer = try await current().prepareRenditions(ref)
        }
      }
    } catch let e where e is CancellationError || Task.isCancelled {
      // Backgrounded (or removed): carried on at the next foreground. A cancelled request
      // throws URLError(.cancelled), not CancellationError.
    } catch let e as APIError {
      let refusal = RenditionPlan.refusal(e)
      if case .retry(let after) = refusal {
        update(key) { $0.message = DownloadWait.server.message }
        try? await Task.sleep(for: .seconds(after))
        if !Task.isCancelled {
          // This run is the one in `working`: clear it so the next can start.
          working[key] = nil
          runs[key] = nil
          process(key)
        }
      } else if let message = RenditionPlan.message(refusal) {
        fail(key, message)
      }
    } catch {
      // No answer: it waits for the next foreground.
      update(key) { $0.message = DownloadWait.connection.message }
    }
  }

  /// An answer that does not hold the book's files can never finish: the book changed on the
  /// server since its item was read. Try again reads the item afresh.
  private func answerCovers(_ key: String, _ answer: RenditionsAnswer) -> Bool {
    guard let r = records.first(where: { $0.id == key }) else { return false }
    if RenditionPlan.covers(answer, wanted: r.files.map(\.path)) { return true }
    update(key) { $0.files = [] }
    fail(key, "This book changed on the server. Try again.")
    return false
  }

  /// Refuse a book that would not leave 200 MB free. Only for what is still to come: a file
  /// landed or already with the session (its bytes are noted when handed over) has its space.
  private func checkSpace(_ key: String, _ answer: RenditionsAnswer) -> Bool {
    guard let r = records.first(where: { $0.id == key }), let free = Files.freeBytes() else { return true }
    let handed = Set(r.files.filter { $0.done || $0.bytes != nil }.map(\.path))
    let durations = ItemCache.load(r.ref).map { cache in
      Dictionary(cache.timeline.files.map { ($0.path, $0.duration) }, uniquingKeysWith: { a, _ in a })
    } ?? [:]
    let needed = RenditionPlan.neededBytes(answer.files.filter { !handed.contains($0.path) }, durations: durations)
    if RenditionPlan.fits(needed: needed, free: free) { return true }
    fail(key, "Not enough space on this watch: it needs \(Labels.bytes(needed)) and keeps \(Labels.bytes(RenditionPlan.HEADROOM_BYTES)) free; \(Labels.bytes(free)) is free.")
    return false
  }

  private func startFile(_ key: String, _ file: RenditionFile, api: APIClient, inFlight: [String: URLSessionTask]) {
    guard let r = records.first(where: { $0.id == key }),
          let f = r.files.first(where: { $0.path == file.path }), !f.done
    else { return }
    let tag = DownloadTaskTag(book: key, path: file.path)
    guard let request = try? api.renditionDownload(libraryId: r.ref.libraryId, file: file.path) else { return }
    if let task = inFlight[tag.key] {
      let auth = "Authorization"
      let keeps = RenditionPlan.keepsTransfer(
        url: task.originalRequest?.url?.absoluteString, authorization: task.originalRequest?.value(forHTTPHeaderField: auth),
        wantedURL: request.url?.absoluteString, wantedAuthorization: request.value(forHTTPHeaderField: auth),
        home: homeAddress())
      if keeps { return }
      // A plain cancel brings no event (the delegate reads it as removed by hand).
      task.cancel()
      handedOff.remove(tag.key)
      resumeData[tag.key] = nil
      fractions[key]?[file.path] = nil
    } else if handedOff.contains(tag.key) {
      return
    }
    handedOff.insert(tag.key)
    update(key) { rec in
      rec.state = .downloading
      if let i = rec.files.firstIndex(where: { $0.path == file.path }) { rec.files[i].bytes = file.bytes }
    }
    BackgroundDownloads.shared.start(request, tag: tag, expectedBytes: file.bytes, resumeData: resumeData.removeValue(forKey: tag.key))
  }

  private func markIfDone(_ key: String) {
    update(key) { $0.readyIfDone() }
  }

  // MARK: - The background session's events

  private func handle(_ e: DownloadEvent) {
    switch e {
    case .finished(let tag, let staged):
      handedOff.remove(tag.key)
      guard let r = records.first(where: { $0.id == tag.book }),
            let i = r.files.firstIndex(where: { $0.path == tag.path })
      else {
        try? FileManager.default.removeItem(at: staged)  // removed meanwhile
        return
      }
      let dest = localURL(r, file: r.files[i])
      try? FileManager.default.createDirectory(at: folder(of: r), withIntermediateDirectories: true)
      try? FileManager.default.removeItem(at: dest)
      do {
        try FileManager.default.moveItem(at: staged, to: dest)
        let size = Files.size(of: dest)
        fractions[tag.book]?[tag.path] = nil
        // Ready in the same change when it was the last: the phone is never told of a book still
        // downloading with every file here.
        update(tag.book) {
          $0.files[i].done = true
          $0.files[i].bytes = size
          $0.endWait()
          $0.readyIfDone()
        }
      } catch {
        try? FileManager.default.removeItem(at: staged)
        fail(tag.book, "The watch could not keep a file of this book.")
      }
    case .refused(let tag, let error):
      handedOff.remove(tag.key)
      fractions[tag.book]?[tag.path] = nil
      let refusal = RenditionPlan.refusal(error)
      if case .retry(let after) = refusal {
        // Not ready after all (`rendition_pending`): poll again, after the server's wait (the
        // next answer can say ready at once, and refuse again). Until then it is not one of the
        // files ready, nor with the session (its bytes are noted again when it is handed over).
        stopWork(tag.book)
        serverReady[tag.book]?.remove(tag.path)
        update(tag.book) { r in
          r.state = .preparing
          if let i = r.files.firstIndex(where: { $0.path == tag.path && !$0.done }) { r.files[i].bytes = nil }
        }
        process(tag.book, after: after)
      } else if let message = RenditionPlan.message(refusal) {
        fail(tag.book, message)
      }
    case .failed(let tag, let data):
      handedOff.remove(tag.key)
      guard records.contains(where: { $0.id == tag.book }) else { return }  // removed meanwhile
      // With no resume data the file starts again from nothing.
      if let data { resumeData[tag.key] = data } else { fractions[tag.book]?[tag.path] = nil }
      update(tag.book) { $0.message = DownloadWait.connection.message }
    case .progress(let tag, let fraction):
      guard records.contains(where: { $0.id == tag.book }) else { return }  // removed meanwhile
      fractions[tag.book, default: [:]][tag.path] = fraction
      stopWaiting(tag.book)
      if refreshPercent(tag.book) { onChange?() }
    }
  }

  // MARK: - How far a book has come (watch-state, Home)

  /// Bytes are coming or the server answered: a wait the row named is over.
  private func stopWaiting(_ key: String) {
    guard let r = records.first(where: { $0.id == key }), DownloadWait(message: r.message) != nil else { return }
    update(key) { $0.endWait() }
  }

  /// The files the server has ready now; told to the phone when they change.
  private func noteServerReady(_ key: String, _ ready: [RenditionFile]) {
    let paths = Set(ready.map(\.path))
    guard serverReady[key] != paths else { return }
    serverReady[key] = paths
    onChange?()
  }

  /// Work the book's percent out again (every change of its record, every chunk told); true when
  /// the step `watch-state` carries moved, which is news for the phone.
  @discardableResult
  private func refreshPercent(_ key: String) -> Bool {
    let was = percents[key]
    let now = records.first(where: { $0.id == key }).flatMap(percent)
    if now != was { percents[key] = now }
    return now.map(DownloadProgress.published) != was.map(DownloadProgress.published)
  }

  /// A downloading book's share of its audio on the watch, nil for any other.
  private func percent(_ r: DownloadRecord) -> Int? {
    guard r.state == .downloading, !r.files.isEmpty else { return nil }
    let coming = fractions[r.id] ?? [:]
    return DownloadProgress.percent(r.files.map { f in
      DownloadProgress.File(duration: f.duration ?? 0, done: f.done, fraction: coming[f.path] ?? 0)
    })
  }

  /// What `watch-state` says of a book: its stage, its size once ready, and while on its way how
  /// far it has come (fe#241: the phone's Downloads row).
  func stateBook(_ r: DownloadRecord) -> WatchStateBook {
    var b = WatchStateBook(ref: r.ref, title: r.title, state: r.state, bytes: r.state == .ready ? r.bytes : nil)
    guard r.state == .preparing || r.state == .downloading else { return b }
    b.waiting = DownloadWait(message: r.message)
    guard !r.files.isEmpty else { return b }
    let handed = Set(r.files.filter { f in
      f.done || f.bytes != nil || handedOff.contains(DownloadTaskTag(book: r.id, path: f.path).key)
    }.map(\.path))
    b.filesTotal = r.files.count
    b.filesReady = DownloadProgress.filesReady(r.files.map(\.path), handed: handed, serverReady: serverReady[r.id] ?? [])
    if r.state == .downloading {
      b.progress = DownloadProgress.published(percents[r.id] ?? 0)
    }
    return b
  }
}
