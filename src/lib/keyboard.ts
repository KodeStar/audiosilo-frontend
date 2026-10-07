import { useEffect } from 'react';
import { Platform } from 'react-native';

import { useLatest } from '@/lib/use-latest';

/**
 * Guards shared by the web's global keyboard shortcuts (the palette's ⌘K and `/`, Up
 * next's Q, the player's keys): a shortcut never fires while the focus is in something
 * you type into, nor over a modal dialog or an open menu, and the player's Space and
 * arrows stand aside for a focused control that uses them. The guards are DOM-only
 * (callers check `Platform.OS === 'web'` first); `useGlobalShortcut` applies the first two.
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

/** Roles that Space activates: it presses a button, toggles a checkbox, picks a tab or
 * an option. Not a slider, which uses only the arrows (so Space still plays and pauses
 * over a focused scrubber). */
const SPACE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'switch',
  'radio',
  'tab',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'combobox',
  'listbox',
]);

/** Roles that move with the arrow keys: a slider steps, the focus walks tabs, radios,
 * options and menu items, a separator resizes. Not a plain button or link, which ignore
 * them (so the arrows still skip after a click on play). */
const ARROW_ROLES = new Set([
  'slider',
  'tab',
  'radio',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'combobox',
  'listbox',
  'spinbutton',
  'separator',
]);

/** Whether the focus is on a control that Space activates (a button, a link, a tab...):
 * a global shortcut on Space must leave it to the control. */
export function ownsSpace(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'BUTTON' || el.tagName === 'A') return true;
  const role = el.getAttribute?.('role');
  return !!role && SPACE_ROLES.has(role);
}

/** Whether the focus is on a control that moves with the arrow keys (a slider, tabs, a
 * list's options...): a global shortcut on the arrows must leave them to it. */
export function ownsArrows(el: Element | null): boolean {
  if (!el) return false;
  const role = el.getAttribute?.('role');
  return !!role && ARROW_ROLES.has(role);
}

/** A layer that takes the keyboard while it is open: an `aria-modal` dialog (the bottom
 * `Sheet`), or an open Radix layer from rn-primitives (Dialog, AlertDialog, DropdownMenu,
 * Select), which says so with `data-state="open"` and sets no `aria-modal`. */
const OPEN_LAYER = [
  '[aria-modal="true"]',
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
].join(', ');

/** The attribute a layer names itself by (`Sheet`'s `layer`, rendered as `data-layer` on
 * the web), so the shortcut that toggles it can still close it. */
const LAYER_ATTR = 'data-layer';

/** Whether a modal dialog or an open menu is in `doc` (the palette, a sheet, the desktop
 * speed or sleep dialog, the shortcuts overlay, an alert, the player's overflow menu, a
 * select): a shortcut must not act behind it. `own` names a layer that does not count
 * (Q's own Up next sheet: Q opened it, so Q closes it too). */
export function isModalOpen(doc: Pick<Document, 'querySelectorAll'>, own?: string): boolean {
  const open = Array.from(doc.querySelectorAll(OPEN_LAYER));
  if (own === undefined) return open.length > 0;
  return open.some((el) => el.closest(`[${LAYER_ATTR}="${own}"]`) === null);
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
 * the focus is in a field), never over a modal dialog or an open menu other than its own
 * `layer` (see `isModalOpen`), never for a held key's repeats. Nothing is attached while
 * `enabled` is false, or off the web.
 */
export function useGlobalShortcut(
  enabled: boolean,
  matches: (e: ShortcutKey, editable: boolean) => boolean,
  run: () => void,
  layer?: string,
): void {
  const match = useLatest(matches);
  const act = useLatest(run);
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || !match(e, isEditable(document.activeElement))) return;
      if (isModalOpen(document, layer)) return;
      e.preventDefault();
      act();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, match, act, layer]);
}
