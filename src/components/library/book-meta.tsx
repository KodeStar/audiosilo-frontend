import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { useBookMeta } from '@/api/hooks';
import type {
  BookMeta,
  BookMetaCharacter,
  BookMetaPosition,
  BookMetaRecap,
  BookMetaSeries,
  BookMetaSeriesWork,
} from '@/api/types';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/support';
import { colors } from '@/theme/tokens';

/** Descriptions past this many characters get a collapse + "show more" toggle.
 * A deterministic length heuristic (rather than an onTextLayout measure pass) so
 * the toggle never flashes and the choice is unit-testable. */
const LONG_DESCRIPTION_CHARS = 300;

/** Whether a description is long enough to warrant the collapse toggle. */
export function descriptionIsLong(text: string | undefined): boolean {
  return (text?.length ?? 0) > LONG_DESCRIPTION_CHARS;
}

/** The series works to show in a rail: every work except the one being viewed. */
export function seriesRailWorks(
  series: BookMetaSeries,
  currentWorkId: string,
): BookMetaSeriesWork[] {
  return series.works.filter((w) => w.id !== currentWorkId);
}

/** The translation key for each recognised role. An unexpected upstream value
 * (typed as one of these, but defensively looked up) yields no badge rather than
 * a missing translation. */
const ROLE_LABEL_KEY = {
  protagonist: 'book.meta.role.protagonist',
  antagonist: 'book.meta.role.antagonist',
  supporting: 'book.meta.role.supporting',
  minor: 'book.meta.role.minor',
} as const;

/** The translation key for a character's role, or undefined when the role is
 * absent or unrecognised (so the badge is simply skipped). */
export function roleLabelKey(
  role: BookMetaCharacter['role'],
): (typeof ROLE_LABEL_KEY)[keyof typeof ROLE_LABEL_KEY] | undefined {
  return role ? ROLE_LABEL_KEY[role] : undefined;
}

/** Whether a character is revealed "from the start" (chapter 0 or 1) rather than
 * at a named later chapter. Kept pure so the label choice is unit-testable. */
export function revealFromStart(reveal: BookMetaPosition): boolean {
  return reveal.chapter <= 1;
}

/** How to head a recap. A chapter-0 "series" recap is the prior-books catch-up;
 * a chapter-0 "book" recap is a pre-book note; otherwise it covers up to chapter
 * N. Returns a descriptor the component maps to a translated string. */
export type RecapDescriptor =
  | { kind: 'seriesPrior' }
  | { kind: 'beforeBook' }
  | { kind: 'upToChapter'; chapter: number };
export function recapDescriptor(recap: BookMetaRecap): RecapDescriptor {
  const ch = recap.through.chapter;
  if (ch === 0) return recap.scope === 'series' ? { kind: 'seriesPrior' } : { kind: 'beforeBook' };
  return { kind: 'upToChapter', chapter: ch };
}

/** Recaps ordered by position (ascending) so "story so far" reads in order. The
 * server already returns them ordered; this keeps the component independent of
 * that. Returns a new array; does not mutate the input. */
export function sortRecaps(recaps: BookMetaRecap[]): BookMetaRecap[] {
  return [...recaps].sort((a, b) => a.through.chapter - b.through.chapter);
}

/**
 * Enriched community metadata for a book (description, production details, and a
 * "more in this series" rail), shown beneath the file/chapter list on the book
 * screen. Progressive enhancement: the caller always mounts this and passes
 * `enabled` (server `metadata` capability AND the book has an asin/isbn to match);
 * the hook's `enabled` gate prevents the fetch when off, and the component renders
 * nothing while loading, on error, or when the service returns no match - so the
 * page never regresses when metadata is unavailable.
 */
export function BookMetaSection({
  libraryId,
  path,
  enabled,
}: {
  libraryId: number;
  path: string;
  enabled: boolean;
}) {
  const { data } = useBookMeta(libraryId, path, enabled);

  if (!enabled || !data || !data.matched) return null;
  return <MatchedMeta meta={data} />;
}

/** One character card: name, optional role badge + aliases, and a "first appears"
 * line always visible; the description is a per-card accordion, closed by default
 * (spoiler-safe) and opened by tapping the card. Cards with no description are
 * static (not tappable). */
