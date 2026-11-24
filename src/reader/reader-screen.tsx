import {
  type ComponentRef,
  memo,
  type ReactNode,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppState,
  FlatList,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type ScrollViewInstance,
} from 'react-native';
import Animated, {
  ReduceMotion,
  SlideInUp,
  SlideOutUp,
  useReducedMotion,
} from 'react-native-reanimated';
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { ApiError, isSignedOutError } from '@/api/client';
import { useBook, useCapability, useReadingPlace } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { SignInAgainState, useSignedOutConnection } from '@/components/layout/sign-in-again';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Notice } from '@/components/ui/notice';
import { useBehindModalProps } from '@/components/ui/modal-layer';
import { Sheet } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useDownloadedEbook } from '@/downloads/store';
import type { Connection } from '@/stores/session';
import { backOrHome } from '@/lib/back-or-home';
import { useHeldTopInset } from '@/lib/held-top-inset';
import { type ShortcutKey, useGlobalShortcut } from '@/lib/keyboard';
import { bookTitle } from '@/lib/paths';
import { useScreenReader } from '@/lib/screen-reader';
import { scaleCapped, useFontScale } from '@/lib/text-scale';
import { useLatest } from '@/lib/use-latest';
import { usePageTitle } from '@/lib/use-page-title';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { canRead } from './can-read';
import { EbookStorageError, EbookTooLargeError } from './ebook-errors';
import { hasLocalEbook } from './ebook-file';
import { useNarration } from './narration';
import { FollowPill, followPillRoom, PageEdges, turnPage, usePageEdges } from './page-edge';
import type { ReaderPlace, TocEntry } from './protocol';
import { useReaderChrome } from './reader-chrome';
import { ReaderHost } from './reader-host';
import { type ReaderHostEvent, type ReaderHostHandle, ReaderStartError } from './reader-host-types';
import {
  FONT_SCALES,
  READER_THEMES,
  loadAutoHide,
  type ReaderThemeChoice,
  saveAutoHide,
  saveFontScale,
  stepFontScale,
} from './reader-settings';
import { useBookReadalong } from './use-book-readalong';
import { useReaderAppearance } from './use-reader-appearance';
import {
  adoptServerPlace,
  flushReadingQueue,
  type JumpOffer,
  jumpOffer,
  onReadingRefused,
  onReadingSaved,
  type ReadingPlaceLookup,
  type ReadingSaved,
  saveReaderPlace,
} from './reading-progress';

/** How long the reader rests on a page before its place is saved. */
const SAVE_DEBOUNCE_MS = 2000;
/** A section that lays out quicker than this shows no spinner. */
const SPINNER_DELAY_MS = 300;

/** A late save may report the same version while the reader is writing its acknowledgement. */
function latestAnswer(previous: ReadingSaved | null, incoming: ReadingSaved): ReadingSaved {
  if (!previous) return incoming;
  const before = previous.saved.reading_progress.version;
  const after = incoming.saved.reading_progress.version;
  if (before === after && previous.seen) return previous;
  return before > after ? previous : incoming;
}

/** Why the reader shows a message instead of the book. `signedOut`: the server refused the
 * session (a 401), shown as the sign-in state with Reconnect while the connection needs
 * signing in again; `section`: a part of the open book did not load; `tooLarge`: the EPUB is
 * over the size the app's reader takes; `storage`: the device had no room for it, or its
 * cache could not be written (fe#172). */
type ReaderFailure =
  | 'drm'
  | 'unreadable'
  | 'tooLarge'
  | 'storage'
  | 'missing'
  | 'fetch'
  | 'start'
  | 'noEbook'
  | 'signedOut'
  | 'section';

/** The failures Try again can mend (`storage` once there is room). */
const RETRYABLE: readonly ReaderFailure[] = ['fetch', 'start', 'section', 'storage'];

type Place = { cfi: string; fraction: number; sectionLabel: string };

/** Why loading failed, as the reader says it: the reader document never started, the
 * sign-in ended, the book is gone, it is too large for the reader, the device could not keep
 * it, or the server gave no answer (for the book, or where it opens). */
const loadFailure = (e: unknown): ReaderFailure =>
  e instanceof ReaderStartError
    ? 'start'
    : isSignedOutError(e)
      ? 'signedOut'
      : e instanceof ApiError && e.status === 404
        ? 'missing'
        : e instanceof EbookTooLargeError
          ? 'tooLarge'
          : e instanceof EbookStorageError
            ? 'storage'
            : 'fetch';

/**
 * The ebook reader (Bridge Phase 3b, the `/read` root modal): a top bar (close, the
 * book's title, the chapter and how far in, the contents and the text size), the book in
 * the reader host (`ReaderHost`: the web's sandboxed iframe, the app's WebView), page edges to turn by, and
 * the "Jump there?" offer when another device kept a further place. The place is saved
 * through the reading-progress queue two seconds after the reader stops on a page, and at
 * once on close or when the app goes to the background. While the book is the one playing
 * and has a read-along map (Bridge Phase 3c), "Follow narration" follows the sentence being
 * read; no place is saved while it follows (the narration moves the page, not the reader),
 * and saving resumes once the listener turns away from it.
 *
 * The EPUB, the read-along map and where the book opens are fetched at once (fe#164): the
 * host starts on the book while the place is looked up (`placeKnown`).
 *
 * Immersive mode (fe#246, `useReaderChrome`): the top bar lies over the page and hides a few
 * seconds after it shows or at the first page turn, the status bar with it in the apps; a tap
 * in the middle of the page shows it again, as (web) the keyboard's focus on the screen's own
 * controls does. Off in the reader menu, and never with a screen reader on: the bar then
 * sits above the page. The web cannot tell a screen reader is on, so there the hidden bar
 * stays in the page, slid off its top, ahead of the book in the focus order.
 */
