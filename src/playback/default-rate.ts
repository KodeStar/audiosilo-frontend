import { activeProfile } from '@/stores/profiles';
import { useSettings } from '@/stores/settings';

/**
 * The speed a book with no speed of its own starts at: the default speed setting, or 1x
 * while a kids profile listens (8b-1, D3). The default speed is a device-wide grown-up's
 * setting and kids mode has no speed control, so a child never inherits a grown-up's 1.4x;
 * a story with a speed saved for the kid keeps it (`bookSpeed`, the saved speed first).
 * Read at each start (`playBook`) and by the car's native start specs.
 */
export function listenerDefaultRate(): number {
  return activeProfile()?.kids ? 1 : useSettings.getState().defaultRate;
}
