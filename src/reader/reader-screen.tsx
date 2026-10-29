import { memo, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, isSignedOutError } from '@/api/client';
import { useBook, useCapability, useReadingPlace } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { SignInAgainState, useSignedOutConnection } from '@/components/layout/sign-in-again';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Sheet } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useDownloadedEbook } from '@/downloads/store';
import type { Connection } from '@/stores/session';
import { backOrHome } from '@/lib/back-or-home';
import { type ShortcutKey, useGlobalShortcut } from '@/lib/keyboard';
import { bookTitle } from '@/lib/paths';
import { useLatest } from '@/lib/use-latest';
import { usePageTitle } from '@/lib/use-page-title';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

import { canRead } from './can-read';
import { hasLocalEbook } from './ebook-file';
import { useNarration } from './narration';
import { FollowPill, PageEdges, turnPage, usePageEdges } from './page-edge';
import type { ReaderPlace, TocEntry } from './protocol';
import { ReaderHost } from './reader-host';
import { type ReaderHostEvent, type ReaderHostHandle, ReaderStartError } from './reader-host-types';
import { FONT_SCALES, saveFontScale, stepFontScale } from './reader-settings';
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

/** Why the reader shows a message instead of the book. `signedOut`: the server refused the
 * session (a 401), shown as the sign-in state with Reconnect while the connection needs
 * signing in again; `section`: a part of the open book did not load. */
type ReaderFailure =
  'drm' | 'unreadable' | 'missing' | 'fetch' | 'start' | 'noEbook' | 'signedOut' | 'section';

/** The failures Try again can mend. */
const RETRYABLE: readonly ReaderFailure[] = ['fetch', 'start', 'section'];

type Place = { cfi: string; fraction: number; sectionLabel: string };

/** Why loading failed, as the reader says it: the reader document never started, the
 * sign-in ended, the book is gone, or the server gave no answer (for the book, or where it
 * opens). */
