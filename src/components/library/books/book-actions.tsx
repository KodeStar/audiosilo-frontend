import type { TriggerRef } from '@rn-primitives/dropdown-menu';
import { Fragment, type ReactElement, type Ref, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable } from 'react-native';

import {
  CapabilityError,
  useBook,
  useCapability,
  useEditProgress,
  useMarkFinished,
} from '@/api/hooks';
import type { Book, Progress } from '@/api/types';
import { RemoveDownloadConfirm } from '@/components/downloads/remove-download-confirm';
import { usePlayBook } from '@/components/player/use-play-book';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  afterOverlayCloses,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon, type IconName } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useDownloadControls } from '@/downloads/use-download-controls';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { AddToCollectionDialog } from '../collections/collection-dialogs';
import { useQueueActions } from '../use-queue-actions';
import { bookStatus, unfinishedPosition } from './books-view';

/** One entry of a book's actions menu. `group` starts a new section (a separator). */
export type BookAction = {
  key: string;
  icon: IconName;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  group?: boolean;
};

/** The download item by the book's download state. */
const DOWNLOAD_ACTION = {
  remove: { icon: 'trash', label: 'library.bookActions.removeDownload' },
  cancel: { icon: 'circle-stop', label: 'library.bookActions.cancelDownload' },
  start: { icon: 'download', label: 'library.bookActions.download' },
} as const satisfies Record<string, { icon: IconName; label: string }>;

type Target = { connectionId: string; libraryId: number; book: Book; progress?: Progress };

/** The dialogs an action opens, which the menu's owner renders. */
export type BookActionDialogs = { openCollect: () => void; confirmRemove: () => void };

/** Whether this browser's verdict on `book` is unknown: on web, a list-shape book (`/books`,
 * `/fs`, shelves, tiles) carries no `direct_playable`, so it may be one that only plays
 * transcoded here and cannot be downloaded. Its full item says. */
function playabilityUnknown(book: Book): boolean {
  return Platform.OS === 'web' && book.direct_playable === undefined;
}

/**
 * What can be done to a book from a list, each only where its server and this platform
 * allow it (a capability still unknown hides its item): Play or Resume, Add to / Remove
 * from Up next, Add to collection..., Download for offline / Remove download, Mark as
 * finished / not finished, More in this series. `openCollect` opens the Add to
 * collection dialog and `confirmRemove` the remove-download confirm, both rendered by
 * the caller (`BookActionsMenu`): removing a download asks first, as everywhere.
 *
 * On web a list-shape `book` is looked up in full once `opened` (the menu was shown; not
 * per row of a list), and Download waits for it: offered only when the browser plays
 * the book directly, so the menu never offers a download that would be refused.
 */
