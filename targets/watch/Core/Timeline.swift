// The whole-book timeline, a port of the phone's `src/playback/book-queue.ts` (CONVENTIONS.md
// "Whole-book timeline"): each distinct audio file is one track, chapters are markers laid over
// one timeline of summed file durations, and positions are whole-book seconds. Keep the two in
// step; the vectors in watch-core/Tests are book-queue.test.ts's.
import Foundation

/// Treat within 5 s of the end as finished.
let FINISHED_TOLERANCE: Double = 5

/// Default length (seconds) of the chapters made up for a long, chapterless single file.
let DEFAULT_VIRTUAL_CHAPTER_INTERVAL: Double = 30 * 60

/// One distinct audio file of a book, in play order.
struct FileSpec: Codable, Equatable, Sendable {
  var path: String
  var duration: Double
  var size: Int64
}

/// The server's file list for a book (the chapters response's, else the book's).
private func bookFileList(_ book: Book, _ chapterData: ChaptersResponse?) -> [BookFile] {
  if let files = chapterData?.files, !files.isEmpty { return files }
  return book.files ?? []
}

/// The distinct audio files of a book in play order: the explicit file list by `seq`, else the
/// files the chapters name, else the book path itself. Never a folder path.
func bookFileSpecs(_ book: Book, _ chapterData: ChaptersResponse? = nil) -> [FileSpec] {
  let files = bookFileList(book, chapterData)
  if !files.isEmpty {
    return files.enumerated()
      .sorted { $0.element.seq == $1.element.seq ? $0.offset < $1.offset : $0.element.seq < $1.element.seq }
      .map { FileSpec(path: $0.element.relPath, duration: $0.element.duration, size: $0.element.size) }
  }
  let raw = chapterData?.chapters ?? book.chapters ?? []
  if !raw.isEmpty {
    return distinctFilesFromChapters(raw).map { FileSpec(path: $0.path, duration: $0.duration, size: 0) }
  }
  return [FileSpec(path: book.relPath, duration: book.duration, size: book.size ?? 0)]
}

/// Distinct files named by the chapters, in first-seen order, each lasting its largest
/// chapter end.
private func distinctFilesFromChapters(_ chapters: [Chapter]) -> [(path: String, duration: Double)] {
  var order: [String] = []
  var durations: [String: Double] = [:]
  for ch in chapters {
    if !order.contains(ch.filePath) { order.append(ch.filePath) }
    durations[ch.filePath] = max(durations[ch.filePath] ?? 0, ch.end)
  }
  return order.map { ($0, durations[$0] ?? 0) }
}

/// A chapter's whole-book start: the summed positive durations of the files before it plus its
/// in-file start. Located by `file_path`, else a valid `file_index`, else 0 files before (never
/// the server's `book_offset`, which some books send as 0 for every chapter).
func chapterBookOffset(_ files: [FileSpec], _ ch: Chapter) -> Double {
  let byPath = files.firstIndex { $0.path == ch.filePath }
  let inRange = ch.fileIndex >= 0 && ch.fileIndex < files.count
  let upto = byPath ?? (inRange ? ch.fileIndex : 0)
  var acc = 0.0
  for i in 0..<min(upto, files.count) where files[i].duration > 0 { acc += files[i].duration }
  return acc + ch.start
}

private func fileIndexOf(_ specs: [FileSpec], _ ch: Chapter) -> Int? {
  if let i = specs.firstIndex(where: { $0.path == ch.filePath }) { return i }
  return ch.fileIndex >= 0 && ch.fileIndex < specs.count ? ch.fileIndex : nil
}

/// Per-chapter clips for Now Playing's chapter controls: `[]` for 0 or 1 chapters, for a
/// chapter no file maps to, for a non-final in-file chapter with no length, or when a file has
/// no chapter (file mode is the safe fallback). A file's last chapter clips to its end (0).
func buildChapterClips(_ specs: [FileSpec], _ chapters: [Chapter]) -> [ChapterClip] {
  if chapters.count <= 1 { return [] }
  let indices = chapters.map { fileIndexOf(specs, $0) }
  var clips: [ChapterClip] = []
  var covered = Set<Int>()
  for (i, ch) in chapters.enumerated() {
    guard let fileIndex = indices[i] else { return [] }
    let lastInFile = i + 1 >= chapters.count || indices[i + 1] != fileIndex
    if !lastInFile && ch.end <= ch.start { return [] }
    clips.append(
      ChapterClip(
        fileIndex: fileIndex,
        startInFile: max(0, ch.start),
        endInFile: lastInFile ? 0 : max(0, ch.end),
        title: ch.title))
    covered.insert(fileIndex)
  }
  return covered.count == specs.count ? clips : []
}

/// Evenly spaced chapters for a long chapterless single file (`ceil(total / interval)` of them,
/// the last ending at `total`); `[]` below 1.5 intervals. Never made into clips.
func synthesizeChapters(_ filePath: String, _ total: Double, _ interval: Double = DEFAULT_VIRTUAL_CHAPTER_INTERVAL)
  -> [Chapter]
{
  if interval <= 0 || total <= interval * 1.5 { return [] }
  let count = Int((total / interval).rounded(.up))
  return (0..<count).map { i in
    let start = Double(i) * interval
    return Chapter(
      index: i, title: "", fileIndex: 0, filePath: filePath, start: start,
      end: min(start + interval, total), bookOffset: start)
  }
}

