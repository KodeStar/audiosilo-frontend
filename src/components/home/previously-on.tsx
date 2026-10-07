import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { ScopedTheme } from 'uniwind';
import { create } from 'zustand';

import {
  chaptersQuery,
  itemQuery,
  type SourcedProgress,
  useBook,
  useBookMeta,
  useCapability,
  useChapters,
} from '@/api/hooks';
import { ConnectionScope, queryClient, useApiRegistry } from '@/api/provider';
import { BookCover } from '@/components/library/book-cover';
import { matchedMeta } from '@/components/library/book-meta';
import { CoverWash } from '@/components/library/cover-wash';
import { chapterStartsOf } from '@/components/library/meta-gating';
import { Attribution } from '@/components/player/companion/companion-pieces';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { chapterLabel } from '@/lib/chapter-label';
import { contentKey, contentKeyOf } from '@/lib/content-key';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { bookTitle } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { selectBookKey, usePlayer } from '@/playback/store';
import { colors } from '@/theme/tokens';

import type { BookAt } from './home-model';
import { overlapStart, previouslyOn } from './previously-on-model';

/** The cards closed this session (memory only: the next launch may show it again). */
const useDismissed = create<{ keys: string[]; dismiss: (key: string) => void }>()((set) => ({
  keys: [],
  dismiss: (key) => set((s) => ({ keys: [...s.keys, key] })),
}));

/**
 * Start `at` 30 seconds before its saved place, at its saved speed: through
 * `playBook(..., startBookPosition)`, which also lowers the resume floor to where it
 * starts (so the overlap's saves are not refused as a slip). A phone then opens the full
 * player over the book's page, as every Home start does.
 */
function useResumeWithOverlap() {
  const { clients } = useApiRegistry();
  const phone = useLayout() === 'phone';
  const { openBook, openPlayer } = useOpen();
  return async (at: BookAt, saved: { position: number; playback_speed: number }) => {
    const { connectionId, libraryId, path } = at;
    const api = clients.get(connectionId);
    if (!api) throw new Error('connection gone');
    const [book, chapters] = await Promise.all([
      queryClient.fetchQuery({
        ...itemQuery(connectionId, api, libraryId, path),
        staleTime: 30_000,
      }),
      queryClient.fetchQuery({
        ...chaptersQuery(connectionId, api, libraryId, path),
        staleTime: 30_000,
      }),
    ]);
    const player = usePlayer.getState();
    await player.playBook(connectionId, libraryId, book, chapters, overlapStart(saved.position));
    // An explicit start skips the resume lookup, which is what restores the book's speed.
    if (saved.playback_speed > 0) await usePlayer.getState().setRate(saved.playback_speed);
    if (phone) {
      openBook(connectionId, libraryId, path);
      openPlayer(connectionId, libraryId, path);
    }
  };
}

/**
 * "Previously on" (STYLEGUIDE section 8): above the Now card when the listener comes back
 * to the book they are on after 12 or more days, on a dark card tinted with its cover:
 * where they left it (the chapter they are in), the furthest community recap they are
 * past (gated exactly like Story so far), "Resume, with 30 seconds of overlap", "Read
 * the full recap" (the book page's Recaps) and the licence line. Dismissible for the
 * session. Nothing without `metadata`, a matched work or a recap that reaches them.
 */
export function PreviouslyOnCard({ at, saved }: { at: BookAt; saved?: SourcedProgress }) {
  return (
    <ConnectionScope connectionId={at.connectionId}>
      <PreviouslyOnBody at={at} saved={saved} />
    </ConnectionScope>
  );
}