export function useBookActions(
  { connectionId, libraryId, book, progress }: Target,
  { openCollect, confirmRemove }: BookActionDialogs,
  opened = false,
): BookAction[] {
  const { t } = useTranslation();
  const path = book.rel_path;
  const play = usePlayBook();
  const { openSeries } = useOpen();
  const queue = useQueueActions(connectionId);
  const collections = useCapability('collections', connectionId) === true;
  const progressEdit = useCapability('progress_edit', connectionId);
  const edit = useEditProgress(connectionId);
  const markFinished = useMarkFinished(connectionId);
  const unknown = playabilityUnknown(book);
  // An empty path keeps the lookup off until it is wanted.
  const full = useBook(libraryId, unknown && opened ? path : '', connectionId);
  const known = unknown ? full.data : book;
  const download = useDownloadControls(libraryId, path, known ?? book, undefined, connectionId);
  const status = bookStatus(progress);

  const failed = (e: unknown) => {
    if (e instanceof CapabilityError) return;
    toast({ title: t('library.bookActions.failed') });
  };

  const setFinished = async (finished: boolean, position?: number) => {
    try {
      await edit.mutateAsync({ libraryId, path, edit: { finished, position } });
      return true;
    } catch (e) {
      failed(e);
      return false;
    }
  };

  const onFinish = async () => {
    if (progressEdit === true) {
      const before = progress?.position ?? 0;
      if (!(await setFinished(true))) return;
      toast({
        title: t('library.bookActions.markedFinished'),
        description: book.title,
        action: {
          label: t('queue.undo'),
          onPress: () => void setFinished(false, before),
        },
      });
      return;
    }
    // An older server: the offline-aware save at the book's end (no undo without
    // `progress_edit`, which is the only way to mark a book not finished).
    markFinished.mutate(
      { libraryId, path, position: book.duration, duration: book.duration },
      {
        onSuccess: () =>
          toast({ title: t('library.bookActions.markedFinished'), description: book.title }),
        onError: failed,
      },
    );
  };

  const onUnfinish = async () => {
    if (!(await setFinished(false, unfinishedPosition(progress, book.duration)))) return;
    toast({
      title: t('library.bookActions.markedUnfinished'),
      description: book.title,
      action: { label: t('queue.undo'), onPress: () => void setFinished(true) },
    });
  };

  const out: BookAction[] = [
    {
      key: 'play',
      icon: 'play',
      label: t(status === 'progress' ? 'library.bookActions.resume' : 'library.bookActions.play'),
      onPress: () =>
        void play({ connectionId, libraryId, path }, { viaBookPage: true }).catch(() =>
          toast({ title: t('library.bookActions.playFailed') }),
        ),
    },
  ];
  if (queue.supported) {
    const queued = queue.isQueued(libraryId, path);
    out.push({
      key: 'queue',
      icon: 'queue',
      label: t(queued ? 'queue.removeLabel' : 'queue.addLabel'),
      onPress: () => void (queued ? queue.unqueue(libraryId, path) : queue.queue(libraryId, path)),
    });
  }
  if (collections) {
    out.push({
      key: 'collect',
      icon: 'layers',
      label: t('library.bookActions.collect'),
      onPress: openCollect,
    });
  }
  const s = download.status;
  // A download already there stays manageable; a new one waits for the verdict.
  if (download.supported && (known || (s !== undefined && s !== 'error'))) {
    const state =
      s === 'downloaded' ? 'remove' : s === 'downloading' || s === 'queued' ? 'cancel' : 'start';
    const run = {
      remove: confirmRemove,
      cancel: download.cancel,
      start: () => {
        download.start();
        toast({ title: t('library.bookActions.downloading'), description: book.title });
      },
    }[state];
    out.push({
      key: 'download',
      ...DOWNLOAD_ACTION[state],
      label: t(DOWNLOAD_ACTION[state].label),
      onPress: run,
    });
  }
  if (status === 'finished') {
    if (progressEdit === true) {
      out.push({
        key: 'finish',
        icon: 'rotate',
        label: t('library.bookActions.markUnfinished'),
        onPress: () => void onUnfinish(),
        group: true,
      });
    }
  } else if (progressEdit !== undefined) {
    out.push({
      key: 'finish',
      icon: 'circle-check',
      label: t('library.bookActions.markFinished'),
      onPress: () => void onFinish(),
      group: true,
    });
  }
  if (book.series) {
    out.push({
      key: 'series',
      icon: 'library',
      label: t('library.bookActions.moreInSeries'),
      onPress: () => openSeries(connectionId, libraryId, { name: book.series }),
      group: !out.some((a) => a.group),
    });
  }
  return out;
}

/**
 * A book's actions (`useBookActions`, plus any `extra` the screen adds - a collection's
 * Move up / Remove), presented for the form factor: a dropdown menu on `trigger` on
 * tablet and desktop, the same items in a bottom sheet on a phone (`sheetOpen`). It
 * also renders the dialogs the actions open (Add to collection, the remove-download
 * confirm). `BookActionsButton` gives it a visible "..." trigger; a cover tile a hidden
 * anchor it opens through `triggerRef` (`TileActions`).
 */
