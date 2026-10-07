import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePlayerSheets } from '@/components/player/player-sheets';
import { addBookmarkHere } from '@/components/player/player-shortcuts';
import { Button } from '@/components/ui/button';
import { contentKeyOf } from '@/lib/content-key';
import { formatClock } from '@/lib/format';
import { pushInShell } from '@/lib/open';
import { journalHref, type JournalTab } from '@/lib/paths';
import { selectBookKey, usePlayer } from '@/playback/store';

import type { AnnotationTarget } from './editor-model';
import { usePlaceIn } from './use-book-place';

/** "See all in your journal": the listener's bookmarks or notes across every book. From
 * over the full player it lands in the shell underneath (`pushInShell`). */
export function JournalLink({ tab }: { tab: Exclude<JournalTab, 'diary'> }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      size="sm"
      title={t('annotations.seeAll')}
      icon="chevron-right"
      onPress={() => pushInShell(journalHref(tab))}
      testID={`journal-link-${tab}`}
    />
  );
}

/**
 * "Bookmark 17:26:50", at the top of a book's bookmarks. While the book is the loaded one
 * it bookmarks the live place in one tap (`addBookmarkHere`: its toast offers "Add
 * note"); for a book that is not playing it opens the bookmark editor at the listener's
 * place in it (`usePlaceIn`), so they see where it lands before it is made. Its label
 * follows the playhead, so it is a leaf of its own.
 */
export function AddBookmarkAction({ target }: { target: AnnotationTarget }) {
  const { t } = useTranslation();
  const key = contentKeyOf(target);
  const loaded = usePlayer((s) => selectBookKey(s) === key);
  const at = usePlaceIn(target);
  const [adding, setAdding] = useState(false);
  const press = () => {
    if (loaded) {
      setAdding(true);
      void addBookmarkHere(t).finally(() => setAdding(false));
      return;
    }
    usePlayerSheets.getState().openEditor({ kind: 'bookmark', target, position: at });
  };
  return (
    <Button
      size="sm"
      icon="bookmark"
      title={t('annotations.bookmark.addAt', { time: formatClock(at) })}
      loading={adding}
      onPress={press}
      testID="add-bookmark"
    />
  );
}

/** "Note at 17:26:50", at the top of a book's notes: opens the note editor pinned to the
 * listener's place in the book (live while it plays, else the saved place, else the
 * start). */
export function AddNoteAction({ target }: { target: AnnotationTarget }) {
  const { t } = useTranslation();
  const at = usePlaceIn(target);
  return (
    <Button
      size="sm"
      icon="notes"
      title={t('annotations.note.addAt', { time: formatClock(at) })}
      onPress={() => usePlayerSheets.getState().openEditor({ kind: 'note', target, position: at })}
      testID="add-note"
    />
  );
}
