#if canImport(CarPlay)
import CarPlay
import UIKit

/// The CarPlay scene (Phase 6). Named in Info.plist's scene manifest by
/// `plugins/withCarPlay.js`, hence the stable @objc name. iOS connects it only when the app is
/// signed with `com.apple.developer.carplay-audio` (opt-in at prebuild, `AUDIOSILO_CARPLAY=1`).
///
/// A CarPlay-first launch (the app not running, possibly with the phone locked) starts React
/// Native into a parking window (`AudiosiloScenes.ensureStarted`), so JS can write a fresh
/// snapshot and start books; until then the car shows the last snapshot from disk.
@objc(AudiosiloCarPlaySceneDelegate)
public final class AudiosiloCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  private var controller: AudiosiloCarPlayController?

  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    AudiosiloScenes.ensureStarted()
    let controller = AudiosiloCarPlayController(interfaceController: interfaceController)
    self.controller = controller
    controller.start()
    AudiosiloCarEvents.shared.send("onCarConnection", ["connected": true])
  }

  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    controller?.stop()
    controller = nil
    AudiosiloCarEvents.shared.send("onCarConnection", ["connected": false])
  }
}

/// Builds and refreshes the CarPlay templates: a tab bar of the snapshot's lists, and the
/// shared Now Playing template with a chapter list (Up Next), the rate button and a bookmark
/// button. Main thread (CarPlay's rule).
@MainActor
final class AudiosiloCarPlayController: NSObject, @preconcurrency CPNowPlayingTemplateObserver {
  private let interfaceController: CPInterfaceController
  private var tabBar: CPTabBarTemplate?
  /// (id, title) of each tab shown, to tell an in-place refresh from a new set of tabs.
  private var shownTabs: [(id: String, title: String)] = []
  private var listTemplates: [CPListTemplate] = []
  /// Items currently shown, by car item id (one book can be in several tabs).
  private var itemsById: [String: [CPListItem]] = [:]
  private var chapterList: CPListTemplate?
  private var bookmarkFilled = false
  private var bookmarkGeneration = 0
  /// A tapped book waiting for JS to start it: its spinner runs until the engine reports the
  /// book (or 10 s pass).
  private var pendingTap: (id: String, completion: () -> Void, generation: Int)?
  private var tapGeneration = 0
  /// Last player state the templates reflect, so a notification that changed nothing visible
  /// does not rebuild anything.
  private var shownPlaying: (id: String?, playing: Bool) = (nil, false)
  private var shownChapter: (count: Int, index: Int?) = (0, nil)
  private let covers = NSCache<NSString, UIImage>()
  private let coverQueue = DispatchQueue(label: "audiosilo.car-covers", qos: .userInitiated)

  /// The bookmark button's fill lasts this long after a press.
  private static let bookmarkFeedback: TimeInterval = 2
  /// A tapped book's spinner gives up after this long (JS never started it).
  private static let tapTimeout: TimeInterval = 10
  /// The rates CarPlay's rate button cycles through: the list the engine registers as
  /// `changePlaybackRateCommand.supportedPlaybackRates`.
  private static let rates: [Double] = AudioEngine.supportedRates.map(\.doubleValue)

  init(interfaceController: CPInterfaceController) {
    self.interfaceController = interfaceController
    super.init()
  }

  private var player: CarPlayPlayerAccess? { CarPlayPlayer.current }
  private var snapshot: CarSnapshot? { AudiosiloCarSnapshotStore.shared.snapshot }

  func start() {
    AudiosiloCarSnapshotStore.shared.loadIfNeeded()
    let nc = NotificationCenter.default
    nc.addObserver(self, selector: #selector(snapshotChanged),
                   name: AudiosiloCarSnapshotStore.didChange, object: nil)
    nc.addObserver(self, selector: #selector(playerChanged),
                   name: .audiosiloPlayerDidChange, object: nil)
    CPNowPlayingTemplate.shared.add(self)
    rememberPlayerState()
    rebuildLists()
    configureNowPlaying()
  }

