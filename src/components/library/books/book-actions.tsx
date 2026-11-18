import type { TriggerRef } from '@rn-primitives/dropdown-menu';
import { Fragment, type ReactElement, type Ref, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable } from 'react-native';

import {
  CapabilityError,
  useBook,
  useCapability,
  useEditProgress,
  useIsPodcastLibrary,
  useMarkFinished,
  qk,
} from '@/api/hooks';
import type { Book, PodcastFetchStatus, Progress } from '@/api/types';
import { useCachedQueryData } from '@/api/use-cached-query-data';
import { RemoveDownloadConfirm } from '@/components/downloads/remove-download-confirm';
import { usePlayBook } from '@/components/player/use-play-book';
import { episodeRowState, offersEpisodeDownload } from '@/components/podcasts/podcast-model';
import { usePendingEpisodeFetch } from '@/components/podcasts/use-pending-episode-fetch';
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
import { dismissToast, toast } from '@/components/ui/toast';
import { playFailedToast } from '@/components/player/play-failed';
import { useDownloadControls } from '@/downloads/use-download-controls';
import type { PendingEpisodeFetch } from '@/playback/episode-fetch';
import {
  finishTakesEvent,
  leaveFinishedBook,
  reloadLeftBook,
  undoFinish,
} from '@/playback/finish-route';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { useLatestRef } from '@/lib/use-latest';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';
import { useSendToWatch } from '@/watch/use-watch';

import { AddToCollectionDialog } from '../collections/collection-dialogs';
import { useQueueActions } from '../use-queue-actions';
import { bookStatus, unfinishedPosition } from './books-view';

/** The keys of `useBookActions`' own items (a screen's `extra` brings its own, as a
 * module's `bookActions` do through the book page's `extra`). Closed on purpose: it stays so
 * until a module needs one of its own here (Bridge Phase 2d). */
export type BookActionKey =
  'play' | 'queue' | 'collect' | 'download' | 'watch' | 'finish' | 'series';

/** One entry of a book's actions menu. `group` starts a new section (a separator). */
export type BookAction<K extends string = string> = {
  key: K;
  icon: IconName;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  group?: boolean;
};

/** How long a Mark as finished waits on its server before a toast says it is on its way. */
const PENDING_TOAST_MS = 600;

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

/** The menu's download item for `book` (`known`: its full item when it was looked up, else
 * the book as given, null while a lookup it waits for is on its way). A book: always. An
 * item of a podcast library: only once it is known to be an episode (a list shape carries no
 * `episode`; a show's folder is never one), and by the episode page's rule
 * (`offersEpisodeDownload`: not while it is not available, from `podcastFetch`, its fetch
 * status and the player's `pending` fetch of it). */
function offersDownload(
  known: Book | null,
  podcastLibrary: boolean,
  podcastFetch: boolean | undefined,
  pending: PendingEpisodeFetch | null,
): boolean {
  if (!known) return false;
  if (!known.episode) return !podcastLibrary;
  return offersEpisodeDownload(
    known.episode,
    episodeRowState(known.episode, pending, podcastFetch),
  );
}

/**
 * What can be done to a book from a list, each only where its server and this platform
 * allow it (a capability still unknown hides its item): Play or Resume, Add to / Remove
 * from Up next, Add to collection..., Download for offline / Remove download (a podcast
 * episode too, fe#166: `offersDownload`), Send to watch (iOS, a paired watch with the app,
 * `useSendToWatch`; never an episode), Mark as finished / not finished, More
 * in this series. `openCollect` opens the Add to
 * collection dialog and `confirmRemove` the remove-download confirm, both rendered by
 * the caller (`BookActionsMenu`): removing a download asks first, as everywhere.
 *
 * On web a list-shape `book` is looked up in full once `opened` (the menu was shown; not
 * per row of a list), and Download waits for it: offered only when the browser plays
 * the book directly, so the menu never offers a download that would be refused. So is an
 * item of a podcast library given without its `episode` (a tile's list shape), everywhere.
 */
