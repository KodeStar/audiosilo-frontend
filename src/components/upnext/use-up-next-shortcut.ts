import { useEffect } from 'react';
import { Platform } from 'react-native';

import { useCapability } from '@/api/hooks';

import { isUpNextShortcut } from './up-next-model';
import { toggleUpNext } from './up-next-store';
import { useUpNextConnection } from './use-up-next';

/** Whether the focus is in something you type into (no shortcut fires there). */
function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (el as HTMLElement).isContentEditable === true
  );
}

/**
 * Q shows or hides Up next (web; STYLEGUIDE section 11): never while typing in a field,
 * never over a dialog (the palette, a sheet) or the full player (`enabled` false), and
 * only once the server is known to have `queue`. The same guards as the palette's
 * shortcut (`usePaletteShortcut`).
 */
export function useUpNextShortcut(enabled: boolean) {
  const supported = useCapability('queue', useUpNextConnection()) === true;
  useEffect(() => {
    if (!enabled || !supported || Platform.OS !== 'web' || typeof document === 'undefined') {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || !isUpNextShortcut(e, isEditable(document.activeElement))) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      toggleUpNext();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, supported]);
}
