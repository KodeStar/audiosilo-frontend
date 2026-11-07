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
}
