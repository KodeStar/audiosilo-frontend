import { useGlobalShortcut } from '@/lib/keyboard';

import { isUpNextShortcut } from './up-next-model';
import { toggleUpNext } from './up-next-store';
import { useUpNextServer } from './use-up-next';

/**
 * Q shows or hides Up next (web; STYLEGUIDE section 11): never while typing in a field,
 * never over a dialog (the palette, a sheet) or the full player (`enabled` false), and
 * only once the server is known to have `queue`. The same guards as the palette's
 * shortcut (`useGlobalShortcut`).
 */
export function useUpNextShortcut(enabled: boolean) {
  const supported = useUpNextServer().supported === true;
  useGlobalShortcut(enabled && supported, isUpNextShortcut, toggleUpNext);
}