export function useBookActions(
  { connectionId, libraryId, book, progress }: Target,
  { openCollect, confirmRemove }: BookActionDialogs,
  opened = false,
): BookAction<BookActionKey>[] {
  const { t } = useTranslation();
  const path = book.rel_path;
  const play = usePlayBook();
  const { openSeries } = useOpen();
  const queue = useQueueActions(connectionId);
  const collections = useCapability('collections', connectionId) === true;
  const progressEdit = useCapability('progress_edit', connectionId);
  const edit = useEditProgress(connectionId);
  const markFinished = useMarkFinished(connectionId);
  // An item of a podcast library: by the item's `episode`, or for a list-shape book, by its
  // library's kind (never sent to a watch; downloaded once known to be an episode).
  const podcastLibrary = useIsPodcastLibrary(libraryId, connectionId);
  const podcastFetch = useCapability('podcast_fetch', connectionId);
  // The player's fetch of this item, when it is the one on its way (what the episode page reads).
  const pending = usePendingEpisodeFetch(connectionId, libraryId, path);
  const unknown = playabilityUnknown(book) || (podcastLibrary && !book.episode);
  // An empty path keeps the lookup off until it is wanted.
  const full = useBook(libraryId, unknown && opened ? path : '', connectionId);
  const known = unknown ? full.data : book;
  // A list row's `episode.fetch` is as old as the list; the episode page and the player's
  // fetch keep the live status in the cache. Followed there once the menu opened (no
  // observer per row, never asked from here), so the menu offers what the page does (fe#280).
  const live = useCachedQueryData<PodcastFetchStatus>(
    opened &&
      !!known?.episode &&
      !known.episode.downloaded &&
      qk.podcastFetch(connectionId, libraryId, path),
  );
  const current =
    live && known?.episode ? { ...known, episode: { ...known.episode, fetch: live } } : known;
  const download = useDownloadControls(libraryId, path, known ?? book, undefined, connectionId);
  const episode = podcastLibrary || !!(known ?? book).episode;
  const status = bookStatus(progress);
  const sendToWatch = useSendToWatch(connectionId, libraryId);

  const failed = (e: unknown) => {
    if (e instanceof CapabilityError) return;
    toast({ title: t('library.bookActions.failed') });
  };

  const ref = { connectionId, libraryId, path };
  // The progress of the latest render: a Retry of Mark as not finished, pressed later, takes
  // its place from the progress read since, not the one the failed tap saw (another device
  // may have moved the book).
  const latestProgress = useLatestRef(progress);

  // Mark the book finished by the route its server takes; resolves to whether it was. A
  // server that takes listening events: a `finish` event, offline too (fe#208), in the outbox
  // behind the close of the span the book was left with. Never a progress edit there: sent
  // over HTTP beside the outbox, it reached the server before that span did. An older server
  // with progress edits: the edit (no span waits there, and Undo is an edit too); one without:
  // the offline-aware save at the book's end.
  const recordFinished = async (): Promise<boolean> => {
    try {
      if (progressEdit === true && !finishTakesEvent(connectionId)) {
        await edit.mutateAsync({ libraryId, path, edit: { finished: true } });
      } else {
        await markFinished.mutateAsync({
          libraryId,
          path,
          position: book.duration,
          duration: book.duration,
        });
      }
      return true;
    } catch (e) {
      failed(e);
      return false;
    }
  };

  // Not finished, at `position` (the Undo of Mark as finished, and Mark as not finished);
  // resolves to whether it was. A finish event still waiting in the outbox is taken back
  // before the edit (fe#208): sent after it, it finished the book again. One the server may
  // hold while it looks down can't be undone (fe#258): the book stays finished, and a toast
  // titled `unreachable` offers `retry`.
  const unfinish = async (
    position: number,
    unreachable: string,
    retry: () => void,
  ): Promise<boolean> => {
    const outcome = await undoFinish({ ...ref, position }, () =>
      edit.mutateAsync({ libraryId, path, edit: { finished: false, position } }),
    ).catch((e: unknown) => {
      failed(e);
      return null;
    });
    if (outcome === 'unreachable') {
      toast({
        title: unreachable,
        description: book.title,
        action: { label: t('common.retry'), onPress: retry },
      });
    }
    return outcome === 'undone';
  };

  // Finished again (the Undo of Mark as not finished), the loaded book (or one starting)
  // stopped and unloaded first, its place saved (fe#258); a finish that failed loads it
  // again where it was (FE-1): left unloaded, the failure stopped the listening for nothing.
  const finishAgain = async () => {
    await leaveFinishedBook(ref);
    if (!(await recordFinished())) await reloadLeftBook(ref);
  };

  const onFinish = async () => {
    // A finish that waits on its server says so (FE-1): the menu has closed, and nothing
    // else shows the request. Only when it is slow, so a quick one shows one toast.
    let pending: number | null = null;
    const slow = setTimeout(() => {
      pending = toast({ title: t('library.bookActions.markingFinished'), duration: 15_000 });
    }, PENDING_TOAST_MS);
    const settled = () => {
      clearTimeout(slow);
      if (pending !== null) dismissToast(pending);
    };
    // The loaded book stops first, its place saved before the finish (fe#258). That place is
    // the one Undo goes back to: the page's progress was read before that listening, and with
    // the book unloaded no later save moves an Undo there.
    const left = await leaveFinishedBook(ref);
    const before = left ?? progress?.position ?? 0;
    // Undo is a progress edit (`progress_edit`): the only way to mark a book not finished
    // at the place it had.
    const canUndo = progressEdit === true;
    const undo = () => void unfinish(before, t('library.bookActions.undoUnreachable'), undo);
    const done = () =>
      toast({
        title: t('library.bookActions.markedFinished'),
        description: book.title,
        action: canUndo ? { label: t('queue.undo'), onPress: undo } : undefined,
      });
    const ok = await recordFinished().finally(settled);
    if (ok) done();
    else await reloadLeftBook(ref);
  };

  const onUnfinish = async () => {
    const position = unfinishedPosition(latestProgress.current, book.duration);
    const unreachable = t('library.bookActions.unfinishUnreachable');
    if (!(await unfinish(position, unreachable, () => void onUnfinish()))) return;
    toast({
      title: t('library.bookActions.markedUnfinished'),
      description: book.title,
      // Finished again: a book started since stops first, as on Mark as finished (FE-1).
      action: { label: t('queue.undo'), onPress: () => void finishAgain() },
    });
  };

  const out: BookAction<BookActionKey>[] = [
    {
      key: 'play',
      icon: 'play',
      label: t(status === 'progress' ? 'library.bookActions.resume' : 'library.bookActions.play'),
      onPress: () =>
        void play({ connectionId, libraryId, path }, { viaBookPage: true }).catch((err) =>
          playFailedToast(err),
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
  if (
    download.supported &&
    (offersDownload(current ?? null, podcastLibrary, podcastFetch, pending) ||
      (s !== undefined && s !== 'error'))
  ) {
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
  if (sendToWatch && !episode) {
    out.push({
      key: 'watch',
      icon: 'watch',
      label: t('library.bookActions.sendToWatch'),
      onPress: () => sendToWatch(book),
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
 * anchor it opens through `triggerRef` (`TileActions`). `omit` leaves out items by key
 * (the book page, whose own buttons already play, queue, collect and download). With
 * nothing left to offer it renders nothing, its trigger included.
 */
export function BookActionsMenu({
  connectionId,
  libraryId,
  book,
  progress,
  extra = [],
  omit = [],
  trigger,
  triggerRef,
  sheetOpen,
  onSheetOpenChange,
  onCloseAutoFocus,
}: Target & {
  extra?: BookAction[];
  omit?: readonly BookActionKey[];
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
    ).filter((a) => !omit.includes(a.key)),
    ...extra,
  ];
  if (actions.length === 0) return null;
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
            {actions.map((a, i) => (
              <Fragment key={a.key}>
                {a.group && i > 0 ? <DropdownMenuSeparator /> : null}
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
                    'font-sans-medium text-[15px] web:text-[0.9375rem]',
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
 * A book's "..." button and its actions (`BookActionsMenu`, `omit` leaving items out).
 * Sits beside (never inside) the row's own press target.
 */
export function BookActionsButton({
  extra,
  omit,
  ...target
}: Target & { extra?: BookAction[]; omit?: readonly BookActionKey[] }) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const [sheet, setSheet] = useState(false);
  return (
    <BookActionsMenu
      {...target}
      extra={extra}
      omit={omit}
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
