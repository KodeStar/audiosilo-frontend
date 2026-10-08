import Foundation

// STUB: the main session replaces this file at merge with WS-B's engine conformance:
// `extension AudioEngine: CarPlayPlayerAccess` (chapter clips, current clip, seek to a clip
// emitting onRemoteMove, rate from the car emitting onRateChange, bookmark emitting
// onRemoteBookmark, loadedBookId from load's 5th argument through CarItemId.make) and
// `CarPlayPlayer.current` returning the shared engine. The engine must also post
// `.audiosiloPlayerDidChange` on load / reset / play state / chapter changes.
//
// Until then CarPlay shows the lists and the system Now Playing (fed by MPNowPlayingInfoCenter),
// with no chapter list, and the rate and bookmark buttons do nothing.
enum CarPlayPlayer {
  static var current: CarPlayPlayerAccess? { nil }
}