  func stop() {
    NotificationCenter.default.removeObserver(self)
    CPNowPlayingTemplate.shared.remove(self)
    finishTap(push: false)
  }

  // MARK: Lists

  @objc private func snapshotChanged() {
    rebuildLists()
    configureNowPlaying() // labels (the chapters title) may have changed
  }

  private func rebuildLists() {
    let (tabs, templates) = makeListTemplates()
    if tabBar != nil, tabs.map({ $0.id }) == shownTabs.map({ $0.id }),
       tabs.map({ $0.title }) == shownTabs.map({ $0.title }) {
      // Same tabs: refresh in place so the car keeps the selected tab and scroll position.
      for (old, new) in zip(listTemplates, templates) {
        old.updateSections(new.sections)
        old.emptyViewTitleVariants = new.emptyViewTitleVariants
      }
    } else if let tabBar = tabBar {
      listTemplates = templates
      tabBar.updateTemplates(templates)
    } else {
      listTemplates = templates
      let bar = CPTabBarTemplate(templates: templates)
      tabBar = bar
      interfaceController.setRootTemplate(bar, animated: false, completion: nil)
    }
    shownTabs = tabs
  }

  /// One list per snapshot tab (capped at the car's tab and item limits). Before any snapshot,
  /// or signed out, a single list whose empty text is the snapshot's own label (never "use your
  /// phone": Apple's CarPlay guideline). Rebuilding `itemsById` here is safe: the in-place
  /// refresh moves the new items into the shown templates.
  private func makeListTemplates() -> ([(id: String, title: String)], [CPListTemplate]) {
    itemsById = [:]
    guard let snap = snapshot else {
      let empty = CPListTemplate(title: "AudioSilo", sections: [])
      empty.tabTitle = "AudioSilo"
      empty.tabImage = UIImage(systemName: "books.vertical")
      return ([(id: "none", title: "AudioSilo")], [empty])
    }
    let tabs = snap.signedIn ? Array(snap.tabs.prefix(CPTabBarTemplate.maximumTabCount)) : []
    if tabs.isEmpty {
      let title = snap.labels.continue ?? "AudioSilo"
      let list = CPListTemplate(title: title, sections: [])
      list.tabTitle = title
      list.tabImage = UIImage(systemName: "play.circle")
      let text = snap.signedIn ? snap.labels.empty : snap.labels.signedOut
      list.emptyViewTitleVariants = [text ?? ""]
      return ([(id: snap.signedIn ? "empty" : "signedOut", title: title)], [list])
    }
    let maxItems = CPListTemplate.maximumItemCount
    let templates = tabs.map { tab -> CPListTemplate in
      let items = tab.items.prefix(maxItems).map(makeItem)
      let list = CPListTemplate(title: tab.title, sections: [CPListSection(items: items)])
      list.tabTitle = tab.title
      list.tabImage = UIImage(systemName: Self.tabSymbol(tab.id))
      list.emptyViewTitleVariants = [snap.labels.empty ?? ""]
      return list
    }
    return (tabs.map { (id: $0.id, title: $0.title) }, templates)
  }

  private static func tabSymbol(_ id: String) -> String {
    switch id {
    case "continue": return "play.circle"
    case "upnext": return "text.line.first.and.arrowtriangle.forward"
    case "downloads": return "arrow.down.circle"
    default: return "books.vertical"
    }
  }

  private func makeItem(_ book: CarSnapshot.Item) -> CPListItem {
    let item = CPListItem(text: book.title, detailText: book.subtitle,
                          image: cover(book.artwork) ?? Self.placeholder)
    item.userInfo = book.id
    item.playbackProgress = CGFloat(book.finished == true ? 1 : min(1, max(0, book.progress ?? 0)))
    item.playingIndicatorLocation = .trailing
    item.isPlaying = book.id == shownPlaying.id && shownPlaying.playing
    item.handler = { [weak self] _, completion in
      self?.tapped(book.id, completion: completion)
    }
    itemsById[book.id, default: []].append(item)
    if cover(book.artwork) == nil, let path = book.artwork {
      loadCover(path, into: item)
    }
    return item
  }

