import { type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useOptionalApi } from '@/api/provider';
import { MakeReadalongOffer } from '@/components/bridge/make-readalong';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { contentKeyOf } from '@/lib/content-key';
import { bookTitle } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { useNarration } from '@/reader/narration';
import { FollowPill, PageEdges, usePageEdges } from '@/reader/page-edge';
import type { ReadalongState } from '@/reader/protocol';
import { cfiAt, type ReaderReadalongMap } from '@/reader/readalong-map';
import { ReaderHost } from '@/reader/reader-host';
import {
  type ReaderHostEvent,
  type ReaderHostHandle,
  ReaderStartError,
} from '@/reader/reader-host-types';
import { useReaderAppearance } from '@/reader/use-reader-appearance';

import type { PlayTarget } from '../use-play-book';
import type { TextTabModel } from './use-text-tab';

/**
 * The companion's Text tab (Bridge Phase 3c): the playing book's ebook following its
 * narration (`ReadAlong`), or, for an admin with no map to follow, why and "Make
 * read-along". `fill`: the tab's own scroller (the desktop column, the phone's sheet) is
 * the panel's height; inline (the tablet's page) it takes a fixed one.
 */
export function TextPanel({
  target,
  text,
  fill,
}: {
  target: PlayTarget;
  text: TextTabModel;
  fill: boolean;
}) {
  const { t } = useTranslation();
  const { book, map } = text;
  const title = book ? bookTitle(book.title, target.path) : undefined;
  if (!map && text.pending) {
    // On its way (an admin's tab shows from the start): never the Make offer meanwhile.
    return (
      <View testID="companion-text-pending" className="items-center py-8">
        <Spinner size="large" />
      </View>
    );
  }
  if (map && book?.ebook) {
    return (
      <ReadAlong
        // One per book: the playing book changes under an open tab (Up next, the car), and
        // a reader document says `ready` once, so the next book needs its own.
        key={contentKeyOf(target)}
        target={target}
        ebookSize={book.ebook.size}
        map={map}
        title={title ?? ''}
        fill={fill}
      />
    );
  }
  if (!map && text.failed) {
    // The map did not load (offline, the server failed): said, with Try again. Never the
    // Make offer: a map may well be there, and making it again takes hours.
    return (
      <View testID="companion-text-map-failed" className="py-4">
        <EmptyState
          icon="circle-exclamation"
          title={t('player.companion.textFailedTitle')}
          hint={t('player.companion.textMapFailedHint')}
          action={{ label: t('reader.tryAgain'), onPress: text.retry }}
        />
      </View>
    );
  }
  const stale = book?.readalong?.state === 'stale';
  return (
    <TextEmpty
      title={t(stale ? 'player.companion.textStaleTitle' : 'player.companion.textEmptyTitle')}
      hint={t(staleHint(book?.readalong?.reason, stale))}
    >
      <MakeReadalongOffer target={target} hasEbook={!!book?.ebook} title={title} again={stale} />
    </TextEmpty>
  );
}

/** The empty Text tab's hint: why a stale map no longer fits, else what a read-along is. */
function staleHint(reason: string | undefined, stale: boolean) {
  if (!stale) return 'player.companion.textEmptyHint' as const;
  if (reason === 'ebook_changed') return 'player.companion.textStaleEbook' as const;
  if (reason === 'audio_changed') return 'player.companion.textStaleAudio' as const;
  return 'player.companion.textStaleHint' as const;
}

function TextEmpty({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <View testID="companion-text-empty" className="gap-2 py-4">
      <EmptyState icon="book-open" title={title} hint={hint} />
      {children}
    </View>
  );
}

/** Why the read-along shows nothing: a part of the book did not load (fe#164), the
 * reader did not start, or the book could not be fetched. */
type TextFailure = 'section' | 'start' | 'fetch';

/**
 * The playing book's text, following its narration: the reader host (the web's iframe, the
 * app's WebView) opened at the sentence being read (`cfiAt`), following it
 * (`followNarration`), told of every play, pause, seek and speed change (`useNarration`); a
 * tapped sentence plays from its start. Turning away stops following, and a "Back to
 * narration" pill brings it back. The reading place is never saved from here: this is the
 * narration's view, not the book's reading.
 */
