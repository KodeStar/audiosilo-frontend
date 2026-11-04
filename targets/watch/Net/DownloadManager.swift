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
}

@MainActor
final class DownloadManager: ObservableObject {
  @Published private(set) var records: [DownloadRecord]
  /// The files this launch handed to the background session (`DownloadTaskTag.key`).
  private var handedOff: Set<String> = []

  private let index = JSONFile<[DownloadRecord]>(url: Files.downloadsIndex)
  /// The client for the account's current address, nil when signed out.
  var client: () -> APIClient? = { nil }
  /// Told whenever the list changes (watch-state).
  var onChange: (() -> Void)?
  /// Removing the book that is playing stops it first and closes its span.
  var willRemove: ((BookRef) -> Void)?

  /// Whether the app is in the foreground: the rendition polling runs only then.
  private(set) var active = true
  private var working: [String: Task<Void, Never>] = [:]
  /// Which run `working` holds per book.
  private var runs: [String: UUID] = [:]
  /// Resume data for a file whose transfer broke (`book|path`).
  private var resumeData: [String: Data] = [:]

  init() {
    records = index.read() ?? []
    BackgroundDownloads.shared.handler = { [weak self] e in self?.handle(e) }
  }

  func record(_ ref: BookRef) -> DownloadRecord? { records.first { $0.ref == ref } }

  private func update(_ key: String, _ change: (inout DownloadRecord) -> Void) {
    guard let i = records.firstIndex(where: { $0.id == key }) else { return }
    change(&records[i])
    save()
  }

  private func save() {
    index.write(records)
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
    Task {
      let flying = Set(await BackgroundDownloads.shared.inFlight().map(\.key))
      for r in records where r.state != .ready && r.state != .failed {
        process(r.id, inFlight: flying)
      }
    }
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
    try? FileManager.default.removeItem(at: folder(of: r))
    try? FileManager.default.removeItem(at: Files.item(ref))
    records.removeAll { $0.id == r.id }
    save()
  }

  /// Remove every book (the account was replaced).
  func removeAll() {
    for r in records { remove(r.ref) }
  }

  // MARK: - Preparing

  /// Cancel a book's run (a new one may start at once: `process` skips a book with one).
  private func stopWork(_ key: String) {
    working[key]?.cancel()
    working[key] = nil
    runs[key] = nil
  }

