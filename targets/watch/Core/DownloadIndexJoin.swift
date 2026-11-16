// The download index read late (DownloadManager `reload`: before the watch's first unlock, or a
// damaged one that could not be moved aside yet) joins the books queued while it was unread. Pure,
// so the rule has vectors; the manager removes the files of what it drops.
import Foundation

enum DownloadIndexJoin {
  /// `kept`: the books the index holds; `since`: those queued meanwhile, in memory. Each book once,
  /// the index's copy first. `forgotten`: every book was removed meanwhile (`removeAll`, the
  /// account was left): the index's books are the account that left's, so they are dropped (their
  /// files go too), never joined under the account signed in now (fe#323). `dropped` is what the
  /// index held that is not kept.
  static func join<R: Identifiable>(kept: [R], since: [R], forgotten: Bool) -> (records: [R], dropped: [R]) {
    if forgotten { return (since, kept) }
    let have = Set(kept.map(\.id))
    return (kept + since.filter { !have.contains($0.id) }, [])
  }
}
