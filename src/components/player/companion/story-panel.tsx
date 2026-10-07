import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { FadeIn, LayoutAnimationConfig, ReduceMotion } from 'react-native-reanimated';

import type { BookMetaRecap } from '@/api/types';
import { RecapSummaryBlock, SpoilerChip, summaryIsVisible } from '@/components/library/book-meta';
import { Text } from '@/components/ui/text';

import { storySoFar } from './companion-model';
import { Attribution, CompanionEmpty, HiddenStrip } from './companion-pieces';
import { selectRevealed, useCompanion } from './companion-store';
import type { CompanionData } from './use-companion-data';

/** A part of the story that arrives while the panel is open (the listener finished a
 * chapter) fades in; reduced motion shows it at once. */
const ARRIVE = FadeIn.duration(520).reduceMotion(ReduceMotion.System);

/** One part of the story: the recap text, set for reading, with a small heading for the
 * parts that sit outside the book's chapters ("Previously, in earlier books"). */
function StoryPart({ recap, spoiler }: { recap: BookMetaRecap; spoiler?: boolean }) {
  const { t } = useTranslation();
  const heading =
    recap.through.chapter === 0
      ? recap.scope === 'series'
        ? t('book.meta.recapSeriesPrior')
        : t('book.meta.recapBeforeBook')
      : spoiler
        ? t('book.meta.recapUpToChapter', { chapter: recap.through.chapter })
        : null;
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
 * anyway, the one reveal shared with Who's who.
 */
export function StoryPanel({ data }: { data: CompanionData }) {
  const { t } = useTranslation();
  const shown = useCompanion(selectRevealed(data.key));
  const setRevealed = useCompanion((s) => s.setRevealed);

  if (data.status === 'loading' || data.status === 'off') return null;
  const summaryVisible = summaryIsVisible(data.summary, data.listening.finished);
  if (data.status === 'none' || (data.recaps.length === 0 && !summaryVisible)) {
    return (
      <CompanionEmpty
        icon="book-open"
        title={t('player.companion.storyEmptyTitle')}
        hint={t('player.companion.storyEmptyHint')}
      />
    );
  }

  const story = storySoFar(data.recaps, data.listening);
  return (
    <View className="gap-4">
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
      {summaryVisible ? (
        <RecapSummaryBlock summary={data.summary} finished={data.listening.finished} />
      ) : null}
      <HiddenStrip
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
      <Attribution attribution={data.attribution} className="mt-1" />
    </View>
  );
}
