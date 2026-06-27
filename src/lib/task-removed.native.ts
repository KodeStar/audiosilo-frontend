import AudiosiloPlayer from '../../modules/audiosilo-player';

/**
 * Whether the user swiped the app away from recents since this was last checked
 * (read+clear). The native module returns the flag the playback service records in
 * onTaskRemoved; iOS always returns false (it cold-starts to Home on relaunch).
 */
export function consumeTaskRemoved(): boolean {
  return AudiosiloPlayer.consumeTaskRemoved();
}
