import { router } from 'expo-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useBookProgress } from '@/api/hooks';
import { ConnectionScope } from '@/api/provider';
import type { BookMetaCharacter } from '@/api/types';
import { chapterNumberAt } from '@/components/library/meta-gating';
import { useBookCommunity } from '@/components/library/use-book-community';
import { toast } from '@/components/ui/toast';
import { contentKey } from '@/lib/content-key';
import { useLatest } from '@/lib/use-latest';
import { selectBookPosition, selectIsPlaying, usePlayer } from '@/playback/store';

import { usePlayerOnTop, usePlayerSheets } from '../player-sheets';
import { usePlayingTarget } from '../playing-target';
import { selectPlacedBookKey } from '../use-listening-position';
import type { PlayTarget } from '../use-play-book';
import { REVEAL_WATCH_START, revealOnCrossing, watchReveal } from './companion-model';
import { useCompanion } from './companion-store';

/** Open the full player on Who's who (the reveal toast's Show): the full player's sheet
 * host shows the companion where its measured layout keeps it (a sheet on a phone, the
 * column or the inline companion wider). */
export function showWhoIsWho(playerOnTop: boolean) {
  usePlayerSheets.getState().openCompanion('who');
  if (!playerOnTop) router.push('/player');
}

/**
 * Watches the playing book cross into its next chapter and, when that reveals people the
 * listener had not met, marks them "Just met" in Who's who and fires ONE toast ("New in
 * Who's who: Teft, Rock"). Store-driven (`usePlayer.subscribe`), so it sees every tick
 * without rendering; the rules are `watchReveal` (only a natural crossing while playing:
 * never a load, a resume, a seek or a skip, though a pause or a file change on the way is
 * fine) and `revealOnCrossing` (never anyone already met this session, never a finished
 * book). The chapter is read exactly as Who's who's gate reads it (`useListeningChapter`):
 * the exact live place, so the reveal lands at the chapter's start, and only once the
 * book's own place is known (`selectPlacedBookKey`), so the toast and the panel always
 * agree on who is there.
 */
function Watcher({
  target,
  characters,
  starts,
  finished,
}: {
  target: PlayTarget;
  characters: BookMetaCharacter[];
  starts: number[];
  finished: boolean;
}) {
  const { t } = useTranslation();
  const playerOnTop = usePlayerOnTop();
  // Read when Show is pressed, not when the toast went up: it lives 8 s, and the full
  // player may have opened or closed since.
  const onTopNow = useLatest(() => playerOnTop);
  const announce = useLatest((met: BookMetaCharacter[], chapter: number) => {
    const key = contentKey(target.connectionId, target.libraryId, target.path);
    useCompanion.getState().markJustMet(
      key,
      met.map((c) => c.id),
    );
    toast({
      title: t('player.companion.revealTitle', { names: met.map((c) => c.name).join(', ') }),
      description: t('player.companion.revealBody', { count: met.length, chapter }),
      action: { label: t('player.companion.show'), onPress: () => showWhoIsWho(onTopNow()) },
    });
  });

  useEffect(() => {
    if (characters.length === 0 || starts.length === 0) return;
    const key = contentKey(target.connectionId, target.libraryId, target.path);
    let watch = REVEAL_WATCH_START;
    const look = (s: ReturnType<typeof usePlayer.getState>) => {
      const position = selectBookPosition(s);
      const next =
        selectPlacedBookKey(s) === key
          ? {
              position,
              playing: selectIsPlaying(s),
              chapter: chapterNumberAt(starts, position),
            }
          : null;
      const seen = watchReveal(watch, next);
      watch = seen.watch;
      const c = seen.crossing;
      if (!c) return;
      const met = revealOnCrossing(characters, c.from, c.to, c.reached, finished);
      if (met.length > 0) announce(met, c.to.chapter);
    };
    // The first look is where the book is now: a load or a resume, never a crossing.
    look(usePlayer.getState());
    return usePlayer.subscribe(look);
  }, [characters, starts, finished, target, announce]);
  return null;
}

/** The playing book's community cast and chapter starts (the book page's gate inputs,
 * `useBookCommunity`), then the watcher. Renders nothing. */
function BookWatch({ target }: { target: PlayTarget }) {
  const { enabled, chapterStarts, work } = useBookCommunity(target);
  const { data: progress } = useBookProgress(
    target.libraryId,
    target.path,
    enabled,
    target.connectionId,
  );
  const characters = work?.characters;
  if (!characters || characters.length === 0 || progress === undefined) return null;
  return (
    <Watcher
      target={target}
      characters={characters}
      starts={chapterStarts}
      finished={!!progress?.finished}
    />
  );
}

/**
 * The reveal toast's listener (STYLEGUIDE section 8, "Companion": a character whose
 * chapter you just crossed animates in, plus a toast), mounted ONCE at the root so it
 * fires wherever the listener is: the full player, any page, the lock screen's return.
 */
export function CompanionRevealListener() {
  const target = usePlayingTarget();
  if (!target) return null;
  return (
    <ConnectionScope connectionId={target.connectionId}>
      <BookWatch target={target} />
    </ConnectionScope>
  );
}
