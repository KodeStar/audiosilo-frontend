// How far the server's clock is ahead of the watch's (`clockSkewOf` in listening-outbox.ts).
// A foreground send carries `sent_at` (the watch's clock at that attempt) and the server
// corrects by it; a body built earlier (the background upload, decision 10) would carry a stale
// `sent_at`, so it carries `clock_offset` instead: the last measured skew, in seconds.
import Foundation

enum ClockSkew {
  /// The largest offset the server takes (`catalog.MaxClockOffset`, 1e9 seconds).
  static let MAX_OFFSET_SECONDS: Double = 1e9

  /// Milliseconds the server's clock was ahead of the watch's, measured from an answer's
  /// `server_time` against the middle of the request; nil without a readable time.
  static func of(serverTime: String?, sentAt: Date, answeredAt: Date) -> Double? {
    guard let s = serverTime, let server = ISOTime.parse(s) else { return nil }
    let middle = (sentAt.timeIntervalSince1970 + answeredAt.timeIntervalSince1970) / 2
    return ((server.timeIntervalSince1970 - middle) * 1000).rounded()
  }

  /// A body's `clock_offset` (seconds, server minus device) from the last measured skew (0
  /// when none was), clamped to what the server takes.
  static func clockOffset(skewMs: Double?) -> Double {
    let seconds = (skewMs ?? 0) / 1000
    guard seconds.isFinite else { return 0 }
    return min(MAX_OFFSET_SECONDS, max(-MAX_OFFSET_SECONDS, seconds))
  }
}
