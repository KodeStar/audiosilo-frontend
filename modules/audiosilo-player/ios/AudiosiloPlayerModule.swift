import ExpoModulesCore
import AVFoundation
import AVKit
import MediaPlayer
import UIKit

// The engine lives in AudioEngine.swift (transport, queue, remote commands, Now Playing),
// with ChapterClips.swift (lock-screen chapter maths), SmartSpeed.swift +
// SmartSpeedPlanner.swift (silence trimming for downloaded books), VoiceBoostTap.swift (the
// speech compressor) and AudioEngine+CarPlay.swift (what the CarPlay templates read). This file
// is the JS bridge only.

// MARK: - Records

struct TrackRecord: Record {
  @Field var id: String = ""
  @Field var url: String = ""
  @Field var headers: [String: String]? = nil
  @Field var title: String = ""
  @Field var album: String? = nil
  @Field var artist: String? = nil
  @Field var artwork: String? = nil
  @Field var duration: Double? = nil
}

struct ConfigRecord: Record {
  @Field var autoRewindMax: Double = 0
  @Field var jumpForward: Double = 30
  @Field var jumpBackward: Double = 15
  /// Phase 6. Trim silences; on iOS only a downloaded book (every track a file:// URL) is
  /// trimmed. Absent from an older JS bundle: off.
  @Field var smartSpeed: Bool = false
  /// Phase 6. The speech compressor (VoiceBoostTap.swift). Absent from an older JS bundle: off.
  @Field var voiceBoost: Bool = false
}

/// Chapter clips from the shared bridge (`buildChapterClips`): Android plays them as clipped
/// media items; iOS (Phase 6) uses them for the chapter-relative lock screen, next/previous
/// chapter and CarPlay's chapter list, while still playing whole files.
struct ChapterRecord: Record {
  @Field var fileIndex: Int = 0
  @Field var startInFile: Double = 0
  @Field var endInFile: Double = 0
  @Field var title: String = ""
}

/// `load`'s optional 5th argument (Phase 6): which book the queue is. Android keeps it in the
/// service's media items (`getLoadedBook`); iOS accepts it for arity parity and ignores it.
struct BookRecord: Record {
  @Field var connectionId: String = ""
  @Field var libraryId: Int = 0
  @Field var path: String = ""
}

// MARK: - Module

public class AudiosiloPlayerModule: Module {
  private var engine: AudioEngine?
  /// A reusable AirPlay route picker kept off-screen. AVRoutePickerView has no public
  /// "present" API — the system sheet is opened by tapping the view's internal button —
  /// so we hold one in the window and trigger it programmatically (see presentRoutePicker).
  private var routePicker: AVRoutePickerView?

