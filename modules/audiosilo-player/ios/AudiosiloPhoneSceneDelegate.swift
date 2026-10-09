import UIKit

/// The phone (and iPad) window scene. Named in Info.plist's scene manifest by
/// `plugins/withCarPlay.js`, hence the stable @objc name.
///
/// Under the UIScene life cycle UIKit stops calling the app delegate's URL, user-activity,
/// quick-action and life-cycle methods, and delivers a cold-start link in the scene's
/// `connectionOptions` instead of the launch options. Every Expo subscriber (expo-linking,
/// expo-router) and React Native's `RCTLinkingManager` still listen on the app delegate, so this
/// delegate re-feeds those events to it, the way expo 57.0.23's `ExpoAppSceneDelegate` does.
/// The SDK 56 AppDelegate's `open url` / `continue userActivity` overrides call
/// `RCTLinkingManager` themselves (withCarPlay.js fails the prebuild if they stop doing so).
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
    connectionOptions.urlContexts.forEach { Self.forwardOpen($0) }
    connectionOptions.userActivities.forEach { Self.forwardContinue($0) }
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
    URLContexts.forEach { Self.forwardOpen($0) }
  }

  public func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    Self.forwardContinue(userActivity)
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

  private static func forwardOpen(_ context: UIOpenURLContext) {
    let app = UIApplication.shared
    var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    if let source = context.options.sourceApplication { options[.sourceApplication] = source }
    if let annotation = context.options.annotation { options[.annotation] = annotation }
    options[.openInPlace] = context.options.openInPlace
    _ = app.delegate?.application?(app, open: context.url, options: options)
  }

  private static func forwardContinue(_ activity: NSUserActivity) {
    let app = UIApplication.shared
    _ = app.delegate?.application?(app, continue: activity, restorationHandler: { _ in })
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
