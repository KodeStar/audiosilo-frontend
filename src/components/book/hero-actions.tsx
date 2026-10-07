import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useCapability, useFavourites, useQueue, useToggleFavourite } from '@/api/hooks';
import type { Book, ChaptersResponse, Progress } from '@/api/types';
import { BookActionsMenu } from '@/components/library/books/book-actions';
import { AddToCollectionDialog } from '@/components/library/collections/collection-dialogs';
import { DownloadControl } from '@/components/library/download-control';
import { findQueued, useQueueActions } from '@/components/library/use-queue-actions';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

import { type PrimaryAction, primaryLabel } from './book-page-model';

/** The book menu's items the hero's own buttons already are. */
const MENU_OMIT = ['play', 'queue', 'collect', 'download'] as const;

/** An icon-only hero button: 46 tall like the primary, square. */
const ICON_BUTTON = 'w-[46px] px-0';

export type HeroActionsProps = {
  connectionId: string;
  libraryId: number;
  book: Book;
  chapterData?: ChaptersResponse;
  chaptersLoading: boolean;
  progress?: Progress | null;
  primary: PrimaryAction;
  onPrimary: () => void;
  /** Two rows on a phone: the primary and the download, then the icon buttons. */
  stacked: boolean;
};

/**
 * The hero's actions (the prototype's `hero-actions`): the primary (ink: Resume chapter
 * N, Start listening, Listen again, Pause), the download, Up next (Play next / Add to the
 * end, capability `queue`), favourite, Add to collection (capability `collections`) and
 * the book menu (mark finished or not, more in this series). Nothing here is pink: the
 * hero's one pink thing is the progress bar.
 */
export function HeroActions({
  connectionId,
  libraryId,
  book,
  chapterData,
  chaptersLoading,
  progress,
  primary,
  onPrimary,
  stacked,
}: HeroActionsProps) {
  const { t } = useTranslation();
  const path = book.rel_path;
  const collections = useCapability('collections', connectionId) === true;
  const progressEdit = useCapability('progress_edit', connectionId);
  const [collect, setCollect] = useState(false);
  const [sheet, setSheet] = useState(false);
  const finished = !!progress?.finished;
  // Mark finished needs `progress_edit` known (an older server saves at the end instead,
  // so any known answer offers it); Mark as not finished needs it on.
  const menuHasItems =
    !!book.series || (finished ? progressEdit === true : progressEdit !== undefined);

  const primaryButton = (
    <Button
      size="lg"
      icon={primary.kind === 'pause' ? 'pause' : 'play'}
      title={primaryLabel(t, primary)}
      onPress={onPrimary}
      className={stacked ? 'flex-1' : undefined}
    />
  );
  const download = (
    <View className={stacked ? 'flex-1' : undefined}>
      <DownloadControl
        libraryId={libraryId}
        path={path}
        book={book}
        chapterData={chapterData}
        disabled={chaptersLoading}
      />
    </View>
  );
  const icons = (
    <>
      <UpNextMenu connectionId={connectionId} libraryId={libraryId} book={book} />
      <FavouriteButton connectionId={connectionId} libraryId={libraryId} path={path} />
      {collections ? (
        <Button
          variant="outline"
          size="lg"
          icon="layers"
          className={ICON_BUTTON}
          accessibilityLabel={t('library.bookActions.collect')}
          onPress={() => setCollect(true)}
        />
      ) : null}
      {menuHasItems ? (
        <BookActionsMenu
          connectionId={connectionId}
          libraryId={libraryId}
          book={book}
          progress={progress ?? undefined}
          omit={MENU_OMIT}
          sheetOpen={sheet}
          onSheetOpenChange={setSheet}
          trigger={
            <Button
              variant="ghost"
              size="lg"
              icon="ellipsis"
              className={ICON_BUTTON}
              accessibilityLabel={t('library.bookActions.more', { title: book.title })}
              onPress={stacked ? () => setSheet(true) : undefined}
            />
          }
        />
      ) : null}
    </>
  );

  return (
    <>
      {stacked ? (
        <View className="gap-2">
          <View className="flex-row gap-2">
            {primaryButton}
            {download}
          </View>
          <View className="flex-row flex-wrap gap-2">{icons}</View>
        </View>
      ) : (
        <View className="flex-row flex-wrap items-center gap-2">
          {primaryButton}
          {download}
          {icons}
        </View>
      )}
      {collect ? (
        <AddToCollectionDialog
          open={collect}
          onOpenChange={setCollect}
          connectionId={connectionId}
          libraryId={libraryId}
          path={path}
          title={book.title}
        />
      ) : null}
    </>
  );
}

/** Favourite on or off. Ink, never pink: the hero's pink is the progress bar. */
function FavouriteButton({
  connectionId,
  libraryId,
  path,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
}) {
  const { t } = useTranslation();
  const { data: favourites } = useFavourites();
  const toggle = useToggleFavourite(connectionId);
  const on = !!favourites?.some((f) => f.library_id === libraryId && f.path === path);
  return (
    <Button
      variant="outline"
      size="lg"
      icon={on ? 'heart-solid' : 'heart'}
      className={ICON_BUTTON}
      accessibilityLabel={on ? t('library.favourite.remove') : t('library.favourite.add')}
      accessibilityState={{ selected: on }}
      onPress={() => toggle.mutate({ libraryId, path, on: !on })}
    />
  );
}

/**
 * Up next for this book (capability `queue`, on the book's own server): Play next puts it
 * at the head (moving it there when it is already queued), Add to the end queues it last,
 * Remove from Up next takes it off. Each says so with an Undo.
 */
function UpNextMenu({
  connectionId,
  libraryId,
  book,
}: {
  connectionId: string;
  libraryId: number;
  book: Book;
}) {
  const { t } = useTranslation();
  const q = useQueueActions(connectionId);
  const { data: entries } = useQueue(connectionId);
  if (!q.supported) return null;
  const path = book.rel_path;
  const queued = findQueued(entries, libraryId, path);

  const playNext = async () => {
    const before = queued && entries ? entries.indexOf(queued) : -1;
    try {
      const next = await q.add.mutateAsync({ libraryId, path, position: 0 });
      const added = findQueued(next, libraryId, path);
      toast({
        title: t('book.upNext.playsNext'),
        description: book.title,
        action: added
          ? {
              label: t('queue.undo'),
              // Undo puts it back where it was: off the queue, or at its old place.
              onPress: () =>
                void (
                  before < 0
                    ? q.remove.mutateAsync({ libraryId, path: added.path })
                    : q.add.mutateAsync({ libraryId, path: added.path, position: before })
                ).catch(q.fail),
            }
          : undefined,
      });
    } catch (e) {
      q.fail(e);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="lg"
          icon="queue"
          className={cn(ICON_BUTTON)}
          accessibilityLabel={t('book.upNext.label', { title: book.title })}
          loading={q.pending}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem icon="play-next" onPress={() => void playNext()}>
          <Text>{t('book.upNext.playNext')}</Text>
        </DropdownMenuItem>
        {queued ? (
          <DropdownMenuItem icon="close" onPress={() => void q.unqueue(libraryId, path)}>
            <Text>{t('queue.removeLabel')}</Text>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem icon="plus" onPress={() => void q.queue(libraryId, path)}>
            <Text>{t('book.upNext.addToEnd')}</Text>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