  // MARK: Covers

  private static let placeholder = UIImage(systemName: "book.closed")

  private func cover(_ path: String?) -> UIImage? {
    guard let path = path else { return nil }
    return covers.object(forKey: path as NSString)
  }

  /// Decode + scale the snapshot's JPEG off the main thread (a tab can hold 50 books), then set
  /// it on the item. Covers are files the app wrote (`file://` URIs); nothing is fetched.
  private func loadCover(_ path: String, into item: CPListItem) {
    let size = CPListItem.maximumImageSize
    let scale = interfaceController.carTraitCollection.displayScale
    coverQueue.async { [weak self] in
      guard let url = URL(string: path), url.isFileURL,
            let source = UIImage(contentsOfFile: url.path) else { return }
      let format = UIGraphicsImageRendererFormat()
      format.scale = scale > 0 ? scale : 2
      let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
        source.draw(in: Self.aspectFill(source.size, in: size))
      }
      DispatchQueue.main.async {
        guard let self = self else { return }
        self.covers.setObject(image, forKey: path as NSString)
        item.setImage(image)
      }
    }
  }

  private nonisolated static func aspectFill(_ image: CGSize, in box: CGSize) -> CGRect {
    guard image.width > 0, image.height > 0 else { return CGRect(origin: .zero, size: box) }
    let s = max(box.width / image.width, box.height / image.height)
    let w = image.width * s
    let h = image.height * s
    return CGRect(x: (box.width - w) / 2, y: (box.height - h) / 2, width: w, height: h)
  }

  // MARK: Starting a book

  /// iOS always lets JS start a book (`onCarPlayRequest`): JS has the session, the saved place
  /// and the queue rules. The item's spinner runs until the engine has the book, then Now
  /// Playing is pushed. After 10 s the spinner stops and the list stays (nothing is playing,
  /// so an empty Now Playing would only mislead).
  private func tapped(_ id: String, completion: @escaping () -> Void) {
    finishTap(push: false)
    if let p = player, p.loadedBookId == id {
      // Already the loaded book: JS resumes it; show Now Playing at once.
      AudiosiloCarEvents.shared.send("onCarPlayRequest", ["id": id])
      completion()
      pushNowPlaying()
      return
    }
    tapGeneration += 1
    let generation = tapGeneration
    pendingTap = (id: id, completion: completion, generation: generation)
    AudiosiloCarEvents.shared.send("onCarPlayRequest", ["id": id])
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.tapTimeout) { [weak self] in
      guard let self = self, self.pendingTap?.generation == generation else { return }
      self.finishTap(push: false)
    }
  }

  private func finishTap(push: Bool) {
    guard let tap = pendingTap else { return }
    pendingTap = nil
    tap.completion()
    if push { pushNowPlaying() }
  }

  private func pushNowPlaying() {
    let nowPlaying = CPNowPlayingTemplate.shared
    if interfaceController.topTemplate === nowPlaying { return }
    if interfaceController.templates.contains(where: { $0 === nowPlaying }) {
      interfaceController.pop(to: nowPlaying, animated: true, completion: nil)
    } else {
      interfaceController.pushTemplate(nowPlaying, animated: true, completion: nil)
    }
  }

  // MARK: Player changes

  @objc private func playerChanged() {
    if let tap = pendingTap, let p = player, p.hasLoadedBook,
       p.loadedBookId == tap.id || (p.loadedBookId == nil && p.isPlaying) {
      finishTap(push: true)
    }
    let before = (shownPlaying, shownChapter)
    rememberPlayerState()
    if before.0.id != shownPlaying.id || before.0.playing != shownPlaying.playing {
      for (id, items) in itemsById {
        let playing = id == shownPlaying.id && shownPlaying.playing
        items.forEach { $0.isPlaying = playing }
      }
    }
    if before.1.count != shownChapter.count || before.1.index != shownChapter.index {
      configureNowPlaying()
      refreshChapterList()
    }
  }

  private func rememberPlayerState() {
    let p = player
    shownPlaying = (p?.loadedBookId, p?.isPlaying ?? false)
    shownChapter = (p?.chapterTitles.count ?? 0, p?.currentChapterIndex)
  }

  // MARK: Now Playing

  private func configureNowPlaying() {
    let nowPlaying = CPNowPlayingTemplate.shared
    nowPlaying.upNextTitle = snapshot?.labels.chapters ?? ""
    nowPlaying.isUpNextButtonEnabled = (player?.chapterTitles.count ?? 0) >= 2
    nowPlaying.isAlbumArtistButtonEnabled = false
    updateNowPlayingButtons()
  }

  private func updateNowPlayingButtons() {
    let rate = CPNowPlayingPlaybackRateButton { [weak self] _ in self?.cycleRate() }
    let symbol = bookmarkFilled ? "bookmark.fill" : "bookmark"
    var buttons: [CPNowPlayingButton] = [rate]
    if let image = UIImage(systemName: symbol) {
      buttons.append(CPNowPlayingImageButton(image: image) { [weak self] _ in self?.bookmark() })
    }
    CPNowPlayingTemplate.shared.updateNowPlayingButtons(buttons)
  }

  /// CarPlay's rate button only reports the tap; the app picks the next rate (Apple: use the
  /// same rate cycling as the `changePlaybackRateCommand`). The engine applies it and tells JS.
  private func cycleRate() {
    guard let p = player else { return }
    let next = Self.rates.first { $0 > p.rate + 0.01 } ?? Self.rates[0]
    p.setRateFromRemote(next)
  }

  /// The press is the feedback the car can give: `bookmark.fill` for ~2 s.
  private func bookmark() {
    guard let p = player, p.hasLoadedBook else { return }
    p.emitRemoteBookmark()
    bookmarkFilled = true
    bookmarkGeneration += 1
    let generation = bookmarkGeneration
    updateNowPlayingButtons()
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.bookmarkFeedback) { [weak self] in
      guard let self = self, self.bookmarkGeneration == generation else { return }
      self.bookmarkFilled = false
      self.updateNowPlayingButtons()
    }
  }

  func nowPlayingTemplateUpNextButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
    pushChapters()
  }

  func nowPlayingTemplateAlbumArtistButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {}

  // MARK: Chapters

  private func pushChapters() {
    guard let list = makeChapterList() else { return }
    chapterList = list
    interfaceController.pushTemplate(list, animated: true, completion: nil)
  }

  private func refreshChapterList() {
    guard let shown = chapterList else { return }
    guard interfaceController.templates.contains(where: { $0 === shown }) else {
      chapterList = nil
      return
    }
    if let fresh = makeChapterList() { shown.updateSections(fresh.sections) }
  }

  /// The loaded book's chapters, windowed around the current one to the car's item limit (a
  /// long book has hundreds). A pick seeks natively; the engine reports it as a remote move.
  private func makeChapterList() -> CPListTemplate? {
    guard let p = player else { return nil }
    let titles = p.chapterTitles
    guard titles.count >= 2 else { return nil }
    let current = p.currentChapterIndex ?? 0
    let limit = max(1, CPListTemplate.maximumItemCount)
    let start = max(0, min(current - limit / 2, titles.count - limit))
    let end = min(titles.count, start + limit)
    let items = (start..<end).map { index -> CPListItem in
      let title = titles[index].isEmpty ? String(index + 1) : titles[index]
      let item = CPListItem(text: title, detailText: nil)
      item.isPlaying = index == current
      item.playingIndicatorLocation = .trailing
      item.handler = { [weak self] _, completion in
        guard let self = self else { completion(); return }
        self.player?.seekToChapter(index)
        completion()
        self.interfaceController.popTemplate(animated: true, completion: nil)
      }
      return item
    }
    return CPListTemplate(title: snapshot?.labels.chapters ?? "", sections: [CPListSection(items: items)])
  }
}
#endif