export function ReaderScreen({
  connectionId,
  libraryId,
  path,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const api = useOptionalApi(connectionId);
  // The connection while it needs signing in again: a load that failed then is the sign-in
  // state with Reconnect, never a Try again that cannot work (CONNECT-04).
  const signedOut = useSignedOutConnection(connectionId);
  const {
    data: book,
    isError: bookFailed,
    error: bookError,
    refetch: refetchBook,
  } = useBook(libraryId, path, connectionId);
  const ebooks = useCapability('ebooks', connectionId);
  // The download's EPUB: readable with the capability unknown (offline), and where an
  // offline lookup with no place here opens at the start.
  const savedEbook = useDownloadedEbook(connectionId, libraryId, path);
  const readable = canRead(ebooks, book, !!savedEbook);
  const ebookSize = book?.ebook?.size;
  const localRef = { connectionId, libraryId, path, size: ebookSize, saved: savedEbook };
  // The app's cache file counts only when this screen's host did not fetch it: the host
  // starts fetching while the place is looked up (fe#164), and a copy this screen fetched is
  // no sign the book was read on this device, so it never makes an offline lookup open at a
  // guessed start. The host says so as its fetch starts (`onFetch`, fe#193), before any file
  // of it exists. A download's EPUB answers on its own.
  const fetchedHere = useRef(false);
  const hasLocalCopy = useLatest(() =>
    !savedEbook && fetchedHere.current ? Promise.resolve(false) : hasLocalEbook(localRef),
  );
  const place = useReadingPlace(libraryId, path, connectionId, readable, hasLocalCopy);
  usePageTitle(book ? bookTitle(book.title, path) : undefined);

  const host = useRef<ReaderHostHandle>(null);
  // Read-along (Bridge Phase 3c): the narration, and the map while this book is the one
  // the player holds. The map is asked for and goes to the reader only then: another book
  // playing has nothing to follow here.
  const narration = useNarration({ connectionId, libraryId, path }, host);
  const {
    map: readalongMap,
    ebookSha256: mapEbookSha,
    onEbook,
  } = useBookReadalong({ connectionId, libraryId, path }, book, readable, narration.narrating);
  // What the reader made of the map, and whether it follows the narration (null: it never
  // has, for this map).
  const [readalongOk, setReadalongOk] = useState(false);
  const following = useRef(false);
  const [followingShown, setFollowingShown] = useState<boolean | null>(null);
  if (!readalongMap && (readalongOk || followingShown !== null)) {
    setReadalongOk(false);
    setFollowingShown(null);
  }
  // Nor does anything follow without a map: a reader document that was not there to say
  // so (one that failed, or not ready yet) never follows when it comes.
  useEffect(() => {
    if (!readalongMap) following.current = false;
  }, [readalongMap]);

  const { theme, themeChoice, chooseTheme, fontScale, setFontScale } = useReaderAppearance();
  const changeFontScale = (direction: -1 | 1) => {
    const next = stepFontScale(fontScale ?? 1, direction);
    setFontScale(next);
    void saveFontScale(next);
  };
  // Immersive mode (fe#246): the top bar hides while reading, unless turned off on this
  // device (null until read) or a screen reader is on.
  const [autoHide, setAutoHide] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void loadAutoHide().then((on) => {
      if (live) setAutoHide(on);
    });
    return () => {
      live = false;
    };
  }, []);
  const chooseAutoHide = (on: boolean) => {
    setAutoHide(on);
    void saveAutoHide(on);
  };
  const screenReader = useScreenReader();
  // The bar lies over the page while it can hide, so showing and hiding it never lays the
  // book out again; else it sits above the page, as it always did. The book waits for the
  // choice (`ready`), so it is never laid out twice for it.
  const autoHideOn = autoHide === true;
  const immersive = autoHideOn && !screenReader;
  // The status bar hides with the top bar in the apps. In immersive mode the room above the
  // page keeps the most it was for this window size, so the status bar going never lays the
  // book out again either. The size is the insets' own frame, which comes with them (the
  // window's dimensions come apart from them: a rotation would hold the last
  // orientation's inset).
  const heldTop = useHeldTopInset(insets.top, useSafeAreaFrame());
  const topInset = immersive ? heldTop : insets.top;
  const reduced = useReducedMotion();
  const focused = useIsFocused();

  const [opened, setOpened] = useState<{ title: string; toc: TocEntry[]; rtl: boolean } | null>(
    null,
  );
  // The book showed on this screen once: a reopen that fails then is not a bad file.
  const shownOnce = useRef(false);
  // The next `progress` is where the book landed on opening (the start of the page the
  // saved place falls on), not a move: saving it would pull a place read at another page
  // size back to this page's start (fe#172). The first move saves.
  const landing = useRef(false);
  // Whether the reader moved since it opened: until then where it is is that landing, and a
  // Stay saves the place it opened at instead.
  const moved = useRef(false);
  const [current, setCurrent] = useState<Place | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<ReaderFailure | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const spinner = useDelayed(loading || (!opened && !failure), SPINNER_DELAY_MS);

  // Where it opens: decided once, when the place lookup first settles (set while
  // rendering, React's pattern for state that follows a prop). Opening at the server's row
  // means this device has now seen that version, so its saves are made on it. A row it has
  // not seen, opening at a local place (`unseen`), is the open's answer: Jump there is
  // offered at once, as a save's answer would (fe#173), unless a newer answer was heard
  // while the place was looked up (a close-save still on its way as the book reopened).
  const [opening, setOpening] = useState<ReadingPlaceLookup | null>(null);
  const [answer, recordAnswer] = useReducer(latestAnswer, null);
  if (!opening && place.data) {
    setOpening(place.data);
    const unseen = place.data.unseen;
    if (unseen) {
      recordAnswer({
        connectionId,
        libraryId,
        path,
        saved: { reading_progress: unseen },
        seen: false,
      });
    }
  }
  // Where Try again reopens: where the reader was, not where this screen first opened.
  const [resumeAt, setResumeAt] = useState<ReaderPlace>();
  const at =
    resumeAt ??
    (opening?.place ? { cfi: opening.place.cfi, fraction: opening.place.progression } : undefined);
  useEffect(() => {
    if (opening?.fromServer)
      void adoptServerPlace(connectionId, libraryId, path, opening.fromServer);
  }, [opening, connectionId, libraryId, path]);

  useEffect(() => {
    void flushReadingQueue();
  }, []);

  // --- saving the place ---------------------------------------------------------------
  const pending = useRef<{ cfi: string; progression: number } | null>(null);
  const lastSaved = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Where the reader is now (the latest `progress`), for the save once it stops following.
  const atNow = useRef<{ cfi: string; progression: number } | null>(null);
  const scheduleSave = (next: { cfi: string; progression: number }) => {
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  };
  /** Drop the save waiting for its debounce, if any. */
  const cancelSave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  };
  // The reader follows the narration (`onFollowing`): no place is saved meanwhile (the
  // narration turns the pages; a save would carry another device's reading along with
  // it). Once the listener turns away, where they are is saved, and every move after.
  const onFollowing = (value: boolean) => {
    const was = following.current;
    following.current = value;
    setFollowingShown(value);
    if (value) {
      cancelSave();
      return;
    }
    if (atNow.current) scheduleSave(atNow.current);
    // The reader turned the page away from the narration: its `progress` came first, while
    // still following, so the turn counts for the top bar here.
    if (was) chrome.pageTurned();
  };
  const flushSave = useLatest(() => {
    const next = pending.current;
    cancelSave();
    if (!next || next.cfi === lastSaved.current) return;
    lastSaved.current = next.cfi;
    void saveReaderPlace(api, connectionId, libraryId, path, next);
  });
  useEffect(() => {
    if (opening?.place) lastSaved.current = opening.place.cfi;
  }, [opening]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') flushSave();
    });
    return () => {
      sub.remove();
      flushSave();
    };
  }, [flushSave]);

  // A save the server refused (the sign-in ended, the access went): the place is kept on
  // this device only, and the reader says so until a save of the book goes through. OK puts
  // it away until then (each page's save is refused again meanwhile); the sign-in row stays
  // while the sign-in has ended, Reconnect being the way out.
  const [unsaved, setUnsaved] = useState<'shown' | 'dismissed' | null>(null);
  useEffect(
    () =>
      onReadingRefused((heard) => {
        if (sameBook(heard, connectionId, libraryId, path)) {
          setUnsaved((was) => (was === 'dismissed' ? was : 'shown'));
        }
      }),
    [connectionId, libraryId, path],
  );

  // --- "Jump there?" --------------------------------------------------------------------
  // The latest answered save of this book (by the server's version: an answer that lands
  // late never replaces a newer one; the open's `unseen` row keeps the same order, above). It is
  // judged against the page on screen once the book shows, below: the queue's replay can
  // answer before the first page.
  useEffect(
    () =>
      onReadingSaved((heard) => {
        if (!sameBook(heard, connectionId, libraryId, path)) return;
        setUnsaved(null);
        recordAnswer(heard);
      }),
    [connectionId, libraryId, path],
  );

  const noEbook = book !== undefined && (ebooks === false || !book.ebook);
  // The book, or where it opens, could not be fetched: said, never a guessed start (one
  // saved over a place read elsewhere would replace it).
  const unfetched: ReaderFailure | null =
    bookFailed && book === undefined
      ? loadFailure(bookError)
      : place.isError && !opening
        ? loadFailure(place.error)
        : null;
  const shown: ReaderFailure | null = failure ?? (noEbook ? 'noEbook' : unfetched);
  const show = shown === null && opened !== null;

  // The top bar in immersive mode (fe#246): held on screen while a menu or the contents from
  // it are open, or (the web) the keyboard's focus is on the screen's own controls (the bar,
  // the page edges, the cards), never the book's: a keyboard user tabbing out of the book
  // brings the hidden bar back, as a centre tap does. So does any focus arriving in the
  // hidden bar (`focusHoldsBar`).
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const topBar = useRef<ComponentRef<typeof View>>(null);
  const chrome = useReaderChrome({
    autoHide: autoHideOn,
    screenReader,
    reading: show,
    menuOpen: tocOpen || menuOpen || focusIn,
  });

  const onMessage = (message: ReaderHostEvent) => {
    switch (message.type) {
      case 'opened':
        shownOnce.current = true;
        landing.current = true;
        moved.current = false;
        setOpened({ title: message.title, toc: message.toc, rtl: message.rtl });
        return;
      case 'progress':
        setCurrent({
          cfi: message.cfi,
          fraction: message.fraction,
          sectionLabel: message.sectionLabel,
        });
        // A relayout (a rotation, a resize, a new text size) is no move: the page it lands on
        // can start a little before the place, and saving it pulled the place back with
        // every one (fe#172). Shown, while where the reader is stays the place it held.
        if (message.relayout) return;
        atNow.current = { cfi: message.cfi, progression: message.fraction };
        if (landing.current) {
          landing.current = false;
          return;
        }
        moved.current = true;
        // The narration's page turns are not the reader's: the bar stays as it is.
        if (following.current) return;
        chrome.pageTurned();
        scheduleSave(atNow.current);
        return;
      case 'loading':
        setLoading(message.value);
        return;
      case 'error':
        if (message.code === 'runtime') console.warn('[reader]', message.message);
        // A part of the open book did not load (fe#164): said, with Try again.
        else if (message.code === 'section') setFailure('section');
        // A reopen that fails is not a bad file (the same file opened before): it is said
        // as a reader that stopped, with Try again.
        else if (!opened) setFailure(shownOnce.current ? 'start' : message.code);
        return;
      case 'escape':
        // Escape pressed in the book: the frame keeps its keys from the shortcut below.
        if (!tocOpen) backOrHome();
        return;
      case 'centreTap':
        chrome.centreTapped();
        return;
    }
  };
  const onLoadError = (e: unknown) => setFailure(loadFailure(e));

  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    setFailure(null);
    // The new host shows the book with its next `opened` (no edges over it till then),
    // where the reader was.
    setOpened(null);
    setReadalongOk(false);
    // Its reader document has never followed (this screen sends no follow by itself): the
    // place is saved again, and "Follow narration" asks.
    following.current = false;
    setFollowingShown(null);
    // Where it was is the place it held, as Stay saves it: never the page a relayout or the
    // landing showed, which can start a little before that place (fe#172).
    const held = moved.current ? atNow.current : null;
    if (held) setResumeAt({ cfi: held.cfi, fraction: held.progression });
    else if (!at && current) setResumeAt({ cfi: current.cfi, fraction: current.fraction });
    setAttempt((n) => n + 1);
    if (bookFailed) void refetchBook();
    if (place.isError) void place.refetch();
  };

  const gotoEntry = useLatest((href: string) => {
    setTocOpen(false);
    host.current?.goto({ href });
  });

  const shortcuts = Platform.OS === 'web' && !tocOpen;
  // An RTL book's next page is on the left: the page edges and the arrows follow the book.
  const rtl = opened?.rtl === true;
  const turnLeft = () => turnPage(host, rtl, 'left');
  const turnRight = () => turnPage(host, rtl, 'right');
  useGlobalShortcut(shortcuts, (e) => e.key === 'Escape', backOrHome, READER_LAYER);
  // A bare arrow only, as in the book: with Cmd, Ctrl or Alt it is the browser's (Back).
  const bare = (e: ShortcutKey) => !e.metaKey && !e.ctrlKey && !e.altKey;
  useGlobalShortcut(
    show && shortcuts,
    (e) => e.key === 'ArrowLeft' && bare(e),
    turnLeft,
    READER_LAYER,
  );
  useGlobalShortcut(
    show && shortcuts,
    (e) => e.key === 'ArrowRight' && bare(e),
    turnRight,
    READER_LAYER,
  );

  // The offer, judged against the page on screen. A kept place this device had not seen
  // (another device's, or its own from before its places here were cleared) is
  // acknowledged (its version adopted, so this device's next save applies) only once
  // shown: answered with Jump or Stay, or already where the reader is.
  const here = show && current ? { cfi: current.cfi, progression: current.fraction } : null;
  const offer = answer && here ? jumpOffer(answer, here) : null;
  const notSaved = show && (unsaved === 'shown' || (unsaved !== null && signedOut !== undefined));
  const acknowledge = useLatest((): Promise<void> => {
    if (!answer) return Promise.resolve();
    recordAnswer({ ...answer, seen: true });
    return adoptServerPlace(connectionId, libraryId, path, answer.saved.reading_progress);
  });
  // Stay: the page on screen is saved at once, on the version just acknowledged, as a
  // listening Stay is sent at once (fe#321). Left to the next page turn, the other device's
  // place stood on the server meanwhile (and for good if the reader closed first), and a
  // save captured before the acknowledgement landed went on the old version, kept as the
  // other place again.
  const stay = useLatest(() => {
    const adopted = acknowledge();
    // Not moved since it opened (an offer the open's own replay brought): the place it opened
    // at, never the start of the page that place landed on (fe#172).
    const place =
      !moved.current && at?.cfi !== undefined && at.fraction !== undefined
        ? { cfi: at.cfi, progression: at.fraction }
        : atNow.current;
    if (!place || following.current) return;
    cancelSave();
    lastSaved.current = place.cfi;
    void adopted
      .catch(() => undefined)
      .then(() => saveReaderPlace(api, connectionId, libraryId, path, place));
  });
  const alreadyThere = here !== null && answer !== null && offer === null && !answer.seen;
  useEffect(() => {
    if (alreadyThere) void acknowledge();
  }, [alreadyThere, acknowledge]);

  // The host starts before the place is known (fe#164: the EPUB is fetched meanwhile), and
  // hands the book over once it is (`placeKnown`).
  const ready =
    readable && api !== null && fontScale !== null && autoHide !== null && ebookSize !== undefined;
  const edges = usePageEdges();
  // "Follow narration" (first) or "Back to narration" (after turning away), while the book
  // shows, plays, and its map is this ebook's.
  const followLabel =
    show && readalongMap && readalongOk && followingShown !== true
      ? followingShown === null
        ? t('reader.readalong.follow')
        : t('reader.readalong.back')
      : null;
  const title = book ? bookTitle(book.title, path) : (opened?.title ?? '');
  const percent = current ? Math.round(current.fraction * 100) : null;
  const behind = useBehindModalProps();

  // A press on one of the bar's own controls: it stays, its wait to hide starting again.
  const touching = (act: () => void) => () => {
    chrome.touched();
    act();
  };
  // The top bar: close, the title and where the reader is, then the narration, the contents,
  // the text size and the reading settings.
  const bar = (
    <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
      <Button
        variant="ghost"
        size="icon"
        icon="close"
        accessibilityLabel={t('reader.close')}
        onPress={backOrHome}
      />
      <View className="min-w-0 flex-1 px-1">
        <Text variant="label" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="caption" numberOfLines={1} style={tabularNums}>
          {percent === null
            ? ' '
            : current?.sectionLabel
              ? t('reader.whereSection', { section: current.sectionLabel, percent })
              : t('reader.where', { percent })}
        </Text>
      </View>
      {show ? (
        <>
          {narration.narrating ? (
            <Button
              variant="ghost"
              size="icon"
              icon={narration.playing ? 'pause' : 'play'}
              accessibilityLabel={t(
                narration.playing ? 'player.controls.pause' : 'player.controls.play',
              )}
              onPress={touching(narration.toggle)}
            />
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            icon="list"
            accessibilityLabel={t('reader.contents')}
            disabled={!opened?.toc.length}
            onPress={() => setTocOpen(true)}
          />
          <Button
            variant="ghost"
            size="icon"
            icon="minus"
            accessibilityLabel={t('reader.smaller')}
            disabled={fontScale === FONT_SCALES[0]}
            onPress={touching(() => changeFontScale(-1))}
          />
          <Button
            variant="ghost"
            size="icon"
            icon="plus"
            accessibilityLabel={t('reader.larger')}
            disabled={fontScale === FONT_SCALES.at(-1)}
            onPress={touching(() => changeFontScale(1))}
          />
          <ReaderMenu
            value={themeChoice}
            dark={theme.scheme === 'dark'}
            onChange={chooseTheme}
            autoHide={autoHideOn}
            onAutoHide={chooseAutoHide}
            onOpenChange={setMenuOpen}
          />
        </>
      ) : null}
    </View>
  );

  return (
    <>
      {Platform.OS !== 'web' ? (
        <StatusBar
          // Only while the reader is on top: a page opened over it (Reconnect's sign-in)
          // leaves it mounted, and its status bar would stay hidden there.
          hidden={focused && !chrome.shown}
          animated={!reduced}
          hideTransitionAnimation={reduced ? 'none' : 'slide'}
        />
      ) : null}
      <View
        className="flex-1 bg-card"
        // Web: a modal layer, so the player's keys (arrows skip, Space plays) stand back
        // while reading; the reader's own keys name it as theirs. The top bar stays while
        // the keyboard's focus is on the screen's controls (not a click's, which stays on
        // the button pressed; nor the book's frame), or any focus came into the hidden bar,
        // and only once it leaves them, not as it moves between them.
        {...(Platform.OS === 'web'
          ? {
              role: 'dialog' as const,
              'aria-modal': true,
              dataSet: { layer: READER_LAYER },
              onFocus: (e: { nativeEvent: unknown }) =>
                setFocusIn((held) =>
                  focusHoldsBar(e.nativeEvent, topBar.current, !chrome.shown, held),
                ),
              onBlur: (e: { currentTarget: unknown; nativeEvent: unknown }) => {
                if (!focusStaysIn(e)) setFocusIn(false);
              },
            }
          : {})}
        // Hidden from a screen reader under its Contents sheet.
        {...behind}
        accessibilityLabel={title}
      >
        {immersive && Platform.OS === 'web' ? (
          // The web's bar: in the page while hidden, before the book (ReaderScreen's note).
          <View
            ref={topBar}
            testID="reader-top-bar"
            className={cn(
              'absolute left-0 right-0 top-0 z-10 bg-card transition-transform duration-200 motion-reduce:transition-none',
              chrome.shown ? 'translate-y-0' : '-translate-y-full',
            )}
            style={{ paddingTop: topInset }}
          >
            {bar}
          </View>
        ) : null}
        {/* Immersive: the room above the page is the page's colour while the book shows,
            so with the bar hidden only the book is on screen. */}
        <View
          className="flex-1"
          style={{
            paddingTop: topInset,
            paddingBottom: insets.bottom,
            backgroundColor: immersive && show ? theme.background : undefined,
          }}
        >
          {immersive ? null : bar}
          <View className="relative flex-1" onLayout={edges.onLayout}>
            {ready && !shown ? (
              // The page ends above the follow pill while it shows (fe#192).
              <View testID="reader-page" className="flex-1" style={followPillRoom(!!followLabel)}>
                <ReaderHost
                  key={attempt}
                  ref={host}
                  api={api}
                  connectionId={connectionId}
                  libraryId={libraryId}
                  ebookSize={ebookSize}
                  path={path}
                  name={title}
                  at={at}
                  placeKnown={opening !== null}
                  theme={theme}
                  fontScale={fontScale}
                  title={t('reader.frameTitle', { title })}
                  onMessage={onMessage}
                  onLoadError={onLoadError}
                  // The reader was made again: the edges, the toolbar and the offer wait for
                  // its next `opened`, the spinner shows meanwhile.
                  onReopen={() => setOpened(null)}
                  onFetch={() => {
                    fetchedHere.current = true;
                  }}
                  readalongMap={readalongMap}
                  readalongEbookSha256={mapEbookSha}
                  onEbook={onEbook}
                  readalongPosition={narration.readalongPosition}
                  onSeek={narration.onSeek}
                  onFollowing={onFollowing}
                  onReadalongState={(s) => setReadalongOk(s.state === 'ok')}
                />
              </View>
            ) : null}
            {show ? <PageEdges host={host} rtl={rtl} narrow={edges.narrow} /> : null}
            {signedOut && (shown === 'signedOut' || shown === 'fetch') ? (
              <View className="absolute inset-0 items-center justify-center p-4">
                <View className="w-full max-w-md">
                  <SignInAgainState connection={signedOut} />
                </View>
              </View>
            ) : shown ? (
              <ReaderMessage failure={shown} onRetry={retry} />
            ) : spinner ? (
              <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
                <Spinner size="large" />
              </View>
            ) : null}
            {notSaved || offer || followLabel ? (
              // One foot for the cards and the follow pill, stacked: a refusal can come while
              // an offer waits.
              <View
                className="absolute bottom-4 left-4 right-4 items-center gap-2"
                pointerEvents="box-none"
              >
                {followLabel ? (
                  <FollowPill label={followLabel} onPress={() => host.current?.follow()} />
                ) : null}
                {notSaved ? (
                  <NotSavedCard signedOut={signedOut} onDismiss={() => setUnsaved('dismissed')} />
                ) : null}
                {offer ? (
                  <JumpOfferCard
                    offer={offer}
                    onJump={() => {
                      host.current?.goto({ cfi: offer.cfi });
                      void acknowledge();
                    }}
                    onStay={stay}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
        {immersive && Platform.OS !== 'web' && chrome.shown ? (
          // The apps' bar: over the page, the room above it included; it slides away (no
          // slide with reduce motion: it just goes). A screen reader keeps it above the page.
          <Animated.View
            className="absolute left-0 right-0 top-0 bg-card"
            style={{ paddingTop: topInset }}
            entering={SlideInUp.duration(200).reduceMotion(ReduceMotion.System)}
            exiting={SlideOutUp.duration(200).reduceMotion(ReduceMotion.System)}
          >
            {bar}
          </Animated.View>
        ) : null}
      </View>
      <Sheet visible={tocOpen} onClose={() => setTocOpen(false)} title={t('reader.contents')}>
        <TocList toc={opened?.toc} section={current?.sectionLabel} onSelect={gotoEntry} />
      </Sheet>
    </>
  );
}

/** Whether an element is the book's frame (the web's reader iframe). */
const isBookFrame = (node: unknown): boolean =>
  (node as { tagName?: unknown } | null)?.tagName === 'IFRAME';

/** Whether a focus event (the web's) landed by the keyboard on one of the screen's own
 * controls: its element shows its focus ring (`:focus-visible`) and is not the book's frame
 * (focus there is the reader's, in the book). */
export function keyboardFocus(event: unknown): boolean {
  const target = (event as { target?: { matches?: (selector: string) => boolean } }).target;
  if (isBookFrame(target)) return false;
  try {
    return target?.matches?.(':focus-visible') === true;
  } catch {
    return false;
  }
}

/** Whether a focus (the web's) holds the top bar: the keyboard's on the screen's controls,
 * or any focus in the bar (`bar`) that arrived while it was hidden, as a screen reader's
 * may with no focus ring (a click cannot reach a hidden bar), kept (`held`) while it moves
 * within the bar. A click's on the bar showing holds nothing: the bar's wait runs. */
export function focusHoldsBar(
  event: unknown,
  bar: unknown,
  hidden: boolean,
  held: boolean,
): boolean {
  if (keyboardFocus(event)) return true;
  const target = (event as { target?: unknown }).target;
  const box = bar as { contains?: (node: unknown) => boolean } | null;
  return (hidden || held) && box?.contains?.(target) === true;
}

/** Whether a blur (the web's) moves the focus to another of the screen's controls inside
 * the element it left: into the book's frame it leaves them. */
export function focusStaysIn(e: { currentTarget: unknown; nativeEvent: unknown }): boolean {
  const next = (e.nativeEvent as { relatedTarget?: unknown }).relatedTarget;
  const box = e.currentTarget as { contains?: (node: unknown) => boolean };
  return next != null && !isBookFrame(next) && box.contains?.(next) === true;
}

/** The reader's layer name (`data-layer`), for its own keyboard shortcuts. */
const READER_LAYER = 'reader';

/** `value`, but true only once it has stayed true for `ms`. */
function useDelayed(value: boolean, ms: number): boolean {
  const [shown, setShown] = useState(false);
  if (!value && shown) setShown(false);
  useEffect(() => {
    if (!value) return;
    const id = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return value && shown;
}

/** How far above the current entry the contents open, so the entries before it show too. */
const TOC_LEAD = 96;
/** From this many entries the contents are a virtual list (`LongToc`). */
const TOC_VIRTUAL_FROM = 200;
/** A virtual contents' row height at the default text size (it follows the text scale, as
 * the player's Chapters list does), and how many rows above the current one it opens at. */
const TOC_ROW_H = 44;
const TOC_ROW_MAX_SCALE = 3.2;
const TOC_LEAD_ROWS = 2;

type TocProps = {
  entries: TocEntry[];
  /** The current entry's index, -1 when none is. */
  current: number;
  onSelect: (href: string) => void;
};

/** The contents, one row per entry: the current chapter (the first entry named as the
 * section on screen) marked, and the list opened at it. Memoized: the screen re-renders on
 * every page turn, and a long contents list need not be rebuilt for it. Its own scroller
 * (the sheet caps its height), so it can open at the current entry. A book's contents can
 * run to thousands of entries (fe#165): from `TOC_VIRTUAL_FROM` they are a virtual list. */
const TocList = memo(function TocList({
  toc,
  section,
  onSelect,
}: {
  toc: TocEntry[] | undefined;
  section: string | undefined;
  onSelect: (href: string) => void;
}) {
  const entries = toc ?? [];
  const current = section ? entries.findIndex((entry) => entry.label === section) : -1;
  const Toc = entries.length >= TOC_VIRTUAL_FROM ? LongToc : ShortToc;
  return <Toc entries={entries} current={current} onSelect={onSelect} />;
});

/** Every entry drawn, its label on up to two lines, scrolled to the current one once it is
 * laid out. */
function ShortToc({ entries, current, onSelect }: TocProps) {
  const scroller = useRef<ScrollViewInstance>(null);
  // Once per opening (the sheet mounts the list each time it opens).
  const scrolled = useRef(false);
  return (
    <ScrollView ref={scroller} style={{ flexShrink: 1 }} contentContainerClassName="px-2 pb-4">
      {entries.map((entry, i) => (
        <TocRow
          key={`${i}:${entry.href}`}
          entry={entry}
          here={i === current}
          onLayout={
            i === current
              ? (e) => {
                  if (scrolled.current) return;
                  scrolled.current = true;
                  const y = Math.max(0, e.nativeEvent.layout.y - TOC_LEAD);
                  scroller.current?.scrollTo({ y, animated: false });
                }
              : undefined
          }
          onSelect={onSelect}
        />
      ))}
    </ScrollView>
  );
}

/**
 * The row a long contents opens at (`initialScrollIndex`): `want`, when the rows from it on
 * fill a window's height, so the list can scroll that far. Otherwise none: a list too short
 * below that row renders from it and never fills in the rows above it, which stay blank and
 * can't be tapped (the player's Chapters list showed it on Android). The list then opens at
 * its top and is scrolled to the row once laid out (`LongToc`).
 */
export function tocOpeningIndex(
  want: number,
  count: number,
  rowHeight: number,
  windowHeight: number,
): number | undefined {
  return want > 0 && (count - want) * rowHeight >= windowHeight ? want : undefined;
}

/** A long contents: only the rows near the screen are drawn. A virtual list can open in its
 * middle, and keep its place once scrolled, only where it knows every row's offset
 * (`getItemLayout`), so these rows are one height and their labels one line. Opened on
 * rows not measured, with no known offsets, it drew the rows it opened on at offset 0 and
 * went back to the first entries at the first scroll. Near the end it opens at its top and
 * is scrolled there instead (`tocOpeningIndex`). */
function LongToc({ entries, current, onSelect }: TocProps) {
  const rowHeight = scaleCapped(TOC_ROW_H, useFontScale(), TOC_ROW_MAX_SCALE);
  const { height: windowHeight } = useWindowDimensions();
  const list = useRef<FlatList<TocEntry>>(null);
  // Once per opening (the sheet mounts the list each time it opens): a later layout (a
  // rotation) leaves the reader's own scrolling alone.
  const placed = useRef(false);
  const want = Math.max(0, current - TOC_LEAD_ROWS);
  const opening = tocOpeningIndex(want, entries.length, rowHeight, windowHeight);
  const onLayout = (e: LayoutChangeEvent) => {
    if (placed.current) return;
    placed.current = true;
    if (opening !== undefined) return;
    // As far toward the row as the list scrolls.
    const room = entries.length * rowHeight - e.nativeEvent.layout.height;
    const offset = Math.min(want * rowHeight, Math.max(0, room));
    if (offset > 0) list.current?.scrollToOffset({ offset, animated: false });
  };
  return (
    <FlatList
      ref={list}
      testID="reader-toc"
      data={entries}
      style={{ flexShrink: 1 }}
      contentContainerClassName="px-2 pb-4"
      keyExtractor={(entry, i) => `${i}:${entry.href}`}
      initialScrollIndex={opening}
      getItemLayout={(_, index) => ({ length: rowHeight, offset: rowHeight * index, index })}
      onLayout={onLayout}
      renderItem={({ item, index }) => (
        <TocRow entry={item} here={index === current} height={rowHeight} onSelect={onSelect} />
      )}
    />
  );
}

/** One entry of the contents. With a `height` (the virtual list's) its label is one line. */
function TocRow({
  entry,
  here,
  height,
  onLayout,
  onSelect,
}: {
  entry: TocEntry;
  here: boolean;
  height?: number;
  onLayout?: (e: LayoutChangeEvent) => void;
  onSelect: (href: string) => void;
}) {
  return (
    <Pressable
      role="button"
      aria-current={here ? 'location' : undefined}
      accessibilityState={{ selected: here }}
      className={cn(
        'rounded-lg pr-2 active:bg-muted web:hover:bg-muted',
        height === undefined ? 'py-2.5' : 'justify-center',
        here && 'bg-muted',
      )}
      style={{ paddingLeft: 8 + entry.depth * 16, height }}
      onLayout={onLayout}
      onPress={() => onSelect(entry.href)}
    >
      <Text variant={here ? 'label' : 'body'} numberOfLines={height === undefined ? 2 : 1}>
        {entry.label}
      </Text>
    </Pressable>
  );
}

/** The reader's own settings (fe#246), saved on this device: the page colours (like the app,
 * light, dark or black, for the reader and the companion's Text tab) and whether the top bar
 * hides while reading, behind a button named for both ("Reading settings"). Its glyph is the
 * colours' scheme. */
function ReaderMenu({
  value,
  dark,
  onChange,
  autoHide,
  onAutoHide,
  onOpenChange,
}: {
  value: ReaderThemeChoice;
  dark: boolean;
  onChange: (choice: ReaderThemeChoice) => void;
  autoHide: boolean;
  onAutoHide: (on: boolean) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  // Taken off the page while open (the bar moved above or over the page): it holds the bar
  // no more.
  useEffect(() => () => onOpenChange(false), [onOpenChange]);
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          icon={dark ? 'moon' : 'sun'}
          accessibilityLabel={t('reader.settings')}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('reader.theme.heading')}</DropdownMenuLabel>
        {READER_THEMES.map((choice) => (
          <DropdownMenuItem
            key={choice}
            onPress={() => onChange(choice)}
            accessibilityState={{ checked: choice === value }}
          >
            <Text className="flex-1">{t(`reader.theme.${choice}`)}</Text>
            {choice === value ? <Icon name="check" size={16} color={themed.foreground} /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('reader.topBar.heading')}</DropdownMenuLabel>
        <DropdownMenuItem
          onPress={() => onAutoHide(!autoHide)}
          accessibilityState={{ checked: autoHide }}
        >
          <Text className="flex-1">{t('reader.topBar.autoHide')}</Text>
          {autoHide ? <Icon name="check" size={16} color={themed.foreground} /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Whether a save's answer is about this book. */
function sameBook(
  heard: { connectionId: string; libraryId: number; path: string },
  connectionId: string,
  libraryId: number,
  path: string,
): boolean {
  return (
    heard.connectionId === connectionId && heard.libraryId === libraryId && heard.path === path
  );
}

/** Why the book is not shown, in plain words, with a way on. */
function ReaderMessage({ failure, onRetry }: { failure: ReaderFailure; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <View className="absolute inset-0 items-center justify-center p-4">
      <View className="w-full max-w-md gap-3">
        <Notice
          icon="circle-exclamation"
          tone="warning"
          title={t(`reader.failure.${failure}.title`)}
          // In the app 'start' is its WebView that did not start or keep running: no browser.
          body={t(
            failure === 'start' && Platform.OS !== 'web'
              ? 'reader.failure.start.bodyNative'
              : `reader.failure.${failure}.body`,
          )}
        />
        <View className="flex-row justify-end gap-2">
          {RETRYABLE.includes(failure) ? (
            <Button variant="outline" title={t('reader.tryAgain')} onPress={onRetry} />
          ) : null}
          <Button title={t('reader.close')} onPress={backOrHome} />
        </View>
      </View>
    </View>
  );
}

/** "Your place wasn't saved": a save the server refused, at the foot of the page. With the
 * sign-in ended, the sign-in row with Reconnect; else OK to put it away. */
function NotSavedCard({
  signedOut,
  onDismiss,
}: {
  signedOut: Connection | undefined;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <FootCard testID="reader-not-saved" role="alert" className="gap-2">
      <View className="flex-row items-center gap-2">
        <Text variant="label" className="min-w-0 flex-1">
          {t('reader.notSaved.body')}
        </Text>
        {signedOut ? null : (
          <Button
            variant="ghost"
            size="sm"
            title={t('reader.notSaved.dismiss')}
            onPress={onDismiss}
          />
        )}
      </View>
      {signedOut ? <SignInAgainState connection={signedOut} compact /> : null}
    </FootCard>
  );
}

/** "On Pixel 8 you were at 60%. Jump there?" with Jump and Stay: non-blocking, at the foot
 * of the page. */
function JumpOfferCard({
  offer,
  onJump,
  onStay,
}: {
  offer: JumpOffer;
  onJump: () => void;
  onStay: () => void;
}) {
  const { t } = useTranslation();
  const percent = Math.round(offer.progression * 100);
  return (
    <FootCard testID="reader-jump-offer" role="status" className="flex-row items-center gap-2">
      <Text variant="label" className="min-w-0 flex-1">
        {offer.deviceName
          ? t('reader.offer.device', { device: offer.deviceName, percent })
          : t('reader.offer.unknown', { percent })}
      </Text>
      <Button size="sm" title={t('reader.offer.jump')} onPress={onJump} />
      <Button variant="ghost" size="sm" title={t('reader.offer.stay')} onPress={onStay} />
    </FootCard>
  );
}

/** A card at the foot of the page, over the book (the screen stacks them there). */
function FootCard({
  testID,
  role,
  className,
  children,
}: {
  testID: string;
  role: 'alert' | 'status';
  className: string;
  children: ReactNode;
}) {
  return (
    <View
      testID={testID}
      role={role}
      className={cn(
        'w-full max-w-md rounded-2xl border border-border bg-popover px-4 py-3',
        className,
      )}
    >
      {children}
    </View>
  );
}