function CharacterCard({ character }: { character: BookMetaCharacter }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const fromStart = revealFromStart(character.reveal);
  const roleKey = roleLabelKey(character.role);
  const hasDescription = !!character.description;
  return (
    <View className="rounded-xl border border-black/10 bg-black/[0.02] dark:border-white/10 dark:bg-white/[0.03]">
      <AnimatedPressable
        onPress={hasDescription ? () => setOpen((v) => !v) : undefined}
        disabled={!hasDescription}
        accessibilityRole={hasDescription ? 'button' : undefined}
        accessibilityState={hasDescription ? { expanded: open } : undefined}
        className="p-3"
      >
        <View className="flex-row items-start justify-between gap-2">
          <View className="flex-1">
            <Text variant="subtitle" className="font-roboto-medium">
              {character.name}
            </Text>
            {character.aliases && character.aliases.length > 0 ? (
              <Text variant="caption" className="mt-0.5">
                {t('book.meta.alsoKnownAs', { names: character.aliases.join(', ') })}
              </Text>
            ) : null}
            <Text variant="caption" className="mt-1 text-primary">
              {fromStart
                ? t('book.meta.revealFromStart')
                : t('book.meta.revealFromChapter', { chapter: character.reveal.chapter })}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            {roleKey ? (
              <View className="rounded-full bg-primary/10 px-2 py-0.5 dark:bg-primary/15">
                <Text className="text-[10px] font-roboto-medium uppercase text-primary dark:text-primary-400">
                  {t(roleKey)}
                </Text>
              </View>
            ) : null}
            {hasDescription ? (
              <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} color={colors.primary} />
            ) : null}
          </View>
        </View>
        {open ? (
          <Text variant="body" className="mt-2">
            {character.description}
          </Text>
        ) : null}
      </AnimatedPressable>
    </View>
  );
}

/** The cast: spoiler-aware character cards, each an independent accordion (the
 * description reveals on tap). Renders nothing when empty. */
function CharactersBlock({ characters }: { characters: BookMetaCharacter[] }) {
  const { t } = useTranslation();
  if (characters.length === 0) return null;
  return (
    <View className="gap-2">
      <SectionHeader title={t('book.meta.characters')} />
      <View className="gap-2">
        {characters.map((c) => (
          <CharacterCard key={c.id} character={c} />
        ))}
      </View>
    </View>
  );
}

/** One "story so far" recap: a collapsible row, closed by default (spoiler-safe)
 * until the reader opens it. */
function RecapRow({ recap, first }: { recap: BookMetaRecap; first: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const d = recapDescriptor(recap);
  const heading =
    d.kind === 'seriesPrior'
      ? t('book.meta.recapSeriesPrior')
      : d.kind === 'beforeBook'
        ? t('book.meta.recapBeforeBook')
        : t('book.meta.recapUpToChapter', { chapter: d.chapter });
  return (
    <View className={first ? '' : 'border-t border-black/10 dark:border-white/10'}>
      <AnimatedPressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center justify-between gap-2 px-3 py-2.5"
      >
        <Text variant="subtitle" className="flex-1 font-roboto-medium">
          {heading}
        </Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} color={colors.primary} />
      </AnimatedPressable>
      {open ? (
        <Text variant="body" className="px-3 pb-3">
          {recap.text}
        </Text>
      ) : null}
    </View>
  );
}

/** "Story so far": position-keyed recaps as an accordion, ordered by position and
 * closed by default so the reader opens only as far as they have listened. */
function RecapsBlock({ recaps }: { recaps: BookMetaRecap[] }) {
  const { t } = useTranslation();
  if (recaps.length === 0) return null;
  const ordered = sortRecaps(recaps);
  return (
    <View className="gap-2">
      <SectionHeader title={t('book.meta.storySoFar')} />
      <View className="overflow-hidden rounded-xl border border-black/10 dark:border-white/10">
        {ordered.map((r, i) => (
          <RecapRow key={`${r.through.chapter}-${i}`} recap={r} first={i === 0} />
        ))}
      </View>
    </View>
  );
}

