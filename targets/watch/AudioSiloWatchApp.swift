// The Apple Watch app's entry (Track W3a). Standalone (`WKRunsIndependentlyOfCompanionApp`):
// its own token, device_id, outbox and downloads, talking to the server directly. The phone
// link and the background download session are attached before anything else, so a message
// or a finished download from while the app was closed is delivered at launch.
import SwiftUI

@main
struct AudioSiloWatchApp: App {
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var model: AppModel

  init() {
    PhoneLink.shared.activate()
    BackgroundDownloads.shared.attach()
    _model = StateObject(wrappedValue: AppModel.shared)
  }

  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(model)
    }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .active: model.becameActive()
      case .background: model.wentToBackground()
      default: break
      }
    }
    .backgroundTask(.urlSession(BackgroundDownloads.identifier)) {
      // A finished download woke the app: let the session deliver its events.
      await BackgroundDownloads.shared.wake()
    }
  }
}