function PreviouslyOnBody({ at, saved }: { at: BookAt; saved?: SourcedProgress }) {
  const { t } = useTranslation();
  const { connectionId, libraryId, path } = at;
  const key = contentKeyOf(at);
  const phone = useLayout() === 'phone';
  const { openBook } = useOpen();
  const resume = useResumeWithOverlap();
  const [busy, setBusy] = useState(false);
  const [now] = useState(Date.now);

  const dismissed = useDismissed((s) => s.keys.includes(key));
  const dismiss = useDismissed((s) => s.dismiss);
  const loaded = usePlayer((s) => selectBookKey(s) === contentKey(connectionId, libraryId, path));
  const metadata = useCapability('metadata', connectionId);
  const { data: book } = useBook(libraryId, path, connectionId);
  const metaEnabled = metadata === true && !!(book?.asin || book?.isbn);
  const { data: meta } = useBookMeta(libraryId, path, metaEnabled);
  const { data: chapterData } = useChapters(libraryId, path, connectionId);
  const chapters = useMemo(() => chapterData?.chapters ?? [], [chapterData]);
  const starts = useMemo(
    () => chapterStartsOf(chapters, chapterData?.files ?? []),
    [chapters, chapterData],
  );
  const work = matchedMeta(meta, metaEnabled)?.work;

  const card = previouslyOn({
    saved,
    now,
    loaded,
    dismissed,
    metadata,
    recaps: work?.recaps ?? [],
    chapterStarts: starts,
  });
  if (!card || !saved) return null;

  const title = bookTitle(book?.title, path);
  const chapter = chapters[card.chapter - 1];
  const left = chapter
    ? t('home.previouslyOn.left', {
        title,
        chapter: chapterLabel({ title: chapter.title, index: card.chapter - 1 }, t),
      })
    : t('home.previouslyOn.leftBook', { title });
  const onResume = () => {
    setBusy(true);
    resume(at, saved)
      .then(() => dismiss(key))
      .catch((e: unknown) => {
        console.warn('[home] resume with overlap failed', e);
        toast({ title: t('home.now.resumeFailed') });
      })
      .finally(() => setBusy(false));
  };
  const ink = colors.dark;

  return (
    <ScopedTheme theme="dark">
      <View
        testID="previously-on"
        accessibilityRole="summary"
        accessibilityLabel={t('home.previouslyOn.label')}
        className="relative overflow-hidden rounded-sheet border border-border bg-background p-5 md:p-6"
      >
        <CoverWash color={book?.cover_color} variant="card" />
        <View className={cn('gap-5', !phone && 'flex-row items-start')}>
          {!phone ? (
            <BookCover
              connectionId={connectionId}
              libraryId={libraryId}
              path={path}
              coverVersion={book?.cover_version}
              width={96}
              title={title}
              author={book?.author}
              shadow="lg"
            />
          ) : null}
          <View className="min-w-0 flex-1 gap-2">
            <View className="flex-row items-start gap-2">
              <Text variant="eyebrow" className="flex-1" numberOfLines={2}>
                {t('home.previouslyOn.eyebrow', { title, count: card.days })}
              </Text>
              <AnimatedPressable
                onPress={() => dismiss(key)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('home.previouslyOn.dismiss')}
                className={cn(
                  '-mr-2 -mt-2 h-9 w-9 items-center justify-center rounded-full active:bg-accent',
                  Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
                )}
              >
                <Icon name="close" size={16} color={ink.mutedForeground} />
              </AnimatedPressable>
            </View>
            <Text variant="display" className="text-[22px] leading-[26px] md:text-[24px]">
              {left}
            </Text>
            <Text variant="body" className="text-[14.5px] leading-6 text-muted-foreground">
              {card.recap.text}
            </Text>
            <View className="mt-1 flex-row flex-wrap gap-2">
              <Button
                title={t('home.previouslyOn.resume')}
                onPress={onResume}
                loading={busy}
                className={phone ? 'w-full' : undefined}
              />
              <Button
                variant="outline"
                title={t('home.previouslyOn.readRecap')}
                onPress={() => openBook(connectionId, libraryId, path, 'recaps')}
                className={phone ? 'w-full' : undefined}
              />
            </View>
            <Text variant="caption">
              {card.recap.through.chapter > 0
                ? t('home.previouslyOn.spoilerSafe', { chapter: card.recap.through.chapter })
                : t('home.previouslyOn.spoilerSafeStart')}
            </Text>
            <Attribution attribution={work?.attribution} tone="inverse" />
          </View>
        </View>
      </View>
    </ScopedTheme>
  );
}
