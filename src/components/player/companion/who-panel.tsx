import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import Animated, { FadeInUp, LayoutAnimationConfig, ReduceMotion } from 'react-native-reanimated';

import type { BookMetaCharacter } from '@/api/types';
import { roleLabelKey, revealFromStart, SpoilerChip } from '@/components/library/book-meta';
import { splitCharacters } from '@/components/library/meta-gating';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { whoOrder } from './companion-model';
import { Attribution, CharacterToken, CompanionEmpty, HiddenStrip } from './companion-pieces';
import { selectJustMet, selectRevealed, useCompanion } from './companion-store';
import type { CompanionData } from './use-companion-data';

/** A character a natural crossing just revealed springs in (STYLEGUIDE section 6,
 * "Reveal"); reduced motion shows it at once. */
const REVEAL = FadeInUp.springify().damping(16).reduceMotion(ReduceMotion.System);

/**
 * One person in Who's who: their token, name and role, the names they also go by, when
 * they first appear, and what the community wrote about them behind a tap (as on the
 * book page: a description is written for the whole book, so it is never shown
 * unasked). `justMet` marks someone the listener just crossed into (pink outline and
 * "Just met"); `spoiler` someone shown only because the listener asked.
 */
function WhoCard({
  character,
  justMet,
  spoiler,
}: {
  character: BookMetaCharacter;
  justMet?: boolean;
  spoiler?: boolean;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const [open, setOpen] = useState(false);
  const roleKey = roleLabelKey(character.role);
  const hasDescription = !!character.description?.trim();
  return (
    <AnimatedPressable
      onPress={hasDescription ? () => setOpen((v) => !v) : undefined}
      disabled={!hasDescription}
      accessibilityRole={hasDescription ? 'button' : undefined}
      accessibilityState={hasDescription ? { expanded: open } : undefined}
      testID={`who-${character.id}`}
      className={cn(
        'flex-row gap-3 rounded-card border bg-card p-3.5',
        justMet ? 'border-brand' : 'border-border',
        spoiler && 'opacity-80',
        hasDescription && Platform.select({ web: `cursor-pointer ${FOCUS_RING_CLASS}` }),
      )}
      style={justMet ? { borderWidth: 2 } : undefined}
    >
      <CharacterToken name={character.name} />
      <View className="min-w-0 flex-1 gap-0.5">
        {justMet ? (
          <Text variant="eyebrow" className="text-brand-ink">
            {t('player.companion.justMet')}
          </Text>
        ) : null}
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
          <Text variant="label" className="text-[15px]">
            {character.name}
          </Text>
          {roleKey ? <Text variant="caption">{t(roleKey)}</Text> : null}
          {spoiler ? <SpoilerChip /> : null}
        </View>
        {character.aliases && character.aliases.length > 0 ? (
          <Text variant="caption" className="text-subtle-foreground">
            {t('book.meta.alsoKnownAs', { names: character.aliases.join(', ') })}
          </Text>
        ) : null}
        <Text variant="caption" className="text-subtle-foreground">
          {revealFromStart(character.reveal)
            ? t('player.companion.firstAppearsStart')
            : t('player.companion.firstAppears', { chapter: character.reveal.chapter })}
        </Text>
        {open ? (
          <Text variant="body" className="mt-1.5 text-sm leading-5">
            {character.description}
          </Text>
        ) : null}
      </View>
      {hasDescription ? (
        <Icon
          name={open ? 'chevron-up' : 'chevron-down'}
          size={14}
          color={themed.mutedForeground}
        />
      ) : null}
    </AnimatedPressable>
  );
}

/**
 * Who's who (STYLEGUIDE section 8, "Companion"): the people the listener has met, newest
 * first, gated by their place in the book exactly as the book page's Characters tab is
 * (`meta-gating.ts`); the rest counted, never named, behind Show anyway (one reveal for
 * this book, shared with Story so far). Someone a natural chapter crossing just revealed
 * springs in at the top with a pink outline and "Just met". Nothing while the community
 * data loads; a kind note when there is none.
 */
export function WhoPanel({ data }: { data: CompanionData }) {
  const { t } = useTranslation();
  const shown = useCompanion(selectRevealed(data.key));
  const justMet = useCompanion(selectJustMet(data.key));
  const setRevealed = useCompanion((s) => s.setRevealed);

  if (data.status === 'loading' || data.status === 'off') return null;
  if (data.status === 'none' || data.characters.length === 0) {
    return (
      <CompanionEmpty
        icon="users"
        title={t('player.companion.whoEmptyTitle')}
        hint={t('player.companion.whoEmptyHint')}
      />
    );
  }

  const { visible, hidden } = splitCharacters(data.characters, data.listening);
  const met = whoOrder(visible);
  return (
    <View className="gap-2.5">
      <Text variant="caption">{t('player.companion.metCount', { count: met.length })}</Text>
      {/* Skips the entrance of everyone already here when the panel mounts: only a
          character who arrives while it is open springs in. */}
      <LayoutAnimationConfig skipEntering>
        {met.map((c) => {
          const fresh = justMet.includes(c.id);
          return (
            <Animated.View key={c.id} entering={fresh ? REVEAL : undefined}>
              <WhoCard character={c} justMet={fresh} />
            </Animated.View>
          );
        })}
      </LayoutAnimationConfig>
      <HiddenStrip
        count={hidden.length}
        title={t('player.companion.charactersHidden', { count: hidden.length })}
        hint={t('player.companion.charactersHiddenHint')}
        shown={shown}
        onToggle={() => setRevealed(data.key, !shown)}
        tokens
      />
      {shown ? hidden.map((c) => <WhoCard key={c.id} character={c} spoiler />) : null}
      <Attribution attribution={data.attribution} className="mt-2" />
    </View>
  );
}
