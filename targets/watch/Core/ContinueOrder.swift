// Continue listening's rule, from the phone's `isInProgress` (progress-view.ts) and Home's
// order (home-model.ts): the books started and not finished, newest `updated_at` first.
import Foundation

enum ContinueOrder {
  static func inProgress(_ all: [ProgressRow], limit: Int) -> [ProgressRow] {
    let started = all.filter { !$0.finished && $0.position > 0 }
    let timed = started.map { (row: $0, time: ISOTime.parse($0.updatedAt)?.timeIntervalSince1970 ?? 0) }
    return timed.sorted { $0.time > $1.time }.prefix(limit).map(\.row)
  }
}
