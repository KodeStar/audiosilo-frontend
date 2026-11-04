// Getting a book's watch rendition onto the watch (decision 6, Track W2's routes): `POST
// /libraries/{id}/renditions` prepares every file, `GET` polls (in the foreground) until each is
// `ready`, and only ready files go to the background download session
// (`/stream?path=<file>&rendition=watch&download=1`, Bearer auth, resumable). Pure: the
// DownloadManager asks what to do next.
import Foundation

enum RenditionPlan {
  /// Poll this soon when the server gave no Retry-After.
  static let DEFAULT_POLL: TimeInterval = 5
  /// Never poll more often than this, whatever the server says.
  static let MIN_POLL: TimeInterval = 2
  /// Free space a download must leave (decision 8).
  static let HEADROOM_BYTES: Int64 = 200 * 1_000_000
  /// About 22 MB per audio hour: the estimate for a file whose size is not known yet.
  static let BYTES_PER_SECOND: Double = 22_000_000 / 3600

  /// What a renditions answer asks for.
  enum Action: Equatable {
    /// Every file is ready.
    case done
    /// Some are still being made: ask again after this long.
    case poll(after: TimeInterval)
    /// A file is `missing` (the server's queue may have been full): prepare again (POST).
    case prepareAgain(after: TimeInterval)
    /// A file can't be made now; tried again by the server after `retryAfter` when known.
    case failed(retryAfter: TimeInterval?)
  }

  struct Step: Equatable {
    /// The files ready to download now (in the answer's order).
    var ready: [RenditionFile]
    var action: Action
  }

  /// The step after a renditions answer. A failed file fails the book (its rendition was
  /// refused or the encode failed); the files already ready still download.
  static func step(_ answer: RenditionsAnswer) -> Step {
    let ready = answer.files.filter { $0.state == "ready" }
    let failed = answer.files.filter { $0.state == "failed" }
    if !failed.isEmpty {
      return Step(ready: ready, action: .failed(retryAfter: failed.compactMap(\.retryAfterSeconds).max()))
    }
    if answer.files.isEmpty || ready.count == answer.files.count { return Step(ready: ready, action: .done) }
    if answer.files.contains(where: { $0.state == "missing" }) {
      return Step(ready: ready, action: .prepareAgain(after: DEFAULT_POLL))
    }
    return Step(ready: ready, action: .poll(after: DEFAULT_POLL))
  }

  /// What a refused renditions request or download asks for.
  enum Refusal: Equatable {
    /// Still being made (503 `rendition_pending`) or a passing failure (503 `rendition_error`,
    /// 5xx): ask again after this long.
    case retry(after: TimeInterval)
    /// The file can't be encoded (422 `rendition_failed`).
    case failed(retryAfter: TimeInterval?)
    /// This server makes no renditions now (404 `rendition_unavailable`, 400 `bad_rendition`).
    case unavailable
    /// The sign-in is gone (401): sign in again from the phone.
    case signedOut
    /// The book or file is gone (404), or no access (403).
    case gone
  }

  /// What a book's row says after a refusal; nil for `retry`, which waits instead.
  static func message(_ r: Refusal) -> String? {
    switch r {
    case .retry: return nil
    case .failed: return "A file of this book can't be made for the watch."
    case .unavailable: return "This server can't make books for the watch now."
    case .signedOut: return "Signed out. Set up the watch again from your iPhone."
    case .gone: return "This book is no longer on the server."
    }
  }

  static func refusal(_ e: APIError) -> Refusal {
    let retry = max(MIN_POLL, e.retryAfter ?? DEFAULT_POLL)
    switch (e.status, e.code) {
    case (422, _): return .failed(retryAfter: e.retryAfter)
    case (401, _): return .signedOut
    case (_, "rendition_unavailable"), (_, "bad_rendition"): return .unavailable
    case (403, _), (404, _): return .gone
    case (500..., _), (429, _), (408, _): return .retry(after: retry)
    default: return .failed(retryAfter: nil)
    }
  }

  /// A download task's HTTP status as an outcome: a background task that got a 503 or 422
  /// still "finishes" (its body is the JSON error), so the status is checked, never assumed.
  static func downloadSucceeded(status: Int) -> Bool { status == 200 || status == 206 }

  /// The bytes a book's rendition needs: each file's `bytes` when known, else estimated from
  /// its audio duration (`durations` by path).
  static func neededBytes(_ files: [RenditionFile], durations: [String: Double]) -> Int64 {
    files.reduce(Int64(0)) { sum, f in
      if let b = f.bytes, b > 0 { return sum + b }
      let d = durations[f.path] ?? 0
      return sum + Int64((d > 0 ? d : 0) * BYTES_PER_SECOND)
    }
  }

  /// Whether `free` bytes hold `needed` plus the headroom.
  static func fits(needed: Int64, free: Int64) -> Bool {
    free >= needed + HEADROOM_BYTES
  }
}