/// Where a chapter ends on the book timeline (bad metadata with `end` before `start` is a
/// chapter of no length).
func chapterEndPosition(_ ch: Chapter) -> Double {
  ch.bookOffset + max(0, ch.end - ch.start)
}

/// The chapter at a whole-book position (the first one before every chapter); nil with none.
func chapterAt(_ chapters: [Chapter], _ position: Double) -> Chapter? {
  var current: Chapter?
  for ch in chapters {
    if position >= ch.bookOffset { current = ch } else { break }
  }
  return current ?? chapters.first
}

/// The nearest chapter end more than `minSeconds` of wall clock ahead (the sleep timer's end of
/// chapter); nil when none is.
func nextChapterEnd(_ chapters: [Chapter], _ position: Double, rate: Double, minSeconds: Double)
  -> (chapter: Chapter, endPosition: Double, untilEnd: Double)?
{
  var nearest: (chapter: Chapter, endPosition: Double, untilEnd: Double)?
  for ch in chapters {
    let end = chapterEndPosition(ch)
    let until = wallClockSeconds(end - position, rate: rate)
    if until > minSeconds && (nearest == nil || end < nearest!.endPosition) {
      nearest = (ch, end, until)
    }
  }
  return nearest
}

/// Content seconds as wall-clock seconds at `rate` (rate.ts's `wallClockSeconds`).
func wallClockSeconds(_ contentSeconds: Double, rate: Double) -> Double {
  rate > 0 && rate.isFinite ? contentSeconds / rate : contentSeconds
}

/// A whole-book position as (track index, seconds into it), over the tracks' `offsets`.
func locateIn(_ offsets: [Double], _ position: Double) -> (index: Int, positionInTrack: Double) {
  var index = 0
  for (i, o) in offsets.enumerated() {
    if position >= o { index = i } else { break }
  }
  let start = offsets.indices.contains(index) ? offsets[index] : 0
  return (index, max(0, position - start))
}

/// (track index, seconds into it) as a whole-book position.
func toBookPosition(_ offsets: [Double], _ index: Int, _ positionInTrack: Double) -> Double {
  (offsets.indices.contains(index) ? offsets[index] : 0) + positionInTrack
}

/// A book's playable timeline.
struct Timeline: Equatable, Sendable {
  var files: [FileSpec]
  /// Whole-book start (seconds) of each file.
  var offsets: [Double]
  /// The timeline's length: the book's, the files' summed, or the furthest chapter end.
  var total: Double
  /// The audio's own length: every file's duration summed, from the server's file list; 0 when
  /// unknown (estimated from the chapters, or a file without one). A span event's `duration`.
  var audio: Double
  var chapters: [Chapter]
  var chapterClips: [ChapterClip]
  var syntheticChapters: Bool

  init(book: Book, chapters chapterData: ChaptersResponse? = nil,
       virtualChapterInterval: Double = DEFAULT_VIRTUAL_CHAPTER_INTERVAL)
  {
    let raw = chapterData?.chapters ?? book.chapters ?? []
    let specs = bookFileSpecs(book, chapterData)
    var offsets: [Double] = []
    var acc = 0.0
    for s in specs {
      offsets.append(acc)
      if s.duration > 0 { acc += s.duration }
    }
    let chapters = raw.map { ch -> Chapter in
      var c = ch
      c.bookOffset = chapterBookOffset(specs, ch)
      return c
    }
    let furthest = chapters.reduce(0.0) { max($0, chapterEndPosition($1)) }
    let total = max(book.duration > 0 ? book.duration : 0, acc, furthest)
    let estimated = bookFileList(book, chapterData).isEmpty && !raw.isEmpty
    let audio = !estimated && specs.allSatisfy({ $0.duration > 0 }) ? acc : 0
    let clips = buildChapterClips(specs, chapters)
    let synthetic =
      specs.count == 1 && chapters.count <= 1
      ? synthesizeChapters(specs[0].path, total, virtualChapterInterval) : []
    self.files = specs
    self.offsets = offsets
    self.total = total
    self.audio = audio
    self.chapters = synthetic.isEmpty ? chapters : synthetic
    self.chapterClips = clips
    self.syntheticChapters = !synthetic.isEmpty
  }

  /// A whole-book position as (file index, seconds into it).
  func locate(_ position: Double) -> (index: Int, positionInTrack: Double) {
    locateIn(offsets, position)
  }

  /// (file index, seconds into it) as a whole-book position.
  func bookPosition(index: Int, positionInTrack: Double) -> Double {
    toBookPosition(offsets, index, positionInTrack)
  }

  /// A place in the book as a span end (its file and seconds in it), nil when it is not a
  /// number (an engine that reports NaN never puts one in a span).
  func spanEnd(index: Int, positionInTrack: Double) -> SpanEnd? {
    let pos = bookPosition(index: index, positionInTrack: positionInTrack)
    guard pos.isFinite, positionInTrack.isFinite else { return nil }
    let file = files.indices.contains(index) ? files[index].path : nil
    return SpanEnd(pos: max(0, pos), file: file, filePos: file == nil ? nil : max(0, positionInTrack))
  }

  /// Where a saved place resumes: in its file at its own seconds when the book still has the
  /// file (clamped to the file's length), else by the whole-book position (fe#188).
  func resumePlace(position: Double, file: String?, filePos: Double?) -> (index: Int, positionInTrack: Double) {
    if let file, let filePos, filePos.isFinite, let i = files.firstIndex(where: { $0.path == file }) {
      let d = files[i].duration
      return (i, max(0, d > 0 ? min(filePos, d) : filePos))
    }
    return locate(position)
  }
}
