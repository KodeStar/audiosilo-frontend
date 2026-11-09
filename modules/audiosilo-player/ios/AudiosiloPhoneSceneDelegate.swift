import UIKit

/// The phone (and iPad) window scene. Named in Info.plist's scene manifest by
/// `plugins/withCarPlay.js`, hence the stable @objc name.
///
/// Under the UIScene life cycle UIKit stops calling the app delegate's URL, user-activity,
/// quick-action and life-cycle methods, and delivers a cold-start link in the scene's
/// `connectionOptions` instead of the launch options. Every Expo subscriber (expo-linking,
/// expo-router) still listens on the app delegate, so this delegate re-feeds those events to it,
/// as Expo SDK 58's `ExpoAppSceneDelegate` does for its own scene (which this app replaces: see
/// withCarPlay.js). React Native's `url` event is another matter: since 0.88 `RCTLinkingManager`'s
/// app-delegate methods do nothing in an app with a scene manifest (`RCTIsSceneDelegateApp`), so
/// a link is also handed to its scene API (`notifyLinking`), as Expo's delegate does. Without
/// that, a link opened while the app runs (a pairing link, a widget, the Live Activity) never
/// reaches JS.
@objc(AudiosiloPhoneSceneDelegate)
public final class AudiosiloPhoneSceneDelegate: UIResponder, UIWindowSceneDelegate {
  public var window: UIWindow?

  public func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: windowScene)
    self.window = window

    // `Linking.getInitialURL()` reads only the launch options, and the `url` event sent below
    // fires before JS listens, so a pairing link that cold-starts the app would reach no one
    // without these rebuilt launch options.
    let browsingWeb = connectionOptions.userActivities.first {
      $0.activityType == NSUserActivityTypeBrowsingWeb
    }
    AudiosiloScenes.attachPhoneWindow(
      window,
      launchOptions: Self.launchOptions(
        url: connectionOptions.urlContexts.first?.url,
        userActivity: browsingWeb))

    // After the start, as UIKit did with the app delegate: expo-linking records the initial URL
    // here (expo-router reads it first), and a running JS (a CarPlay-first launch) gets the event.
    connectionOptions.urlContexts.forEach { Self.forwardOpen($0, in: scene) }
    connectionOptions.userActivities.forEach { Self.forwardContinue($0, in: scene) }
    if let item = connectionOptions.shortcutItem {
      Self.forwardShortcut(item) { _ in }
    }
  }

  public func sceneDidDisconnect(_ scene: UIScene) {
    AudiosiloScenes.detachPhoneWindow(window)
    window = nil
  }

  public func sceneDidBecomeActive(_ scene: UIScene) {
    let app = UIApplication.shared
    app.delegate?.applicationDidBecomeActive?(app)
  }

  public func sceneWillResignActive(_ scene: UIScene) {
    let app = UIApplication.shared
    app.delegate?.applicationWillResignActive?(app)
  }

  public func sceneWillEnterForeground(_ scene: UIScene) {
    let app = UIApplication.shared
    app.delegate?.applicationWillEnterForeground?(app)
  }

  public func sceneDidEnterBackground(_ scene: UIScene) {
    let app = UIApplication.shared
    app.delegate?.applicationDidEnterBackground?(app)
  }

  public func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    URLContexts.forEach { Self.forwardOpen($0, in: scene) }
  }

  public func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    Self.forwardContinue(userActivity, in: scene)
  }

  public func scene(_ scene: UIScene, didUpdate userActivity: NSUserActivity) {
    let app = UIApplication.shared
    app.delegate?.application?(app, didUpdate: userActivity)
  }

  public func windowScene(
    _ windowScene: UIWindowScene,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    Self.forwardShortcut(shortcutItem, completionHandler: completionHandler)
  }

  // MARK: Forwarding

  /// Launch options as React Native's `getInitialURL` reads them. Built from the constant
  /// strings, not `UIApplication.LaunchOptionsKey.url` / `.userActivityDictionary` (deprecated
  /// in iOS 26 in favour of the scene APIs; RN still reads these exact keys). Nil when the
  /// launch carried neither, like a plain launch's options.
  static func launchOptions(
    url: URL?,
    userActivity: NSUserActivity?
  ) -> [UIApplication.LaunchOptionsKey: Any]? {
    var options: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url = url {
      options[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey")] = url
    }
    if let activity = userActivity {
      options[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey")] = [
        "UIApplicationLaunchOptionsUserActivityTypeKey": activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity,
      ]
    }
    return options.isEmpty ? nil : options
  }

  private static func forwardOpen(_ context: UIOpenURLContext, in scene: UIScene) {
    let app = UIApplication.shared
    var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    if let source = context.options.sourceApplication { options[.sourceApplication] = source }
    if let annotation = context.options.annotation { options[.annotation] = annotation }
    options[.openInPlace] = context.options.openInPlace
    let announced = LinkAnnouncement(context.url)
    _ = app.delegate?.application?(app, open: context.url, options: options)
    // One context per call: React Native reads only the first of the set.
    if !announced.seen { notifyLinking("scene:openURLContexts:", scene, Set([context])) }
  }

  private static func forwardContinue(_ activity: NSUserActivity, in scene: UIScene) {
    let app = UIApplication.shared
    let announced = activity.webpageURL.map { LinkAnnouncement($0) }
    _ = app.delegate?.application?(app, continue: activity, restorationHandler: { _ in })
    if announced?.seen != true { notifyLinking("scene:continueUserActivity:", scene, activity) }
  }

  /// `RCTLinkingManager`'s scene API (a class method taking the scene and `argument`), which
  /// sends JS its `url` event. Looked up at run time, as this module does not import React; a
  /// React Native without it leaves the link to the app delegate alone.
  private static func notifyLinking(_ selector: String, _ scene: UIScene, _ argument: Any) {
    let sel = NSSelectorFromString(selector)
    guard let manager = NSClassFromString("RCTLinkingManager") as? NSObject.Type,
      manager.responds(to: sel)
    else { return }
    _ = manager.perform(sel, with: scene, with: argument)
  }

  private static func forwardShortcut(
    _ item: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    let app = UIApplication.shared
    guard let perform = app.delegate?.application(_:performActionFor:completionHandler:) else {
      completionHandler(false)
      return
    }
    perform(app, item, completionHandler)
  }
}

/// Whether React Native already announced `url` (its `RCTOpenURLNotification`) while this lives:
/// an app delegate subscriber that posts the link itself (expo-router's, for a Handoff `href`)
/// must not have JS hear it twice. The same guard as Expo's `SceneEventForwarder`.
private final class LinkAnnouncement: NSObject {
  private let url: String
  private(set) var seen = false

  init(_ url: URL) {
    self.url = url.absoluteString
    super.init()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(announced(_:)),
      name: Notification.Name("RCTOpenURLNotification"),
      object: nil)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  @objc private func announced(_ notification: Notification) {
    seen = seen || notification.userInfo?["url"] as? String == url
  }
}
