// Continue listening's rule, from the phone's `isInProgress` (progress-view.ts) and Home's
// order (home-model.ts): the books started and not finished, newest `updated_at` first.
import Foundation

enum ContinueOrder {
  static func inProgress(_ all: [ProgressRow], limit: Int) -> [ProgressRow] {
    let time = { (r: ProgressRow) in ISOTime.parse(r.updatedAt)?.timeIntervalSince1970 ?? 0 }
    return Array(all.filter { !$0.finished && $0.position > 0 }.sorted { time($0) > time($1) }.prefix(limit))
  }
}
