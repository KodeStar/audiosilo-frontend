import UIKit

/// Starts React Native in whichever UIScene connects first (Phase 6, CarPlay).
///
/// Declaring a CarPlay scene moves the whole app onto the UIScene life cycle, where UIKit never
/// shows a window the app delegate made. `plugins/withCarPlay.js` therefore rewrites the Expo
/// template's AppDelegate: instead of creating a window and calling `startReactNative` in
/// `didFinishLaunching`, it hands us that call as a closure (`configure`), and:
///  - the phone scene (`AudiosiloPhoneSceneDelegate`) runs it into its own window, with launch
///    options rebuilt from the scene's connection options (the cold-start pairing link);
///  - a CarPlay-first launch (the car connects with the app not running, maybe with the phone
///    locked) runs it into an off-screen PARKING window, so JS boots and can answer the car; the
///    phone scene that connects later adopts that root view controller instead of starting a
///    second React surface. The same parking happens when the phone scene goes away while the
///    car keeps the process alive, so JS state survives a phone scene reconnect.
///
/// Main thread only (UIKit; every caller is a UIKit delegate callback).
@MainActor
public enum AudiosiloScenes {
  public typealias Starter = (UIWindow?, [UIApplication.LaunchOptionsKey: Any]?) -> Void

  private static var starter: Starter?
  private static var mirror: ((UIWindow?) -> Void)?
  private static var started = false
  /// Holds React Native's root view controller while no phone scene shows it.
  private static var parkingWindow: UIWindow?

  /// Called once from the AppDelegate's `didFinishLaunching` (written by withCarPlay.js).
  /// `start` is the template's `factory.startReactNative(...)`; `mirrorWindow` assigns the app
  /// delegate's `window`, which code outside the scene still reads (expo-system-ui).
  public static func configure(
    start: @escaping Starter,
    mirrorWindow: @escaping (UIWindow?) -> Void
  ) {
    starter = start
    mirror = mirrorWindow
    // Info.plist names the scene delegates by their @objc names; nothing else references them,
    // so keep their object files linked from a symbol the AppDelegate does reference.
    var sceneDelegates: [AnyClass] = [AudiosiloPhoneSceneDelegate.self]
#if canImport(CarPlay)
    sceneDelegates.append(AudiosiloCarPlaySceneDelegate.self)
#endif
    _ = sceneDelegates
  }

  /// The phone scene connected: start React Native into its window, or move the parked root
  /// view controller into it when the car already started it.
  static func attachPhoneWindow(
    _ window: UIWindow,
    launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) {
    mirror?(window)
    if !started {
      start(into: window, launchOptions: launchOptions)
      return
    }
    if let parked = parkingWindow, let root = parked.rootViewController {
      parked.rootViewController = nil
      parked.isHidden = true
      parkingWindow = nil
      window.rootViewController = root
    }
    window.makeKeyAndVisible()
  }

  /// The phone scene disconnected (the app was swiped away while CarPlay keeps the process, or
  /// the system reclaimed the scene). Park the root view controller so JS keeps running and a
  /// later phone scene adopts it.
  static func detachPhoneWindow(_ window: UIWindow?) {
    guard let window = window, let root = window.rootViewController else { return }
    window.rootViewController = nil
    let parked = makeParkingWindow()
    parked.rootViewController = root
    parkingWindow = parked
    mirror?(nil)
  }

  /// A CarPlay scene connected: make sure JS runs (a CarPlay-first launch has no phone scene).
  static func ensureStarted() {
    guard !started else { return }
    let parked = makeParkingWindow()
    parkingWindow = parked
    start(into: parked, launchOptions: nil)
  }

  private static func start(
    into window: UIWindow,
    launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) {
    guard let starter = starter else {
      // withCarPlay.js writes `configure` into the AppDelegate together with the scene
      // manifest; reaching this means the prebuild output was edited by hand.
      NSLog("[AudiosiloScenes] no starter: the AppDelegate was not patched by withCarPlay")
      return
    }
    started = true
    starter(window, launchOptions)
  }

  /// A window with no scene: never on screen, it only keeps React Native's root view
  /// controller (and so its surface) alive. Sized like the phone so the first layout is sane.
  private static func makeParkingWindow() -> UIWindow {
    UIWindow(frame: UIScreen.main.bounds)
  }
}
