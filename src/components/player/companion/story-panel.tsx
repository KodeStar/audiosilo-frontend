import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { FadeIn, LayoutAnimationConfig, ReduceMotion } from 'react-native-reanimated';

import type { BookMetaRecap } from '@/api/types';
import {
  GeneratedChip,
  RecapSummaryBlock,
  recapHeading,
  SpoilerChip,
  summaryIsVisible,
} from '@/components/library/book-meta';
import { recapMarks } from '@/components/library/meta-gating';
import { EmptyState } from '@/components/ui/empty-state';
import { Text } from '@/components/ui/text';

import { storySoFar } from './companion-model';
import { Attribution, SpoilerStrip } from './companion-pieces';
import { selectRevealed, useCompanion } from './companion-store';
import type { CompanionData } from './use-companion-data';

/** A part of the story that arrives while the panel is open (the listener finished a
 * chapter) fades in; reduced motion shows it at once. */
const ARRIVE = FadeIn.duration(520).reduceMotion(ReduceMotion.System);

/** One part of the story: the recap text, set for reading, with a small heading for the
 * parts that sit outside the book's chapters ("Previously, in earlier books"). */
function StoryPart({ recap, spoiler }: { recap: BookMetaRecap; spoiler?: boolean }) {
  const { t } = useTranslation();
  // In the reached story a part covering chapters needs no heading: the panel's own
  // "Up to chapter 22" says where it stops.
  const heading = recap.through.chapter === 0 || spoiler ? recapHeading(t, recap) : null;
  return (
    <View className="gap-1">
      {heading || spoiler ? (
        <View className="flex-row items-center gap-2">
          {heading ? <Text variant="eyebrow">{heading}</Text> : null}
          {spoiler ? <SpoilerChip /> : null}
        </View>
      ) : null}
      <Text variant="body" className="text-[15px] leading-6">
        {recap.text}
      </Text>
    </View>
  );
}

/**
 * Story so far (STYLEGUIDE section 8, "Companion"): the community recaps written to stop
 * where the listener is ("Up to chapter 22"), in order, gated exactly as the book page's
 * Recaps tab (a recap is shown once its last chapter is behind the listener). The
 * whole-book summary includes the ending, so for a book still in progress it sits behind
 * the shared spoiler accordion (`RecapSummaryBlock`). The rest is counted behind Show
 * anyway, the one reveal shared with Who's who. Recaps generated on this server are
 * marked so; an empty panel offers `generate` (an admin's "Generate characters and
 * recaps") under its note.
 */
export function StoryPanel({ data, generate }: { data: CompanionData; generate?: ReactNode }) {
  const { t } = useTranslation();
  const shown = useCompanion(selectRevealed(data.key));
  const setRevealed = useCompanion((s) => s.setRevealed);

  if (data.status === 'loading' || data.status === 'off') return null;
  const summaryVisible = summaryIsVisible(data.summary, data.listening.finished);
  if (data.status === 'none' || (data.recaps.length === 0 && !summaryVisible)) {
    return (
      <View>
        <EmptyState
          icon="book-open"
          title={t('player.companion.storyEmptyTitle')}
          hint={t('player.companion.storyEmptyHint')}
        />
        {generate}
      </View>
    );
  }

  const story = storySoFar(data.recaps, data.listening);
  // The list and the whole-book summary each carry their own source (Bridge 1e).
  const marks = recapMarks(data.generated, {
    list: data.recaps.length > 0,
    summary: summaryVisible,
  });
  return (
    <View className="gap-4">
      {marks.panel ? <GeneratedChip /> : null}
      {marks.list ? <GeneratedChip testID="recaps-generated-mark" /> : null}
      {data.recaps.length > 0 ? (
        <View className="gap-0.5">
          <Text variant="eyebrow">{t('book.meta.storySoFar')}</Text>
          <Text variant="heading">
            {story.upTo !== null
              ? t('book.meta.recapUpToChapter', { chapter: story.upTo })
              : t('player.companion.storyNotYet')}
          </Text>
          <Text variant="caption">
            {story.upTo !== null
              ? t('player.companion.storyStops', { chapter: story.upTo })
              : t('player.companion.storyNotYetHint')}
          </Text>
        </View>
      ) : null}
      <LayoutAnimationConfig skipEntering>
        {story.parts.map((r) => (
          <Animated.View key={`${r.scope ?? 'book'}-${r.through.chapter}`} entering={ARRIVE}>
            <StoryPart recap={r} />
          </Animated.View>
        ))}
      </LayoutAnimationConfig>
      {marks.summary ? <GeneratedChip testID="summary-generated-mark" /> : null}
      {summaryVisible ? (
        <RecapSummaryBlock summary={data.summary} finished={data.listening.finished} />
      ) : null}
      <SpoilerStrip
        token={false}
        count={story.hidden.length}
        title={t('player.companion.recapsHidden', { count: story.hidden.length })}
        hint={t('player.companion.recapsHiddenHint')}
        shown={shown}
        onToggle={() => setRevealed(data.key, !shown)}
      />
      {shown
        ? story.hidden.map((r) => (
            <StoryPart key={`h-${r.scope ?? 'book'}-${r.through.chapter}`} recap={r} spoiler />
          ))
        : null}
      {marks.credit ? <Attribution attribution={data.attribution} className="mt-1" /> : null}
    </View>
  );
}
