import { useShakeToExtend } from '@/playback/use-shake-to-extend';

/**
 * Headless: mounts shake-to-extend at the app root, where the sleep timer itself
 * lives. It must NOT hang off the player modal - the feature's main case is a nightly
 * timer on a locked phone with no screen open, and a hook mounted in `PlayerView`
 * would only listen while that modal happened to be on screen.
 *
 * Mounted exactly once (in `app/_layout.tsx`); the hook itself only turns the
 * accelerometer on inside the fade / grace windows.
 */
export function ShakeToExtendListener() {
  useShakeToExtend();
  return null;
}
