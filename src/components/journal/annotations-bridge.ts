// TEMPORARY: agent B's `src/components/annotations/` is not on this branch yet. These
// mirror its exported names and behaviour (`isDriftBookmark`, `labelText`) so the
// Journal builds; replaced by re-exports once it is merged.
import type { TFunction } from 'i18next';

import { FELL_ASLEEP_LABEL, isBookmarkLabel } from '@/api/bookmark-labels';
import type { Bookmark } from '@/api/types';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';
import fr from '@/i18n/locales/fr.json';
import it from '@/i18n/locales/it.json';
import pt from '@/i18n/locales/pt.json';

const FELL_ASLEEP_NOTES: ReadonlySet<string> = new Set(
  [en, de, es, fr, it, pt].map((l) => l.player.sleepTimer.fellAsleepNote.trim()),
);

export function isDriftBookmark(bookmark: Pick<Bookmark, 'label' | 'note'>): boolean {
  if (bookmark.label === FELL_ASLEEP_LABEL) return true;
  if (bookmark.label) return false;
  return !!bookmark.note && FELL_ASLEEP_NOTES.has(bookmark.note.trim());
}

export function labelText(t: TFunction, key: string | undefined): string | null {
  return isBookmarkLabel(key) ? t(`annotations.labels.${key}` as never) : null;
}
