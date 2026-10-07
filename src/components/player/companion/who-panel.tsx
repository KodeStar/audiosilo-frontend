import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { FadeInUp, LayoutAnimationConfig, ReduceMotion } from 'react-native-reanimated';

import { CharacterCard } from '@/components/library/book-meta';
import { splitCharacters } from '@/components/library/meta-gating';
import { EmptyState } from '@/components/ui/empty-state';
import { Text } from '@/components/ui/text';

import { whoOrder } from './companion-model';
import { Attribution, SpoilerStrip } from './companion-pieces';
import { selectJustMet, selectRevealed, useCompanion } from './companion-store';
import type { CompanionData } from './use-companion-data';

/** A character a natural crossing just revealed springs in (STYLEGUIDE section 6,
 * "Reveal"); reduced motion shows it at once. */
const REVEAL = FadeInUp.springify().damping(16).reduceMotion(ReduceMotion.System);

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
      <EmptyState
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
              <CharacterCard character={c} justMet={fresh} />
            </Animated.View>
          );
        })}
      </LayoutAnimationConfig>
      <SpoilerStrip
        count={hidden.length}
        title={t('player.companion.charactersHidden', { count: hidden.length })}
        hint={t('player.companion.charactersHiddenHint')}
        shown={shown}
        onToggle={() => setRevealed(data.key, !shown)}
      />
      {shown ? hidden.map((c) => <CharacterCard key={c.id} character={c} spoiler />) : null}
      <Attribution attribution={data.attribution} className="mt-2" />
    </View>
  );
}