export function BookActionsMenu({
  connectionId,
  libraryId,
  book,
  progress,
  extra = [],
  trigger,
  triggerRef,
  sheetOpen,
  onSheetOpenChange,
  onCloseAutoFocus,
}: Target & {
  extra?: BookAction[];
  trigger: ReactElement;
  triggerRef?: Ref<TriggerRef>;
  sheetOpen: boolean;
  onSheetOpenChange: (open: boolean) => void;
  /** Web: where focus goes when the menu closes (default: back to the trigger). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const phone = useLayout() === 'phone';
  const [collect, setCollect] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Shown once (the sheet, or the menu): what the actions look up waits for it.
  const [opened, setOpened] = useState(false);
  if (sheetOpen && !opened) setOpened(true);
  const actions = [
    ...useBookActions(
      { connectionId, libraryId, book, progress },
      { openCollect: () => setCollect(true), confirmRemove: () => setRemoving(true) },
      opened,
    ),
    ...extra,
  ];
  return (
    <>
      {phone ? (
        trigger
      ) : (
        <DropdownMenu onOpenChange={(open) => open && setOpened(true)}>
          <DropdownMenuTrigger ref={triggerRef} asChild>
            {trigger}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={onCloseAutoFocus}>
            {actions.map((a) => (
              <Fragment key={a.key}>
                {a.group ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  icon={a.icon}
                  variant={a.destructive ? 'destructive' : 'default'}
                  onPress={a.onPress}
                >
                  <Text>{a.label}</Text>
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {phone ? (
        <Dialog open={sheetOpen} onOpenChange={onSheetOpenChange}>
          <DialogContent className="gap-2 px-3">
            <DialogHeader className="px-3 pb-1 pr-12">
              <DialogTitle numberOfLines={2}>{book.title}</DialogTitle>
            </DialogHeader>
            {actions.map((a) => (
              <Pressable
                key={a.key}
                accessibilityRole="button"
                onPress={() => {
                  onSheetOpenChange(false);
                  // The sheet is a dialog too: an action's own dialog opens once it closed.
                  afterOverlayCloses(a.onPress);
                }}
                className={cn(
                  'min-h-[48px] flex-row items-center gap-3 rounded-xl px-3 active:bg-accent',
                  a.group && 'mt-2',
                  Platform.select({
                    web: FOCUS_RING_CLASS,
                  }),
                )}
              >
                <Icon
                  name={a.icon}
                  size={18}
                  color={a.destructive ? themed.destructive : themed.mutedForeground}
                />
                <Text
                  className={cn(
                    'font-sans-medium text-[15px]',
                    a.destructive && 'text-destructive',
                  )}
                >
                  {a.label}
                </Text>
              </Pressable>
            ))}
          </DialogContent>
        </Dialog>
      ) : null}
      {collect ? (
        <AddToCollectionDialog
          open={collect}
          onOpenChange={setCollect}
          connectionId={connectionId}
          libraryId={libraryId}
          path={book.rel_path}
          title={book.title}
        />
      ) : null}
      <RemoveDownloadConfirm
        target={
          removing ? { connectionId, libraryId, path: book.rel_path, title: book.title } : null
        }
        onClose={() => setRemoving(false)}
        onRemoved={() =>
          toast({ title: t('library.bookActions.downloadRemoved'), description: book.title })
        }
      />
    </>
  );
}

/**
 * A book's "..." button and its actions (`BookActionsMenu`). Sits beside (never inside)
 * the row's own press target.
 */
export function BookActionsButton({ extra, ...target }: Target & { extra?: BookAction[] }) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const [sheet, setSheet] = useState(false);
  return (
    <BookActionsMenu
      {...target}
      extra={extra}
      sheetOpen={sheet}
      onSheetOpenChange={setSheet}
      trigger={
        <Button
          variant="ghost"
          size="icon"
          icon="ellipsis"
          accessibilityLabel={t('library.bookActions.more', { title: target.book.title })}
          onPress={phone ? () => setSheet(true) : undefined}
        />
      }
    />
  );
}