  private func process(_ key: String, inFlight: Set<String> = []) {
    guard active, working[key] == nil else { return }
    let run = UUID()
    runs[key] = run
    working[key] = Task { [weak self] in
      await self?.run(key, inFlight: inFlight)
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

  private func run(_ key: String, inFlight: Set<String>) async {
    guard let r0 = records.first(where: { $0.id == key }), let api = client() else { return }
    let ref = r0.ref
    if r0.files.isEmpty || r0.state == .queued {
      update(key) {
        $0.state = .preparing
        $0.message = nil
      }
    }
    do {
      // The item and chapters first: the timeline orders the files and lasts offline.
      if records.first(where: { $0.id == key })?.files.isEmpty ?? true {
        let book = try await api.item(ref)
        let chapters = try? await api.chapters(ref)
        let cache = ItemCache(book: book, chapters: chapters)
        cache.save(ref)
        let timeline = cache.timeline
        update(key) { rec in
          rec.title = book.title.isEmpty ? rec.title : book.title
          rec.author = book.author ?? rec.author
          rec.files = timeline.files.enumerated().map { i, f in
            DownloadedFile(path: f.path, local: String(format: "%03d.m4a", i), bytes: nil, done: false)
          }
        }
      }
      var answer = try await api.prepareRenditions(ref)
      guard checkSpace(key, answer) else { return }
      while !Task.isCancelled {
        let step = RenditionPlan.step(answer)
        for f in step.ready { startFile(key, f, api: api, inFlight: inFlight) }
        switch step.action {
        case .done:
          markIfDone(key)
          return
        case .failed:
          fail(key, RenditionPlan.message(.failed(retryAfter: nil)) ?? "")
          return
        case .poll(let after):
          try await Task.sleep(nanoseconds: UInt64(after * 1e9))
          answer = try await api.renditionStatus(ref)
        case .prepareAgain(let after):
          try await Task.sleep(nanoseconds: UInt64(after * 1e9))
          answer = try await api.prepareRenditions(ref)
        }
      }
    } catch is CancellationError {
      // Backgrounded: carried on at the next foreground.
    } catch let e as APIError {
      let refusal = RenditionPlan.refusal(e)
      if case .retry(let after) = refusal {
        update(key) { $0.message = "Waiting for the server" }
        try? await Task.sleep(nanoseconds: UInt64(after * 1e9))
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
      update(key) { $0.message = "Waiting for a connection" }
    }
  }

  /// Refuse a book that would not leave 200 MB free.
  private func checkSpace(_ key: String, _ answer: RenditionsAnswer) -> Bool {
    guard let r = records.first(where: { $0.id == key }), let free = Files.freeBytes() else { return true }
    let done = Set(r.files.filter(\.done).map(\.path))
    let durations = ItemCache.load(r.ref).map { cache in
      Dictionary(cache.timeline.files.map { ($0.path, $0.duration) }, uniquingKeysWith: { a, _ in a })
    } ?? [:]
    let needed = RenditionPlan.neededBytes(answer.files.filter { !done.contains($0.path) }, durations: durations)
    if RenditionPlan.fits(needed: needed, free: free) { return true }
    fail(key, "Not enough space on this watch: it needs \(Labels.bytes(needed)) and keeps \(Labels.bytes(RenditionPlan.HEADROOM_BYTES)) free; \(Labels.bytes(free)) is free.")
    return false
  }

  private func startFile(_ key: String, _ file: RenditionFile, api: APIClient, inFlight: Set<String>) {
    guard let r = records.first(where: { $0.id == key }),
          let f = r.files.first(where: { $0.path == file.path }), !f.done
    else { return }
    let tag = DownloadTaskTag(book: key, path: file.path)
    if inFlight.contains(tag.key) || handedOff.contains(tag.key) { return }
    guard let request = try? api.renditionDownload(libraryId: r.ref.libraryId, file: file.path) else { return }
    handedOff.insert(tag.key)
    update(key) { rec in
      rec.state = .downloading
      if let i = rec.files.firstIndex(where: { $0.path == file.path }) { rec.files[i].bytes = file.bytes }
    }
    BackgroundDownloads.shared.start(request, tag: tag, expectedBytes: file.bytes, resumeData: resumeData.removeValue(forKey: tag.key))
  }

  private func markIfDone(_ key: String) {
    update(key) { r in
      if !r.files.isEmpty && r.files.allSatisfy(\.done) {
        r.state = .ready
        r.message = nil
      }
    }
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
      let dest = folder(of: r).appendingPathComponent(r.files[i].local)
      try? FileManager.default.createDirectory(at: folder(of: r), withIntermediateDirectories: true)
      try? FileManager.default.removeItem(at: dest)
      do {
        try FileManager.default.moveItem(at: staged, to: dest)
        let size = Files.size(of: dest)
        update(tag.book) {
          $0.files[i].done = true
          $0.files[i].bytes = size
        }
        markIfDone(tag.book)
      } catch {
        fail(tag.book, "The watch could not keep a file of this book.")
      }
    case .refused(let tag, let error):
      handedOff.remove(tag.key)
      let refusal = RenditionPlan.refusal(error)
      if case .retry = refusal {
        // Not ready after all (`rendition_pending`): poll again.
        stopWork(tag.book)
        update(tag.book) { $0.state = .preparing }
        process(tag.book)
      } else if let message = RenditionPlan.message(refusal) {
        fail(tag.book, message)
      }
    case .failed(let tag, let data):
      handedOff.remove(tag.key)
      if let data { resumeData[tag.key] = data }
      update(tag.book) { $0.message = "Waiting for a connection" }
    }
  }
}
