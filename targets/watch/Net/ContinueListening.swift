// Continue listening on the watch (decision 7: no library browsing in v1): `GET /me/progress`,
// the books started and not finished, newest first (the phone's `isInProgress` and Home's
// order), at most 10. The rows carry no titles, so each book's `/item` is read once and kept
// (items/, also what offline playback needs).
import Foundation

struct ContinueRow: Codable, Equatable, Identifiable {
  var ref: BookRef
  var title: String
  var author: String?
  var position: Double
  var duration: Double
  var updatedAt: String

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

  private let file = JSONFile<[ContinueRow]>(url: Files.root.appendingPathComponent("continue.json"))

  init() { rows = file.read() ?? [] }

  func refresh(_ api: APIClient) async {
    loading = true
    defer { loading = false }
    do {
      let picked = ContinueOrder.inProgress(try await api.allProgress(), limit: Self.LIMIT)
      var next: [ContinueRow] = []
      for p in picked {
        let cacheFile = JSONFile<ItemCache>(url: Files.item(p.ref))
        var book = cacheFile.read()?.book
        if book == nil, let fetched = try? await api.item(p.ref) {
          cacheFile.write(ItemCache(book: fetched, chapters: nil))
          book = fetched
        }
        next.append(ContinueRow(ref: p.ref, title: book?.title ?? (p.path as NSString).lastPathComponent,
                                author: book?.author, position: p.position,
                                duration: p.duration > 0 ? p.duration : (book?.duration ?? 0), updatedAt: p.updatedAt))
      }
      rows = next
      problem = ""
      file.write(next)
    } catch let e as APIError where e.status == 401 {
      problem = "Signed out. Set up the watch again from your iPhone."
    } catch {
      problem = "Can't reach your server."
    }
  }

  func clear() {
    rows = []
    problem = ""
    file.write(nil)
  }
}