function MatchedMeta({ meta }: { meta: Extract<BookMeta, { matched: true }> }) {
  const { t } = useTranslation();
  const { work, recording, series, web_url } = meta;
  const [expanded, setExpanded] = useState(false);

  const description = work.description?.trim() ?? '';
  const canCollapse = descriptionIsLong(description);
  const abridged = !!recording?.abridged;

  // Compact detail rows. Narrator + runtime are shown elsewhere on the screen, so
  // they are intentionally omitted here.
  const details: { label: string; value: string }[] = [];
  if (recording?.publisher)
    details.push({ label: t('book.meta.publisher'), value: recording.publisher });
  if (recording?.release_date)
    details.push({ label: t('book.meta.released'), value: recording.release_date });
  if (work.first_published)
    details.push({ label: t('book.meta.firstPublished'), value: work.first_published });

  const rails = (series ?? [])
    .map((s) => ({ series: s, works: seriesRailWorks(s, work.id) }))
    .filter((r) => r.works.length > 0);
  const multipleSeries = rails.length > 1;

  const hasAbout = description.length > 0 || details.length > 0 || abridged;

  return (
    <View className="gap-6">
      {hasAbout ? (
        <View className="gap-2">
          <SectionHeader title={t('book.meta.about')} />
          {description.length > 0 ? (
            <View className="gap-1">
              <Text variant="body" numberOfLines={expanded || !canCollapse ? undefined : 6}>
                {description}
              </Text>
              {canCollapse ? (
                <AnimatedPressable
                  onPress={() => setExpanded((v) => !v)}
                  hitSlop={8}
                  accessibilityRole="button"
                  className="flex-row items-center gap-1 self-start py-0.5"
                >
                  <Text className="text-sm font-roboto-medium text-primary">
                    {expanded ? t('book.meta.showLess') : t('book.meta.showMore')}
                  </Text>
                  <Icon
                    name={expanded ? 'chevron-up' : 'chevron-down'}
                    size={12}
                    color={colors.primary}
                  />
                </AnimatedPressable>
              ) : null}
            </View>
          ) : null}
          {details.length > 0 || abridged ? (
            <View className="mt-1 gap-1.5">
              {details.map((d) => (
                <View key={d.label} className="flex-row gap-2">
                  <Text variant="muted" className="w-32">
                    {d.label}
                  </Text>
                  <Text variant="subtitle" className="flex-1">
                    {d.value}
                  </Text>
                </View>
              ))}
              {abridged ? (
                <View className="mt-0.5 self-start rounded-full bg-primary/10 px-2.5 py-1 dark:bg-primary/15">
                  <Text className="text-xs font-roboto-medium text-primary dark:text-primary-400">
                    {t('book.meta.abridged')}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      <CharactersBlock characters={work.characters ?? []} />
      <RecapsBlock recaps={work.recaps ?? []} />

      {rails.map(({ series: s, works }) => (
        <View key={s.id} className="gap-2">
          <SectionHeader
            title={
              multipleSeries
                ? t('book.meta.moreInNamedSeries', { series: s.name })
                : t('book.meta.moreInSeries')
            }
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-3 pb-1"
          >
            {works.map((w) => (
              <AnimatedPressable
                key={w.id}
                onPress={() => void openExternalUrl(w.web_url)}
                accessibilityRole="link"
                accessibilityLabel={w.title}
                className="w-28"
              >
                <View className="overflow-hidden rounded-lg border border-black/10 shadow-sm dark:border-white/10 dark:shadow-none">
                  <Cover source={w.cover_url ?? null} label={w.title} />
                </View>
                {w.position ? (
                  <Text variant="caption" className="mt-1.5">
                    {t('book.meta.seriesPosition', { position: w.position })}
                  </Text>
                ) : null}
                <Text variant="subtitle" numberOfLines={2} className="mt-0.5">
                  {w.title}
                </Text>
              </AnimatedPressable>
            ))}
          </ScrollView>
        </View>
      ))}

      <AnimatedPressable
        onPress={() => void openExternalUrl(web_url)}
        accessibilityRole="link"
        className="flex-row items-center gap-2 self-start py-1"
      >
        <Icon name="library" size={14} color={colors.primary} />
        <Text className="text-sm font-roboto-medium text-primary">{t('book.meta.viewOnMeta')}</Text>
        <Icon name="chevron-right" size={12} color={colors.primary} />
      </AnimatedPressable>
    </View>
  );
}
