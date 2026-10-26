import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useCapability, useFavourites, useQueue, useToggleFavourite } from '@/api/hooks';
import type { Book, ChaptersResponse, Progress } from '@/api/types';
import {
  type BookAction,
  type BookActionKey,
  BookActionsMenu,
} from '@/components/library/books/book-actions';
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
import { readerHref } from '@/lib/paths';
import { WithActiveModules } from '@/modules/active-modules';
import type { PlayerModule } from '@/modules/registry';
import { canRead } from '@/reader/can-read';

import { type PrimaryAction, primaryLabel } from './book-page-model';

/** The book menu's items the hero's own buttons already are. */
const MENU_OMIT: readonly BookActionKey[] = ['play', 'queue', 'collect', 'download'];
/** A phone's: Add to collection is in the menu there (its button would leave the download
 * no room for its word at 390 and below). */
const MENU_OMIT_PHONE: readonly BookActionKey[] = ['play', 'queue', 'download'];

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
  /** Two rows on a phone: the primary, then the download and the icon buttons. */
  stacked: boolean;
  /** An admin's Bridge action (Phase 1a), when the page offers one: `generate` (a book
   * the community lacks characters or recaps for, none generated here yet, Phase 1e) is a
   * button after the others (its own row on a phone),
   * `regenerate` (a book with generated ones) quieter, in the book menu. */
  generate?: { offer: 'generate' | 'regenerate'; onPress: () => void };
  /** The modules to choose from (`src/modules/registry.ts`, the default; tests pass a
   * fake): the `bookActions` of each one the book's server has on go in the book menu. */
  modules?: readonly PlayerModule[];
};

/**
 * The hero's actions (the prototype's `hero-actions`): the primary (ink: Resume chapter
 * N, Start listening, Listen again, Pause), the download, Up next (Play next / Add to the
 * end, capability `queue`), favourite, Add to collection (capability `collections`) and
 * the book menu (mark finished or not, more in this series; on a phone Add to collection
 * too), Read for a book with an ebook (`canRead`), and for an admin "Generate
 * characters and recaps" (or Regenerate in the menu) where the page offers it. Nothing
 * here is pink: the hero's one pink thing is the progress bar. An active module's
 * `bookActions` (none yet) follow in the book menu.
 */
export function HeroActions(props: HeroActionsProps) {
  return (
    <WithActiveModules modules={props.modules} connectionId={props.connectionId}>
      {(active) => <HeroActionsView {...props} active={active} />}
    </WithActiveModules>
  );
}

function HeroActionsView({
  connectionId,
  libraryId,
  book,
  chapterData,
  chaptersLoading,
  progress,
  primary,
  onPrimary,
  stacked,
  generate,
  active,
}: HeroActionsProps & { active: readonly PlayerModule[] }) {
  const { t } = useTranslation();
  const path = book.rel_path;
  const collections = useCapability('collections', connectionId) === true;
  const ebooks = useCapability('ebooks', connectionId);
  const [collect, setCollect] = useState(false);
  const [sheet, setSheet] = useState(false);
  const menuExtra: BookAction[] = [
    ...(generate?.offer === 'regenerate'
      ? [
          {
            key: 'regenerate',
            icon: 'sparkles' as const,
            label: t('bridge.generate.regenerate'),
            onPress: generate.onPress,
            group: true,
          },
        ]
      : []),
    // A module's keys are its own (`<id>:<key>`): never one of the menu's, nor another's.
    ...active.flatMap((m) =>
      (m.bookActions?.({ connectionId, book }) ?? []).map((a) => ({
        ...a,
        key: `${m.id}:${a.key}`,
      })),
    ),
  ];
  const generateButton =
    generate?.offer === 'generate' ? (
      <Button
        testID="generate-action"
        variant="outline"
        size="lg"
        icon="sparkles"
        title={t('bridge.generate.action')}
        onPress={generate.onPress}
      />
    ) : null;

  // Read the book's ebook (Bridge Phase 3b): its own button after the download (its own
  // row on a phone), on the web until the app's reader host lands (Phase 3b-2).
  const readButton = canRead(ebooks, book, Platform.OS) ? (
    <Button
      testID="read-action"
      variant="outline"
      size="lg"
      icon="book-open"
      title={t('reader.read')}
      onPress={() => router.push(readerHref(connectionId, libraryId, path))}
    />
  ) : null;

  const primaryButton = (
    <Button
      size="lg"
      icon={primary.kind === 'pause' ? 'pause' : 'play'}
      title={primaryLabel(t, primary)}
      onPress={onPrimary}
    />
  );
  const download = (
    <DownloadControl
      libraryId={libraryId}
      path={path}
      book={book}
      chapterData={chapterData}
      disabled={chaptersLoading}
      short={stacked}
    />
  );
  const icons = (
    <>
      <UpNextMenu connectionId={connectionId} libraryId={libraryId} book={book} />
      <FavouriteButton connectionId={connectionId} libraryId={libraryId} path={path} />
      {collections && !stacked ? (
        <Button
          variant="outline"
          size="lg"
          icon="layers"
          className={ICON_BUTTON}
          accessibilityLabel={t('library.bookActions.collect')}
          onPress={() => setCollect(true)}
        />
      ) : null}
      {/* Renders nothing when all it would offer is the buttons above. */}
      <BookActionsMenu
        connectionId={connectionId}
        libraryId={libraryId}
        book={book}
        progress={progress ?? undefined}
        omit={stacked ? MENU_OMIT_PHONE : MENU_OMIT}
        extra={menuExtra}
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
    </>
  );

  return (
    <>
      {stacked ? (
        // A phone: the primary across the page (its words never wrap), then the rest on
        // ONE row: the download takes the room the icon buttons leave (Add to collection
        // is in the menu here), giving way (its words end in "...") rather than letting
        // them wrap onto a row of their own.
        <View className="gap-2">
          {primaryButton}
          <View testID="hero-secondary-row" className="flex-row items-center gap-2">
            <View testID="hero-download-slot" className="min-w-0 flex-1">
              {download}
            </View>
            {icons}
          </View>
          {readButton}
          {generateButton}
        </View>
      ) : (
        <View className="flex-row flex-wrap items-center gap-2">
          {primaryButton}
          {download}
          {readButton}
          {icons}
          {generateButton}
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
          className={ICON_BUTTON}
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
