import UIKit

/// Keeps React Native's JS timers firing while CarPlay is the only foreground scene.
///
/// React Native's iOS timing module (`RCTTiming`, React/CoreModules/RCTTiming.mm) fires every
/// timer under a second from a CADisplayLink, and switches to an NSTimer (its "sleep timer")
/// only once it believes the app is in the background: at its setup when `applicationState` is
/// `.background`, or on UIApplication WillResignActive / DidEnterBackground; DidBecomeActive /
/// WillEnterForeground switch it back. A CarPlay scene in the foreground keeps the APP active,
/// so none of those fire, yet with no phone scene on screen the display link never ticks: every
/// short JS timer stalls (`setTimeout(fn, 0)`: the car sync's snapshot write, React Query's
/// notify batching), while JS itself, promises and timers over a second still run. Found on an
/// iPhone: after a CarPlay-first launch the car kept yesterday's snapshot and every tapped book
/// spun until its 10 s timeout, until the phone app was opened.
///
/// So while a CarPlay scene is connected and no phone scene is in the foreground (a
/// CarPlay-first launch, the phone locked or in another app, the phone scene disconnected),
/// RCTTiming is told the app went to the background (`appDidMoveToBackground`, its NSTimer
/// mode), and back (`appDidMoveToForeground`) when the phone scene returns (`CarTimerPolicy`).
/// With no car nothing is ever called, so a phone-only app behaves exactly as before.
///
/// Why not the notifications or the module registry: posting UIApplication notifications would
/// also reach React Native's AppState (JS would see `inactive`/`background` while the app is
/// active), Expo's module lifecycle events and the image caches. And in bridgeless mode the
/// RCTTiming that drives JS timers is not a module: `RCTInstance` creates it for its
/// `ObjCTimerRegistry` (ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm
/// `_start`) and registers it only with its display link, so `moduleForName:"Timing"` would
/// create a second, unused instance. `ReactTiming.find` reaches the real one from RCTHost, every
/// step checked: a React Native that moved its internals makes this a logged no-op, never a crash.
///
/// Main thread only (UIKit callbacks; RCTTiming takes these calls on main from its own observers).
@MainActor
enum AudiosiloJSTimers {
  private static var policy = CarTimerPolicy()
  /// React Native's timing module is registered with its display link once the JS runtime has
  /// started; the RCTDisplayLink's observer set is only read after that (it is mutated on the JS
  /// thread while the runtime starts).
  private static var jsRunning = false
  private static var observing = false
  private static var warned = false

  /// The CarPlay scene connected or disconnected.
  static func car(connected: Bool) {
    policy.car(connected: connected)
    observeAppActivation()
    update()
  }

  /// The phone scene is entering the foreground (true), or entered the background or
  /// disconnected (false).
  static func phone(foreground: Bool) {
    policy.phone(foreground: foreground)
    update()
  }

  /// JS is running (the module was created a moment ago, or a car listener registered): a car
  /// that connected before JS gets its timers now.
  static func jsStarted() {
    jsRunning = true
    update()
  }

  /// The module went away (a JS reload): the next runtime registers a new RCTTiming.
  static func jsStopped() {
    jsRunning = false
  }

  private static func update() {
    let timing = policy.carOnly || policy.holding ? findTiming() : nil
    switch policy.decide(timingFound: timing != nil) {
    case .background: _ = timing?.perform(ReactTiming.background)
    case .foreground: _ = timing?.perform(ReactTiming.foreground)
    case .none: break
    }
  }

  /// UIKit posts DidBecomeActive / WillEnterForeground when the CarPlay scene (re)activates with
  /// no phone scene, and RCTTiming's own observer then puts it back on the display link. Applied
  /// again after that observer (observers have no order, hence the async hop).
  private static func observeAppActivation() {
    guard !observing else { return }
    observing = true
    for name in [UIApplication.didBecomeActiveNotification, UIApplication.willEnterForegroundNotification] {
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            if policy.carOnly { update() }
          }
        }
      }
    }
  }

  private static func findTiming() -> NSObject? {
    guard jsRunning else { return nil }
    guard let host = reactHost() else { return notFound("no reactNativeFactory.rootViewFactory.reactHost") }
    switch ReactTiming.find(host: host) {
    case .found(let timing): return timing
    case .notYet: return nil
    case .moved(let why): return notFound(why)
    }
  }

  /// RCTHost, through the AppDelegate's `reactNativeFactory` (a Swift property of the Expo
  /// template's AppDelegate, which withCarPlay.js matches exactly; read with Mirror as it is not
  /// @objc) and RCTReactNativeFactory's public `rootViewFactory.reactHost`.
  private static func reactHost() -> NSObject? {
    let rootViewFactory = NSSelectorFromString("rootViewFactory")
    let reactHost = NSSelectorFromString("reactHost")
    guard let delegate = UIApplication.shared.delegate,
          let factory = Mirror(reflecting: delegate).children
            .first(where: { $0.label == "reactNativeFactory" })?.value as? NSObject,
          factory.responds(to: rootViewFactory),
          let views = factory.perform(rootViewFactory)?.takeUnretainedValue() as? NSObject,
          views.responds(to: reactHost) else { return nil }
    return views.perform(reactHost)?.takeUnretainedValue() as? NSObject
  }

  private static func notFound(_ why: String) -> NSObject? {
    if !warned {
      warned = true
      NSLog("[AudiosiloScenes] JS timers may stall while only CarPlay shows the app: \(why)")
    }
    return nil
  }
}
