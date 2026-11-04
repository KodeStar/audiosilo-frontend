// PASS 2 seam: the watch's player (WatchAudioEngine: AVQueuePlayer from the downloaded files,
// `.longFormAudio` with the route picker, Now Playing per chapter, remote commands, speed,
// sleep, the one-time speaker confirmation) conforms to this and AppModel holds it. Its engine
// events drive AppModel.spans (SpanRecorder) and the outbox flush (Outbox.flush via APIClient).
import Foundation

@MainActor
protocol WatchPlayer: AnyObject {
  /// The book loaded, nil when none.
  var loadedBook: BookRef? { get }
  /// Stop playing and close the open span (removing the playing book, signing out).
  func stop()
}
