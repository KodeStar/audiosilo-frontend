import Foundation

/// Where a cover the car snapshot names is on disk NOW.
///
/// The snapshot stores covers as absolute `file://` URIs (a downloaded book's own cover under
/// `Documents/downloads/`, or a car cover under `Documents/car-artwork/`). iOS moves the app's
/// data container to a new UUID on an app update or a reinstall from a backup, so the snapshot
/// still on disk from the last run names files under the OLD container: read as they are,
/// every book showed the placeholder until JS wrote a fresh snapshot (and never, when JS could
/// not run in the car). JS does the same for downloads (`engine.localUri` rebuilds the URI from
/// the live document root).
///
/// A file that can't be read is therefore looked up again under the current container: the
/// part of the path after `.../Containers/Data/Application/<UUID>/` is kept when it starts with
/// `Documents` or `Library`, and only a path that stays inside that folder of THIS app's
/// container is ever read (no `..`, nothing outside it). Anything else (a URL, a path in no app
/// container, an App Group path) resolves only as it is. Pure Foundation, so the host
/// self-check (SelfCheck/run.sh) covers it.
enum CarArtworkPath {
  /// What `read` makes of the file `uri` names (a `file://` URI from the snapshot), or nil.
  /// `read` is tried on the path as it is first, and only when that fails on the path re-rooted
  /// into `home`, the app's current container (`NSHomeDirectory()`): a cover in place costs one
  /// read, with no separate existence check.
  static func resolve<T>(_ uri: String, home: String, read: (String) -> T?) -> T? {
    guard let url = URL(string: uri), url.isFileURL else { return nil }
    let path = url.path
    guard !path.isEmpty else { return nil }
    if let value = read(path) { return value }
    guard let moved = reroot(path, home: home), moved != path else { return nil }
    return read(moved)
  }

  /// `path` moved from the app data container it names into `home`; nil when it names none,
  /// or what follows the container is not a file under `Documents/` or `Library/`, or holds a
  /// `.` or `..` component (which could leave that folder).
  static func reroot(_ path: String, home: String) -> String? {
    let parts = path.split(separator: "/").map(String.init)
    // The first `Containers/Data/Application/<UUID>` in the path is the app's container (on a
    // device and in the Simulator alike); a later one is inside it (a download's folders come
    // from the server's paths), so it never anchors the move.
    guard let uuid = parts.indices.dropFirst(3).first(where: { i in
      parts[i - 3] == "Containers" && parts[i - 2] == "Data" && parts[i - 1] == "Application"
        && UUID(uuidString: parts[i]) != nil
    }) else { return nil }
    let rest = parts[(uuid + 1)...]
    guard rest.count >= 2, let folder = rest.first, folder == "Documents" || folder == "Library",
          !rest.contains(where: { $0 == ".." || $0 == "." }) else { return nil }
    let root = home.hasSuffix("/") ? String(home.dropLast()) : home
    guard root.hasPrefix("/") else { return nil }
    return root + "/" + rest.joined(separator: "/")
  }
}