const loadFailure = (e: unknown): ReaderFailure =>
  e instanceof ReaderStartError
    ? 'start'
    : isSignedOutError(e)
      ? 'signedOut'
      : e instanceof ApiError && e.status === 404
        ? 'missing'
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
  const hasLocalCopy = useLatest(() =>
    hasLocalEbook({ connectionId, libraryId, path, size: ebookSize, saved: savedEbook }),
  );
  const place = useReadingPlace(libraryId, path, connectionId, readable, hasLocalCopy);
  usePageTitle(book ? bookTitle(book.title, path) : undefined);

  const host = useRef<ReaderHostHandle>(null);
  // Read-along (Bridge Phase 3c): the narration, and the map while this book is the one
  // the player holds. The map is asked for and goes to the reader only then: another book
  // playing has nothing to follow here.
  const narration = useNarration({ connectionId, libraryId, path }, host);
  const readalongMap = useBookReadalong(
    { connectionId, libraryId, path },
    book,
    readable,
    narration.narrating,
  ).map;
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

  const { theme, fontScale, setFontScale } = useReaderAppearance();
  const changeFontScale = (direction: -1 | 1) => {
    const next = stepFontScale(fontScale ?? 1, direction);
    setFontScale(next);
    void saveFontScale(next);
  };

  const [opened, setOpened] = useState<{ title: string; toc: TocEntry[]; rtl: boolean } | null>(
    null,
  );
  // The book showed on this screen once: a reopen that fails then is not a bad file.
  const shownOnce = useRef(false);
  // The next `progress` is where the book landed on opening (the start of the page the
  // saved place falls on), not a move: saving it would pull a place read at another page
  // size back to this page's start (fe#172). The first move saves.
  const landing = useRef(false);
  const [current, setCurrent] = useState<Place | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<ReaderFailure | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const spinner = useDelayed(loading || (!opened && !failure), SPINNER_DELAY_MS);

  // Where it opens: decided once, when the place lookup first settles (set while
  // rendering, React's pattern for state that follows a prop). Opening at the server's row
  // means this device has now seen that version, so its saves are made on it.
  const [opening, setOpening] = useState<ReadingPlaceLookup | null>(null);
  if (!opening && place.data) setOpening(place.data);
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
  // The reader follows the narration (`onFollowing`): no place is saved meanwhile (the
  // narration turns the pages; a save would carry another device's reading along with
  // it). Once the listener turns away, where they are is saved, and every move after.
  const onFollowing = (value: boolean) => {
    following.current = value;
    setFollowingShown(value);
    if (value) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
    } else if (atNow.current) {
      scheduleSave(atNow.current);
    }
  };
  const flushSave = useLatest(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
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
  // late never replaces a newer one). It is judged against the page on screen once the book
  // shows, below: the queue's replay can answer before the first page.
  const [answer, setAnswer] = useState<ReadingSaved | null>(null);
  useEffect(
    () =>
      onReadingSaved((heard) => {
        if (!sameBook(heard, connectionId, libraryId, path)) return;
        setUnsaved(null);
        setAnswer((prev) =>
          prev && prev.saved.reading_progress.version > heard.saved.reading_progress.version
            ? prev
            : heard,
        );
      }),
    [connectionId, libraryId, path],
  );

  const onMessage = (message: ReaderHostEvent) => {
    switch (message.type) {
      case 'opened':
        shownOnce.current = true;
        landing.current = true;
        setOpened({ title: message.title, toc: message.toc, rtl: message.rtl });
        return;
      case 'progress':
        setCurrent({
          cfi: message.cfi,
          fraction: message.fraction,
          sectionLabel: message.sectionLabel,
        });
        atNow.current = { cfi: message.cfi, progression: message.fraction };
        if (landing.current) {
          landing.current = false;
          return;
        }
        if (following.current) return;
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
    if (current) setResumeAt({ cfi: current.cfi, fraction: current.fraction });
    setAttempt((n) => n + 1);
    if (bookFailed) void refetchBook();
    if (place.isError) void place.refetch();
  };

  const gotoEntry = useLatest((href: string) => {
    setTocOpen(false);
    host.current?.goto({ href });
  });

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
  const acknowledge = useLatest(() => {
    if (answer) void adoptServerPlace(connectionId, libraryId, path, answer.saved.reading_progress);
    setAnswer(null);
  });
  const alreadyThere = here !== null && answer !== null && offer === null && !answer.seen;
  useEffect(() => {
    if (alreadyThere) acknowledge();
  }, [alreadyThere, acknowledge]);

  // The host starts before the place is known (fe#164: the EPUB is fetched meanwhile), and
  // hands the book over once it is (`placeKnown`).
  const ready = readable && api !== null && fontScale !== null && ebookSize !== undefined;
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

  return (
    <>
      <View
        className="flex-1 bg-card"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        // Web: a modal layer, so the player's keys (arrows skip, Space plays) stand back
        // while reading; the reader's own keys name it as theirs.
        {...(Platform.OS === 'web'
          ? { role: 'dialog' as const, 'aria-modal': true, dataSet: { layer: READER_LAYER } }
          : {})}
        accessibilityLabel={title}
      >
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
                onPress={() => changeFontScale(-1)}
              />
              <Button
                variant="ghost"
                size="icon"
                icon="plus"
                accessibilityLabel={t('reader.larger')}
                disabled={fontScale === FONT_SCALES.at(-1)}
                onPress={() => changeFontScale(1)}
              />
            </>
          ) : null}
        </View>

        <View className="relative flex-1" onLayout={edges.onLayout}>
          {ready && !shown ? (
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
              readalongMap={readalongMap}
              readalongPosition={narration.readalongPosition}
              onSeek={narration.onSeek}
              onFollowing={onFollowing}
              onReadalongState={(s) => setReadalongOk(s.state === 'ok')}
            />
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
                    acknowledge();
                  }}
                  onStay={acknowledge}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
      <Sheet visible={tocOpen} onClose={() => setTocOpen(false)} title={t('reader.contents')}>
        <TocList toc={opened?.toc} section={current?.sectionLabel} onSelect={gotoEntry} />
      </Sheet>
    </>
  );
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

/** The contents, one row per entry: the current chapter (the first entry named as the
 * section on screen) marked, and scrolled into view when the list opens. Memoized: the
 * screen re-renders on every page turn, and a long contents list need not be rebuilt for
 * it. Its own scroller (the sheet caps its height), so it can open at the current entry. */
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
  const scroller = useRef<ScrollView>(null);
  // Once per opening (the sheet mounts the list each time it opens).
  const scrolled = useRef(false);
  return (
    <ScrollView ref={scroller} style={{ flexShrink: 1 }} contentContainerClassName="px-2 pb-4">
      {entries.map((entry, i) => {
        const here = i === current;
        return (
          <Pressable
            key={`${i}:${entry.href}`}
            role="button"
            aria-current={here ? 'location' : undefined}
            accessibilityState={{ selected: here }}
            className={`rounded-lg py-2.5 pr-2 active:bg-muted web:hover:bg-muted ${here ? 'bg-muted' : ''}`}
            style={{ paddingLeft: 8 + entry.depth * 16 }}
            onLayout={
              here
                ? (e) => {
                    if (scrolled.current) return;
                    scrolled.current = true;
                    const y = Math.max(0, e.nativeEvent.layout.y - TOC_LEAD);
                    scroller.current?.scrollTo({ y, animated: false });
                  }
                : undefined
            }
            onPress={() => onSelect(entry.href)}
          >
            <Text variant={here ? 'label' : 'body'} numberOfLines={2}>
              {entry.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
});

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
