import type { TriggerRef } from '@rn-primitives/dropdown-menu';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useAllProgressAll, useBook } from '@/api/hooks';
import type { Book } from '@/api/types';
import { toast } from '@/components/ui/toast';
import { useLayout } from '@/lib/layout';

import { BookActionsMenu } from './books/book-actions';

/**
 * A cover tile's actions (the Library list's "..." menu, `BookActionsMenu`), opened by
 * the tile's long-press, right-click or Menu key: the sheet on a phone, a menu anchored
 * to the tile's corner on tablet and desktop (a hidden anchor the tile opens; it never
 * takes a press itself). Mounted on the tile's first request and kept, so the dialogs an
 * action opens outlive the menu; each new `request` opens it again. The actions need the
 * book's list row: the tile's `book` when the screen has it, else one item fetch on the
 * first request. The progress comes from the shared all-progress cache.
 */
export function TileActions({
  connectionId,
  libraryId,
  path,
  book: given,
  request,
  tileRef,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
  book?: Book;
  /** Bumped by the tile for each request; opens the menu again. */
  request: number;
  /** The tile, which takes the focus back when the menu closes (web). */
  tileRef: RefObject<View | null>;
}) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  // An empty path disables the fetch when the screen handed the row over.
  const item = useBook(libraryId, given ? '' : path, connectionId);
  const book = given ?? item.data;
  const { progress } = useAllProgressAll({ refetchOnMount: false });
  const saved = progress.find(
    (p) => p.connectionId === connectionId && p.library_id === libraryId && p.path === path,
  );
  const triggerRef = useRef<TriggerRef>(null);
  // Phone: the sheet is open for the latest request until it is closed.
  const [closed, setClosed] = useState(0);
  const sheetOpen = !!book && phone && closed !== request;
  // Tablet/desktop: open the anchored menu once per request, when the book is in.
  const opened = useRef(0);
  useEffect(() => {
    if (!book || phone || opened.current === request) return;
    opened.current = request;
    triggerRef.current?.open();
  }, [book, request, phone]);

  const failed = !given && item.isError;
  useEffect(() => {
    if (failed) toast({ title: t('library.bookActions.loadFailed') });
  }, [failed, request, t]);

  if (!book) return null;
  return (
    <BookActionsMenu
      connectionId={connectionId}
      libraryId={libraryId}
      book={book}
      progress={saved}
      sheetOpen={sheetOpen}
      onSheetOpenChange={(open) => {
        if (!open) setClosed(request);
      }}
      triggerRef={triggerRef}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        (tileRef.current as unknown as HTMLElement | null)?.focus?.();
      }}
      trigger={
        <View
          testID="tile-actions-anchor"
          pointerEvents="none"
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          aria-hidden
          tabIndex={-1}
          style={{ position: 'absolute', top: 8, right: 8, width: 1, height: 1 }}
        />
      }
    />
  );
}