  public func definition() -> ModuleDefinition {
    Name("AudiosiloPlayer")

    // The full Phase 6 event list (contract section 1). onCarConnection / onCarPlayRequest are
    // sent by the CarPlay scene code; an event JS doesn't listen to is simply dropped.
    Events(
      "onState", "onProgress", "onTrackChange",
      "onRemoteMove", "onRateChange", "onRemoteBookmark",
      "onCarConnection", "onCarPlayRequest"
    )

    // Android-only signal (swipe-from-recents → reset to Home on next foreground). iOS
    // reliably terminates on swipe-away, so relaunch is already a cold start to Home;
    // always false here for bridge parity.
    Function("consumeTaskRemoved") { () -> Bool in false }

    AsyncFunction("setup") { [weak self] in
      self?.onMain { self?.ensureEngine() }
    }

    AsyncFunction("setConfig") { [weak self] (config: ConfigRecord) in
      self?.onMain { self?.ensureEngine().setConfig(config) }
    }

    // The 4th arg (chapters) drives the iOS chapter lock screen (and Android's clipped items).
    // The 5th (book) is Android's (getLoadedBook); iOS ignores it. Both are optional trailing
    // arguments: Expo accepts 3, 4 or 5 arguments and passes nil for the missing ones, so an
    // older JS bundle that sends 4 still works (and a newer one sending 5 to this binary no
    // longer fails the argument count).
    AsyncFunction("load") {
      [weak self] (tracks: [TrackRecord], startIndex: Int, position: Double, chapters: [ChapterRecord]?, _: BookRecord?) in
      self?.onMain {
        self?.ensureEngine().load(tracks: tracks, startIndex: startIndex, position: position, chapters: chapters ?? [])
      }
    }

    AsyncFunction("play") { [weak self] in self?.onMain { self?.engine?.play() } }
    AsyncFunction("pause") { [weak self] in self?.onMain { self?.engine?.pause() } }
    AsyncFunction("seekTo") { [weak self] (seconds: Double) in self?.onMain { self?.engine?.seek(to: seconds) } }
    AsyncFunction("skipToTrack") { [weak self] (index: Int, seconds: Double) in
      self?.onMain { self?.engine?.skip(to: index, position: seconds) }
    }
    AsyncFunction("setRate") { [weak self] (rate: Double) in self?.onMain { self?.engine?.setRate(rate) } }
    // Engine gain (0...1) for the sleep-timer fade - NOT the device volume. No-ops before
    // the engine exists (nothing is playing to fade), like the other transport commands.
    AsyncFunction("setVolume") { [weak self] (volume: Double) in
      self?.onMain { self?.engine?.setVolume(volume) }
    }
    AsyncFunction("reset") { [weak self] in self?.onMain { self?.engine?.reset() } }

    // Opens the AirPlay route sheet so the user can send audio to a HomePod / AirPlay
    // speaker. AVQueuePlayer follows the chosen route automatically (the audio session is
    // already .playback/.longFormAudio). Resolves true once the picker has been triggered.
    // Uses a Promise so it resolves AFTER the main-thread hop (AVRoutePickerView is UIKit).
    AsyncFunction("showRoutePicker") { [weak self] (promise: Promise) in
      guard let self = self else { promise.resolve(false); return }
      self.onMain { promise.resolve(self.presentRoutePicker()) }
    }

    // Phase 6, Android's: the book a service started without JS. iOS never plays without the
    // app's JS (CarPlay asks JS to start every book), so there is never one.
    AsyncFunction("getLoadedBook") { (promise: Promise) in promise.resolve(nil) }
    // Phase 6, Android's: bookmarks pressed while no JS ran. iOS sends onRemoteBookmark live.
    AsyncFunction("consumePendingBookmarks") { () -> [String] in [] }

    // Phase 6 (CarPlay): the car snapshot JS builds (labels, tabs, books). Kept on disk so the
    // car shows it at once on the next connect; refreshes the templates on screen.
    AsyncFunction("setCarSnapshot") { (json: String) in
      AudiosiloCarSnapshotStore.shared.set(json: json)
    }

    // Car events wait for a JS listener (a CarPlay-first launch connects before JS listens).
    OnStartObserving("onCarConnection") { [weak self] in
      if let self = self { AudiosiloCarEvents.shared.startObserving("onCarConnection", module: self) }
    }
    OnStopObserving("onCarConnection") { [weak self] in
      if let self = self { AudiosiloCarEvents.shared.stopObserving("onCarConnection", module: self) }
    }
    OnStartObserving("onCarPlayRequest") { [weak self] in
      if let self = self { AudiosiloCarEvents.shared.startObserving("onCarPlayRequest", module: self) }
    }
    OnStopObserving("onCarPlayRequest") { [weak self] in
      if let self = self { AudiosiloCarEvents.shared.stopObserving("onCarPlayRequest", module: self) }
    }

    OnDestroy { [weak self] in
      self?.onMain {
        self?.engine?.reset()
        self?.engine = nil
      }
    }
  }

  /// AVFoundation / MPRemoteCommandCenter must be touched on the main thread.
  private func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
  }

  /// Trigger the AirPlay route picker. AVRoutePickerView exposes no programmatic
  /// "present"; the documented approach is to host the view and send its internal
  /// UIButton a touch. We keep one off-screen in the key window and reuse it. Must run
  /// on the main thread. Returns whether the trigger fired.
  private func presentRoutePicker() -> Bool {
    guard let window = Self.keyWindow() else { return false }
    let picker = routePicker ?? AVRoutePickerView(frame: CGRect(x: -1000, y: -1000, width: 1, height: 1))
    routePicker = picker
    picker.prioritizesVideoDevices = false
    // Re-parent to the *current* key window each time. The key window can change (return
    // from background, scene reconnect, iPad multi-scene); triggering the button from a
    // stale/background window won't present the sheet. addSubview moves it if needed, and
    // is a no-op when it's already on this window.
    if picker.superview !== window { window.addSubview(picker) }
    for case let button as UIButton in picker.subviews {
      button.sendActions(for: .touchUpInside)
      return true
    }
    return false
  }

  private static func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
  }

  @discardableResult
  private func ensureEngine() -> AudioEngine {
    if let engine = engine { return engine }
    let engine = AudioEngine(send: { [weak self] name, body in
      DispatchQueue.main.async { self?.sendEvent(name, body) }
    })
    self.engine = engine
    return engine
  }
}
