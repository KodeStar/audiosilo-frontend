import { useEffect } from 'react';
import { Platform } from 'react-native';

import { useLatest } from '@/lib/use-latest';

/**
 * Guards shared by the web's global keyboard shortcuts (the palette's ⌘K and `/`, Up
 * next's Q): a shortcut never fires while the focus is in something you type into, nor
 * over a modal dialog. The guards are DOM-only (callers check `Platform.OS === 'web'`
 * first); `useGlobalShortcut` applies them.
 */

/** Whether the focus is in something you type into (no shortcut fires there). */
export function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (el as HTMLElement).isContentEditable === true
  );
}

/** Whether a modal dialog (the palette, a sheet, an alert) is open in `doc`. */
export function isModalOpen(doc: Pick<Document, 'querySelector'>): boolean {
  return doc.querySelector('[aria-modal="true"]') !== null;
}

/** The slice of a DOM KeyboardEvent a global shortcut reads. */
export type ShortcutKey = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
};

/**
 * A global keyboard shortcut on the web: `run` when a keydown `matches` (told whether
 * the focus is in a field), never over a modal dialog, never for a held key's repeats.
 * Nothing is attached while `enabled` is false, or off the web.
 */
export function useGlobalShortcut(
  enabled: boolean,
  matches: (e: ShortcutKey, editable: boolean) => boolean,
  run: () => void,
): void {
  const match = useLatest(matches);
  const act = useLatest(run);
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || !match(e, isEditable(document.activeElement))) return;
      if (isModalOpen(document)) return;
      e.preventDefault();
      act();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, match, act]);
}
