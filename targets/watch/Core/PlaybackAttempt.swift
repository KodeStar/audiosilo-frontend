// A playback deadline belongs to the attempt that armed it. Pausing, resuming or replacing
// the queue invalidates its callbacks, even when the queue still holds the same first item.
import Foundation

struct PlaybackAttempt {
  private(set) var generation = 0

  @discardableResult
  mutating func advance() -> Int {
    generation += 1
    return generation
  }

  func accepts(_ token: Int) -> Bool { token == generation }

  func timedOut(_ token: Int, settling: Bool, playing: Bool) -> Bool {
    accepts(token) && settling && playing
  }
}

enum PlaybackFailure {
  case audioStart, settling, damagedDownload

  var message: String {
    switch self {
    case .audioStart: return "The watch could not start its audio. Play again."
    case .settling: return "This book did not start playing. Play again."
    case .damagedDownload: return "This download can't be read. Remove it from the watch and download it again."
    }
  }

  /// A player item's failure. Only a file that is gone, or whose audio cannot be parsed or
  /// decoded, is a damaged download (another Play fails the same way); other player and session
  /// failures can be temporary and keep the book for another Play. AVFoundation often wraps the
  /// cause, so the underlying error is read too.
  static func ofItemError(_ error: Error?) -> PlaybackFailure {
    var next = error.map { $0 as NSError }
    var depth = 0
    while let e = next, depth < 4 {
      if damaged(domain: e.domain, code: e.code) { return .damagedDownload }
      next = e.userInfo[NSUnderlyingErrorKey] as? NSError
      depth += 1
    }
    return .audioStart
  }

  private static func damaged(domain: String, code: Int) -> Bool {
    switch domain {
    // fileFormatNotRecognized, fileFailedToParse, decodeFailed.
    case "AVFoundationErrorDomain": return [-11828, -11829, -11821].contains(code)
    case NSURLErrorDomain: return code == NSURLErrorFileDoesNotExist
    case NSCocoaErrorDomain: return code == NSFileReadNoSuchFileError || code == NSFileNoSuchFileError
    case NSPOSIXErrorDomain: return code == Int(ENOENT)
    default: return false
    }
  }
}
