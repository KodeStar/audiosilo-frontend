import TrackPlayer, { Event } from 'react-native-track-player';

// Registers the background playback service so lock-screen / Control Center /
// headset remote commands work. Must run at app startup, so this module is
// imported (for its side effect) from the root layout.
TrackPlayer.registerPlaybackService(() => async () => {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteSeek, (e) => TrackPlayer.seekTo(e.position));
  TrackPlayer.addEventListener(Event.RemoteJumpForward, (e) => TrackPlayer.seekBy(e.interval));
  TrackPlayer.addEventListener(Event.RemoteJumpBackward, (e) => TrackPlayer.seekBy(-e.interval));
  TrackPlayer.addEventListener(Event.RemoteNext, () => TrackPlayer.skipToNext());
  TrackPlayer.addEventListener(Event.RemotePrevious, () => TrackPlayer.skipToPrevious());
});
