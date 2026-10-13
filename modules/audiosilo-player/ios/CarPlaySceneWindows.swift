#if canImport(CarPlay)
import CarPlay
import ObjectiveC
import UIKit

/// React Native's `RCTAppearance.setColorScheme` (what `Appearance.setColorScheme`, and so the
/// theme, calls) treats every connected scene as a `UIWindowScene` and asks it for `windows`.
/// A `CPTemplateApplicationScene` is a plain `UIScene`, so with CarPlay connected that call threw
/// "unrecognized selector" and aborted the app: seen on an iPhone when the phone app was opened
/// during a CarPlay-first session (the theme applied as the React tree first rendered), and it
/// would happen on any theme change while in the car. The CarPlay scene has no windows React
/// Native should restyle, so it answers an empty list. The method is added only when the class
/// has none, so an iOS that implements `windows` itself keeps its own.
enum CarPlaySceneWindows {
  static func install() {
    let cls: AnyClass = CPTemplateApplicationScene.self
    let selector = NSSelectorFromString("windows")
    guard !cls.instancesRespond(to: selector) else { return }
    let empty: @convention(block) (AnyObject) -> NSArray = { _ in NSArray() }
    class_addMethod(cls, selector, imp_implementationWithBlock(empty), "@@:")
  }
}
#endif