function ReadAlong({
  target,
  ebookSize,
  map,
  title,
  fill,
}: {
  target: PlayTarget;
  ebookSize: number;
  map: ReaderReadalongMap;
  title: string;
  fill: boolean;
}) {
  const { t } = useTranslation();
  const { connectionId, libraryId, path } = target;
  const api = useOptionalApi(connectionId);
  const host = useRef<ReaderHostHandle>(null);
  const narration = useNarration(target, host);
  const edges = usePageEdges();

  const { theme, fontScale } = useReaderAppearance();
  // Where it opens: the sentence being read when the tab opened (then it follows on).
  const [at] = useState(() => {
    const p = narration.readalongPosition();
    const cfi = p ? cfiAt(map, p.t) : undefined;
    return cfi ? { cfi } : undefined;
  });

  const [opened, setOpened] = useState<{ rtl: boolean } | null>(null);
  // What the reader made of the map, for that map: one the book's made again is judged again
  // (a `none` would otherwise outlast it, its reader gone).
  const [said, setSaid] = useState<{
    map: ReaderReadalongMap;
    state: ReadalongState['state'];
  } | null>(null);
  const state = said?.map === map ? said.state : null;
  // Null until the reader says: it follows from the start (`followNarration`).
  const [following, setFollowing] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<TextFailure | null>(null);
  const [attempt, setAttempt] = useState(0);

  const onMessage = (message: ReaderHostEvent) => {
    switch (message.type) {
      case 'opened':
        setOpened({ rtl: message.rtl });
        return;
      case 'error':
        if (message.code === 'runtime') console.warn('[reader]', message.message);
        // A part of the book did not load (the follow loop turns into another section):
        // said, with Try again (fe#164).
        else if (message.code === 'section') setFailure('section');
        else if (!opened) setFailure('fetch');
        return;
      default:
        // `progress`, `loading`, `escape`: the place is not saved from here, and the
        // tab has no keys of its own.
        return;
    }
  };
  const retry = () => {
    setFailure(null);
    setOpened(null);
    setSaid(null);
    setAttempt((n) => n + 1);
  };

  if (!api) {
    return (
      <TextEmpty
        title={t('player.companion.noServerTitle')}
        hint={t('player.companion.textNoServer')}
      />
    );
  }
  if (failure) {
    return (
      <View testID="companion-text-failed" className="py-4">
        <EmptyState
          icon="circle-exclamation"
          title={t('player.companion.textFailedTitle')}
          hint={t(
            failure === 'section'
              ? 'reader.failure.section.body'
              : failure === 'start'
                ? 'player.companion.textStartHint'
                : 'player.companion.textFailedHint',
          )}
          action={{ label: t('reader.tryAgain'), onPress: retry }}
        />
      </View>
    );
  }
  if (state === 'none') {
    // The map names nothing in this ebook: an admin may make it again.
    return (
      <TextEmpty
        title={t('player.companion.textNoMatchTitle')}
        hint={t('player.companion.textNoMatchHint')}
      >
        <MakeReadalongOffer target={target} hasEbook title={title} again />
      </TextEmpty>
    );
  }

  const show = opened !== null && state === 'ok';
  const rtl = opened?.rtl === true;
  return (
    <View
      testID="companion-text"
      className={cn(
        'relative overflow-hidden rounded-2xl border border-border bg-card',
        fill ? 'flex-1' : 'h-[520px]',
      )}
      onLayout={edges.onLayout}
    >
      {fontScale !== null ? (
        <ReaderHost
          key={attempt}
          ref={host}
          api={api}
          connectionId={connectionId}
          libraryId={libraryId}
          path={path}
          ebookSize={ebookSize}
          name={title}
          at={at}
          theme={theme}
          fontScale={fontScale}
          title={t('reader.frameTitle', { title })}
          onMessage={onMessage}
          onLoadError={(e) => setFailure(e instanceof ReaderStartError ? 'start' : 'fetch')}
          onReopen={() => setOpened(null)}
          readalongMap={map}
          readalongPosition={narration.readalongPosition}
          followNarration
          onSeek={narration.onSeek}
          onFollowing={setFollowing}
          onReadalongState={(s) => setSaid({ map, state: s.state })}
        />
      ) : null}
      {show ? (
        <>
          <PageEdges host={host} rtl={rtl} narrow={edges.narrow} />
          {following === false && narration.narrating ? (
            <View
              className="absolute bottom-3 left-0 right-0 items-center"
              pointerEvents="box-none"
            >
              <FollowPill
                label={t('reader.readalong.back')}
                onPress={() => host.current?.follow()}
              />
            </View>
          ) : null}
        </>
      ) : (
        <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
          <Spinner size="large" />
        </View>
      )}
    </View>
  );
}
