// Continue listening on the watch (decision 7: no library browsing in v1): `GET /me/progress`,
// the books started and not finished, newest first (the phone's `isInProgress` and Home's
// order), at most 10. The rows carry no titles, so each book's `/item` is read once and kept
// (items/, also what offline playback needs). The rows also keep each book's server place for
// a downloaded book to open at when the pull before play gets no answer (`keptPlace`).
import Foundation

struct ContinueRow: Codable, Equatable, Identifiable {
  var ref: BookRef
  var title: String
  var author: String?
  var position: Double
  var duration: Double
  var updatedAt: String
  /// The row's version and the device that wrote it, so the kept place follows Resume.plan's rule.
  var version: Int?
  var deviceId: String?
  /// The book's own speed, for the same offline first play.
  var playbackSpeed: Double?

  var id: String { ref.key }
  var fraction: Double { duration > 0 ? min(1, position / duration) : 0 }
}

@MainActor
final class ContinueListening: ObservableObject {
  static let LIMIT = 10

  @Published private(set) var rows: [ContinueRow]
  @Published private(set) var loading = false
  /// Why the last refresh failed ("" when it did not).
  @Published private(set) var problem = ""

  private let file = JSONFile<[ContinueRow]>(url: Files.continueRows)
  /// Bumped by each refresh and by `clear`: an answer an older one was waiting for (an account
  /// since signed out or replaced, or just an older read) is dropped.
  private var generation = 0

  init() { rows = file.read() ?? [] }

  func refresh(_ api: APIClient) async {
    generation += 1
    let mine = generation
    loading = true
    defer { if mine == generation { loading = false } }
    do {
      let all = try await api.allProgress()
      var next: [ContinueRow] = []
      for p in ContinueOrder.inProgress(all, limit: Self.LIMIT) {
        guard mine == generation else { return }
        var book = ItemCache.load(p.ref)?.book
        if book == nil, let fetched = try? await api.item(p.ref) {
          guard mine == generation else { return }
          ItemCache(book: fetched, chapters: nil).save(p.ref)
          book = fetched
        }
        next.append(ContinueRow(ref: p.ref, title: book?.title ?? (p.path as NSString).lastPathComponent,
                                author: book?.author, position: p.position,
                                duration: p.duration > 0 ? p.duration : (book?.duration ?? 0), updatedAt: p.updatedAt,
                                version: p.version, deviceId: p.deviceId, playbackSpeed: p.playbackSpeed))
      }
      guard mine == generation else { return }
      rows = next
      problem = ""
      file.write(next)
    } catch let e as APIError where e.status == 401 {
      guard mine == generation else { return }
      problem = RenditionPlan.message(.signedOut) ?? ""
    } catch {
      guard mine == generation else { return }
      problem = "Can't reach your server."
    }
  }

  /// The server's place for `ref` as the last refresh read it, for a downloaded book whose pull
  /// before play got no answer: offline it opens there, never at 0 under the server's place (the
  /// phone's keepServerPlace). A newer place of the watch's own still wins (Resume.plan).
  func keptPlace(_ ref: BookRef) -> ProgressRow? {
    rows.first { $0.ref == ref }.map { r in
      ProgressRow(libraryId: r.ref.libraryId, path: r.ref.path, position: r.position, duration: r.duration, finished: false,
                  playbackSpeed: r.playbackSpeed, version: r.version ?? 0, deviceId: r.deviceId, updatedAt: r.updatedAt)
    }
  }

  func clear() {
    generation += 1
    loading = false
    rows = []
    problem = ""
    file.write(nil)
  }
}
