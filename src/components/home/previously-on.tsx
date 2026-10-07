import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { ScopedTheme } from 'uniwind';
import { create } from 'zustand';

import { resolveClient } from '@/api/connection-clients';
import type { SourcedProgress } from '@/api/hooks';
import { ConnectionScope } from '@/api/provider';
import { BookCover } from '@/components/library/book-cover';
import { CoverWash } from '@/components/library/cover-wash';
import { useBookCommunity } from '@/components/library/use-book-community';
import { Attribution } from '@/components/player/companion/companion-pieces';
import { selectIsLoaded } from '@/components/player/playing-target';
import { startBookInPlace } from '@/components/player/start-book';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { chapterLabel } from '@/lib/chapter-label';
import { contentKeyOf } from '@/lib/content-key';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { bookTitle } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { loadInitialProgress } from '@/playback/progress-sync';
import { usePlayer } from '@/playback/store';
import { colors } from '@/theme/tokens';

import type { BookAt } from './home-model';
import { overlapStart, previouslyOn } from './previously-on-model';

/** The cards closed this session (memory only: the next launch may show it again). */
const useDismissed = create<{ keys: string[]; dismiss: (key: string) => void }>()((set) => ({
  keys: [],
  dismiss: (key) => set((s) => ({ keys: [...s.keys, key] })),
}));

/** A saved place: where, at what speed, and when it was saved (last write wins). */
type SavedPlace = { position: number; playback_speed: number; updated_at: string };

/** When a place was saved; one whose time doesn't parse loses to any that does. */
function savedAt(place: { updated_at: string }): number {
  const t = Date.parse(place.updated_at);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * "Resume, with 30 seconds of overlap": start `at` 30 seconds before its NEWEST saved
 * place, at that place's speed (`startBookInPlace` with a position, which also lowers the
 * resume floor to where it starts, so the overlap's saves are not refused as a slip).
 *
 * `saved` is Home's copy of the server's row, and the device can hold a newer place
 * (listening offline queues its saves). A start at an explicit position skips the store's
 * own resume reconciliation, so it happens here: the lookup a plain resume makes (the
 * server, the durable local mirror and the offline queue; the newest wins). Starting from
 * the older row instead played it and saved it over the newer place. `saved` stays a
 * candidate, since an unreachable server leaves only the local records, which can be
 * older than the row Home already has; a lookup that fails, finds nothing or finds the
 * book finished falls back to it. Resolves false when the book's connection is gone.
 */
export async function resumeWithOverlap(at: BookAt, saved: SavedPlace): Promise<boolean> {
  const { connectionId, libraryId, path } = at;
  const lookup = await loadInitialProgress(
    resolveClient(connectionId),
    connectionId,
    libraryId,
    path,
  );
  const place =
    lookup.kind === 'progress' &&
    !lookup.progress.finished &&
    savedAt(lookup.progress) >= savedAt(saved)
      ? lookup.progress
      : saved;
  return startBookInPlace(at, {
    position: overlapStart(place.position),
    speed: place.playback_speed,
  });
}

/** `resumeWithOverlap`, then a phone opens the full player over the book's page, as
 * every Home start does. Rejects when the book could not start. */
function useResumeWithOverlap() {
  const phone = useLayout() === 'phone';
  const { openBook, openPlayer } = useOpen();
  return async (at: BookAt, saved: SavedPlace) => {
    const started = await resumeWithOverlap(at, saved);
    if (!started) throw new Error('connection gone');
    if (phone) {
      openBook(at.connectionId, at.libraryId, at.path);
      openPlayer(at.connectionId, at.libraryId, at.path);
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
  const loaded = usePlayer(selectIsLoaded(at));
  const { metadata, book, chapterData, chapterStarts, work } = useBookCommunity(at);

  const card = previouslyOn({
    saved,
    now,
    loaded,
    dismissed,
    metadata,
    recaps: work?.recaps ?? [],
    chapterStarts,
  });
  if (!card || !saved) return null;

  const title = bookTitle(book?.title, path);
  const chapter = chapterData?.chapters[card.chapter - 1];
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
            <Text
              variant="body"
              className="text-[14.5px] leading-6 text-muted-foreground"
              // One paragraph, kept short: the whole of it is a tap away (Read the full recap).
              numberOfLines={phone ? 6 : 4}
            >
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
