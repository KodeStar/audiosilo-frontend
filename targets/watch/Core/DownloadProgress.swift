// How far a book's download has come, for Home's On the way row and the phone's Downloads row
// (fe#241). Pure: the DownloadManager feeds it the book's files and the bytes in flight. The
// percent is by audio time, not bytes: a book's files are encoded one by one on the server, so a
// file's size is known only once it is ready, while every file's duration is in the timeline.
import Foundation

enum DownloadProgress {
  /// `watch-state` carries the percent in steps this big, so the phone hears of a download about
  /// 20 times, not with every chunk that lands.
  static let STEP = 5

  /// One file of the book, in play order.
  struct File: Equatable, Sendable {
    /// Its audio seconds (the timeline's).
    var duration: Double
    /// Landed on the watch.
    var done: Bool
    /// How much of its transfer has come, 0...1 (0 when none is going on).
    var fraction: Double = 0
  }

  /// The share of the book's audio on the watch, 0...100: whole files landed plus the part of each
  /// transfer in flight. Under 100 until every file has landed (a rounded 100 would read as ready).
  /// Files weigh by duration; unless every file has one, each weighs the same (a file of no known
  /// length would weigh nothing, and the book read as all but here with that file still to come).
  static func percent(_ files: [File]) -> Int {
    guard !files.isEmpty else { return 0 }
    if files.allSatisfy(\.done) { return 100 }
    let durations = files.map { $0.duration.isFinite && $0.duration > 0 ? $0.duration : 0 }
    let weights = durations.allSatisfy({ $0 > 0 }) ? durations : files.map { _ in 1.0 }
    let whole = weights.reduce(0, +)
    let have = zip(files, weights).reduce(0.0) { sum, pair in
      let (f, w) = pair
      return sum + w * (f.done ? 1 : clamp(f.fraction))
    }
    return min(99, max(0, Int((have / whole * 100).rounded(.down))))
  }

  /// What a book still downloading says: never behind what it `reached` before (a launch has lost
  /// the bytes in flight, a transfer begun again has fewer), and under 100 whatever has landed (its
  /// last file makes it ready, never "100%" and still downloading).
  static func shown(_ percent: Int, reached: Int?) -> Int {
    min(99, max(0, percent, reached ?? 0))
  }

  /// The percent as `watch-state` carries it: down to the step below.
  static func published(_ percent: Int) -> Int {
    let p = min(100, max(0, percent))
    return p - p % STEP
  }

  /// A transfer's share from its bytes; 0 when the size is not known.
  static func fraction(received: Int64, expected: Int64) -> Double {
    guard expected > 0, received > 0 else { return 0 }
    return clamp(Double(received) / Double(expected))
  }

  /// How many of the book's files the server has ready for the watch: landed, handed to the
  /// download session (only a ready file is), or ready in the last renditions answer.
  static func filesReady(_ paths: [String], handed: Set<String>, serverReady: Set<String>) -> Int {
    paths.filter { handed.contains($0) || serverReady.contains($0) }.count
  }

  private static func clamp(_ x: Double) -> Double { x.isFinite ? min(1, max(0, x)) : 0 }
}

/// What a download on its way waits for, as the phone's row says it (`watch-state`'s `waiting`).
enum DownloadWait: String, CaseIterable, Equatable, Sendable {
  /// No answer from the server, or a transfer broke: it carries on with the next connection.
  case connection
  /// The server asked for time (still encoding, or busy).
  case server

  /// The watch's own row text, kept in the record's `message`.
  var message: String {
    switch self {
    case .connection: return "Waiting for a connection"
    case .server: return "Waiting for the server"
    }
  }

  /// The wait a record's message names; nil for any other message (a failure says why itself).
  init?(message: String?) {
    guard let wait = Self.allCases.first(where: { $0.message == message }) else { return nil }
    self = wait
  }
}
