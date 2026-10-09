import Foundation
import ObjectiveC

/// When React Native's timing module must run on its NSTimer (`AudiosiloJSTimers.swift` has the
/// why): while a CarPlay scene is connected and no phone scene is in the foreground. Pure, so
/// the host self-check (SelfCheck/run.sh) covers it.
struct CarTimerPolicy {
  enum Action: Equatable {
    case none
    /// RCTTiming `appDidMoveToBackground`: fire timers from its NSTimer.
    case background
    /// RCTTiming `appDidMoveToForeground`: back on the display link.
    case foreground
  }

  private(set) var carConnected = false
  private(set) var phoneForeground = false
  /// RCTTiming was sent to its background mode by this policy (not by UIKit).
  private(set) var holding = false

  var carOnly: Bool { carConnected && !phoneForeground }

  mutating func car(connected: Bool) { carConnected = connected }
  mutating func phone(foreground: Bool) { phoneForeground = foreground }

  /// What to tell RCTTiming now. While the car alone shows the app it is `background` every
  /// time (an app activation may have switched RCTTiming back; the call is idempotent), once
  /// React Native's timing module can be found. Leaving that state, `foreground` only into a
  /// phone scene in the foreground: when the car left with the phone in the background, UIKit's
  /// own DidEnterBackground already keeps RCTTiming in its background mode. With no car this is
  /// always `none`, so a phone-only app is never touched.
  mutating func decide(timingFound: Bool) -> Action {
    if carOnly {
      guard timingFound else { return .none }
      holding = true
      return .background
    }
    guard holding else { return .none }
    holding = false
    return phoneForeground ? .foreground : .none
  }
}

/// Finds the RCTTiming that drives JS timers, from the RCTHost, as React Native 0.85 holds it:
/// RCTHost `_instance` -> RCTInstance `_displayLink` -> RCTDisplayLink `_frameUpdateObservers`
/// -> a holder's `instance`. Only the Objective-C runtime is used, each step checked, so a React
/// Native that moved any of them gives `.moved` (logged by the caller), never a crash; KVC is
/// never used (a missing key raises an Objective-C exception). `rn-timing-internals.test.ts`
/// fails a React Native upgrade that renames any of them.
enum ReactTiming {
  enum Lookup {
    case found(NSObject)
    /// React Native has not created it yet (no instance on the host).
    case notYet
    /// React Native's internals are not shaped as expected.
    case moved(String)
  }

  static let background = NSSelectorFromString("appDidMoveToBackground")
  static let foreground = NSSelectorFromString("appDidMoveToForeground")
  private static let moduleOfHolder = NSSelectorFromString("instance")

  static func find(host: NSObject) -> Lookup {
    guard let instanceIvar = objectIvar(host, "_instance") else {
      return .moved("RCTHost has no _instance")
    }
    guard let instance = object_getIvar(host, instanceIvar) as? NSObject else { return .notYet }
    guard let linkIvar = objectIvar(instance, "_displayLink") else {
      return .moved("RCTInstance has no _displayLink")
    }
    guard let link = object_getIvar(instance, linkIvar) as? NSObject else { return .notYet }
    guard let setIvar = objectIvar(link, "_frameUpdateObservers"),
          let observers = object_getIvar(link, setIvar) as? NSSet else {
      return .moved("RCTDisplayLink has no _frameUpdateObservers")
    }
    guard let timingClass = NSClassFromString("RCTTiming") else { return .moved("no RCTTiming class") }
    for case let holder as NSObject in observers.allObjects where holder.responds(to: moduleOfHolder) {
      guard let module = holder.perform(moduleOfHolder)?.takeUnretainedValue() as? NSObject,
            module.isKind(of: timingClass) else { continue }
      guard module.responds(to: background), module.responds(to: foreground) else {
        return .moved("RCTTiming lacks appDidMoveToBackground/appDidMoveToForeground")
      }
      return .found(module)
    }
    // Registered with the display link right after the runtime starts, before the bundle runs.
    return .notYet
  }

  /// An object-typed instance variable of `object`'s class or a superclass, else nil.
  private static func objectIvar(_ object: NSObject, _ name: String) -> Ivar? {
    guard let ivar = class_getInstanceVariable(type(of: object), name),
          let encoding = ivar_getTypeEncoding(ivar), encoding.pointee == UInt8(ascii: "@") else {
      return nil
    }
    return ivar
  }
}
