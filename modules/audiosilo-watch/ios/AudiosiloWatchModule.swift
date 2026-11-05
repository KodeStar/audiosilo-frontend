import ExpoModulesCore
import UIKit
import WatchConnectivity

// The JS bridge over WatchLink.swift. Its TS surface is modules/audiosilo-watch/index.ts, used
// only by src/watch/link.ios.ts.

/// Activates the session as the app launches, whatever launched it: the app delegate runs on a
/// CarPlay-first and a background launch too, with no JS and no phone scene. A subscriber, so
/// `withCarPlay`'s exact-text rewrite of the AppDelegate is left alone.
public class AudiosiloWatchAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    WatchLink.shared.activate()
    return true
  }
}

public class AudiosiloWatchModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("AudiosiloWatch")

    Events("watchState")

    OnStartObserving("watchState") { [weak self] in
      guard let self, self.observer == nil else { return }
      self.observer = NotificationCenter.default.addObserver(
        forName: WatchLink.changed, object: nil, queue: .main
      ) { [weak self] _ in
        self?.sendEvent("watchState", WatchLink.shared.snapshot())
      }
    }

    OnStopObserving("watchState") { [weak self] in
      if let observer = self?.observer { NotificationCenter.default.removeObserver(observer) }
      self?.observer = nil
    }

    Function("isSupported") { () -> Bool in WCSession.isSupported() }

    AsyncFunction("isPaired") { (promise: Promise) in
      WatchLink.shared.whenActivated { promise.resolve(WatchLink.shared.isPaired) }
    }

    AsyncFunction("isWatchAppInstalled") { (promise: Promise) in
      WatchLink.shared.whenActivated { promise.resolve(WatchLink.shared.isWatchAppInstalled) }
    }

    // The latest `watch-state`, null when the watch has sent none.
    AsyncFunction("getWatchState") { (promise: Promise) in
      WatchLink.shared.whenActivated { promise.resolve(WatchLink.shared.watchState) }
    }

    // Answers "message" or "transfer": how it went. A `book` sent once this answered is behind it.
    AsyncFunction("sendPair") { (message: [String: Any], promise: Promise) in
      WatchLink.shared.sendPair(message) { result in
        switch result {
        case .success(let how): promise.resolve(how)
        case .failure(let error): promise.reject(Self.exception(error))
        }
      }
    }

    AsyncFunction("sendBook") { (message: [String: Any], promise: Promise) in
      WatchLink.shared.sendBook(message) { result in
        switch result {
        case .success: promise.resolve()
        case .failure(let error): promise.reject(Self.exception(error))
        }
      }
    }
  }

  private static func exception(_ error: WatchLinkError) -> Exception {
    switch error {
    case .noWatch:
      return Exception(name: "ERR_NO_WATCH", description: "No paired watch with the app installed")
    case .badMessage:
      return Exception(name: "ERR_BAD_MESSAGE", description: "The message is not a property list")
    }
  }
}
