import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { CoverFrame } from '@/components/library/cover-frame';
import { useMetaWork } from '@/api/hooks';
import type {
  BookMeta,
  BookMetaCharacter,
  BookMetaPosition,
  BookMetaRecap,
  BookMetaRecapSummary,
  BookMetaSeriesWork,
  BookMetaWork,
} from '@/api/types';
import { NameToken } from '@/components/search/name-token';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Cover } from '@/components/ui/cover';
import { HORIZONTAL_SCROLLER } from '@/components/ui/horizontal-scroller';
import { Icon } from '@/components/ui/icon';
import { RowSurface } from '@/components/ui/row-surface';
import { SectionHeader } from '@/components/ui/section-header';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { familyName, orderingLabelKey } from '@/lib/series-orderings';
import { openExternalUrl } from '@/lib/support';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import {
  type ListeningProgress,
  recapDescriptor,
  sortRecaps,
  type Split,
  splitCharacters,
  splitRecaps,
} from './meta-gating';
import type { SeriesRail } from './series-rails';

/** Descriptions past this many characters get a collapse + "show more" toggle.
 * A deterministic length heuristic (rather than an onTextLayout measure pass) so
 * the toggle never flashes and the choice is unit-testable. */
const LONG_DESCRIPTION_CHARS = 300;

/** The matched half of the meta envelope - what every block below renders from. */
export type MatchedBookMeta = Extract<BookMeta, { matched: true }>;

/** The usable half of the meta envelope: the matched payload, or undefined when
 * the capability is off, the response has not arrived, or the service found no
 * match. One place decides "is there enriched metadata to show", so the screen's
 * About block and the metadata tabs can never disagree. */
export function matchedMeta(
  meta: BookMeta | undefined,
  enabled: boolean,
): MatchedBookMeta | undefined {
  if (!enabled || !meta || !meta.matched) return undefined;
  return meta;
}

/** Whether a description is long enough to warrant the collapse toggle. */
export function descriptionIsLong(text: string | undefined): boolean {
  return (text?.length ?? 0) > LONG_DESCRIPTION_CHARS;
}

/**
 * Whether a whole-work summary will actually RENDER anything. The ONE predicate
 * behind the summary: the book screen decides from it whether a Recaps tab exists
 * at all, and `RecapSummaryBlock` guards on it - so a tab can never open onto a
 * panel that withholds everything.
 *
 * `in_short` is NOT spoiler-free (it contains the ending), but it always renders
 * something - `RecapSummaryBlock` decides inline vs a tap-to-reveal row. The
 * `ending` counts only once `finished` says the ending is in play. The wire field
 * is omitted when absent, but a defensive empty-string check keeps an all-blank
 * payload from drawing an empty block.
 */
export function summaryIsVisible(
  summary: BookMetaRecapSummary | undefined,
  finished: boolean,
): boolean {
  return !!(summary?.in_short?.trim() || (summary?.ending?.trim() && finished));
}

/** The furthest book-scope recap of a work - the closest thing its position-keyed
 * recaps offer to a whole-book summary, used to catch up on an earlier book that
 * has no `recap_summary`. Series-scope recaps are skipped (they summarise OTHER
 * books); an absent scope counts as book scope. Undefined when there is none. */
export function lastBookRecap(recaps: BookMetaRecap[] | undefined): BookMetaRecap | undefined {
  const book = sortRecaps(recaps ?? []).filter((r) => r.scope !== 'series');
  return book.length > 0 ? book[book.length - 1] : undefined;
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

/** The tiny uppercase pill this block uses for both its markers (the spoiler chip, a
 * character's role): muted, so a card's only pink is its "Just met" state. */
function Chip({ label }: { label: string }) {
  return (
    <View className="rounded-full bg-muted px-2 py-0.5">
      <Text className="font-sans-medium text-[10px] uppercase text-muted-foreground">{label}</Text>
    </View>
  );
}

/** A small "spoiler" chip marking an entry the listener has not reached yet
 * (only ever rendered once they have chosen to show spoilers anyway). */
export function SpoilerChip() {
  const { t } = useTranslation();
  return <Chip label={t('book.meta.spoiler')} />;
}

/** The open/closed marker every collapsible thing in this block shares (and the book
 * page's About card): pink beside a pink link, `quiet` (muted) on a character card,
 * whose only pink is "Just met". */
export function DisclosureChevron({ open, quiet }: { open: boolean; quiet?: boolean }) {
  const themed = useThemeColors();
  return (
    <Icon
      name={open ? 'chevron-up' : 'chevron-down'}
      size={12}
      color={quiet ? themed.mutedForeground : themed.brand}
    />
  );
}

/**
 * The collapsible row this block is built from: a pressable header ending in the
 * chevron, revealing `children` once open. It owns the open state unless the caller
 * lifts it out with `open`/`onToggle` - which `PreviousBookRow` does, because its
 * lazy fetch is gated on the very same flag.
 */
function Disclosure({
  header,
  headerClassName,
  accessibilityLabel,
  open: controlledOpen,
  onToggle,
  className,
  children,
}: {
  /** The header row's content, left of the chevron. */
  header: React.ReactNode;
  /** Layout for the header row (padding/gap); `flex-row items-center` is implied. */
  headerClassName?: string;
  accessibilityLabel?: string;
  open?: boolean;
  onToggle?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  return (
    <View className={className}>
      <AnimatedPressable
        onPress={onToggle ?? (() => setLocalOpen((v) => !v))}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={accessibilityLabel}
        className={cn('flex-row items-center', headerClassName)}
      >
        {header}
        <DisclosureChevron open={open} />
      </AnimatedPressable>
      {open ? children : null}
    </View>
  );
}

/** The quiet link out to a work on AudioSilo Meta. `small` only tightens the
 * padding - the icon sizes are deliberately identical everywhere it appears. */
function ViewOnMetaLink({ url, small }: { url: string; small?: boolean }) {
  const themed = useThemeColors();
  const { t } = useTranslation();
  return (
    <AnimatedPressable
      onPress={() => void openExternalUrl(url)}
      accessibilityRole="link"
      className={`flex-row items-center gap-2 self-start ${small ? 'py-0.5' : 'py-1'}`}
    >
      <Icon name="library" size={14} color={themed.brand} />
      <Text className="font-sans-medium text-sm text-brand-ink">{t('book.meta.viewOnMeta')}</Text>
      <Icon name="chevron-right" size={12} color={themed.brand} />
    </AnimatedPressable>
  );
}

/** The rows a spoiler-gated tab renders: everything the listener has reached, then -
 * only once they have opted in - the withheld entries, each marked as a spoiler. */
function spoilerRows<T>({ visible, hidden }: Split<T>, showSpoilers: boolean) {
  return [
    ...visible.map((item) => ({ item, spoiler: false })),
    ...(showSpoilers ? hidden.map((item) => ({ item, spoiler: true })) : []),
  ];
}

/** The quiet footer row of a spoiler-gated tab: how many entries are held back,
 * and the toggle that reveals (or re-hides) them. Renders nothing when nothing
 * is being held back.
 *
 * The "N hidden" caption is dropped once they ARE shown - it would otherwise sit
 * next to the very entries it claims are hidden. The toggle stays either way (it
 * is how you re-hide them), and `justify-end` keeps it right-aligned with the
 * caption gone. */
function HiddenNotice({
  count,
  shown,
  onToggle,
}: {
  count: number;
  shown: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <View className="flex-row items-center justify-end gap-3 py-1">
      {!shown ? (
        <Text variant="caption" className="flex-1">
          {t('book.meta.hiddenCount', { count })}
        </Text>
      ) : null}
      <AnimatedPressable
        onPress={onToggle}
        hitSlop={8}
        accessibilityRole="button"
        className="flex-row items-center gap-1 py-0.5"
      >
        <Text className="font-sans-medium text-sm text-brand-ink">
          {shown ? t('book.meta.hideSpoilers') : t('book.meta.showAnyway')}
        </Text>
        <DisclosureChevron open={shown} />
      </AnimatedPressable>
    </View>
  );
}

/** One character card, the same wherever a character shows (the book page's
 * Characters tab, the player's Who's who): their token, name, optional role badge +
 * aliases, and a "first appears" line always visible; the description is a per-card
 * accordion, closed by default (spoiler-safe) and opened by tapping the card. Cards
 * with no description are static (not tappable). `spoiler` marks a card the listener
 * has not reached (shown only after they opted in); `justMet` one a chapter crossing
 * just revealed (Who's who: the pink outline and "Just met", the card's only pink). */
export function CharacterCard({
  character,
  spoiler,
  justMet,
}: {
  character: BookMetaCharacter;
  spoiler?: boolean;
  justMet?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const fromStart = revealFromStart(character.reveal);
  const roleKey = roleLabelKey(character.role);
  const hasDescription = !!character.description;
  return (
    <RowSurface
      testID={`character-${character.id}`}
      className={cn(spoiler && 'opacity-70', justMet && 'border-brand')}
      style={justMet ? { borderWidth: 2 } : undefined}
    >
      <AnimatedPressable
        onPress={hasDescription ? () => setOpen((v) => !v) : undefined}
        disabled={!hasDescription}
        accessibilityRole={hasDescription ? 'button' : undefined}
        accessibilityState={hasDescription ? { expanded: open } : undefined}
        className="flex-row items-start gap-3 p-3"
      >
        <NameToken name={character.name} kind="character" size={36} />
        <View className="min-w-0 flex-1">
          {justMet ? (
            <Text variant="eyebrow" className="mb-0.5 text-brand-ink">
              {t('player.companion.justMet')}
            </Text>
          ) : null}
          <View className="flex-row items-start justify-between gap-2">
            <View className="flex-1">
              <Text variant="label">{character.name}</Text>
              {character.aliases && character.aliases.length > 0 ? (
                <Text variant="caption" className="mt-0.5">
                  {t('book.meta.alsoKnownAs', { names: character.aliases.join(', ') })}
                </Text>
              ) : null}
              <Text variant="caption" className="mt-1">
                {fromStart
                  ? t('book.meta.revealFromStart')
                  : t('book.meta.revealFromChapter', { chapter: character.reveal.chapter })}
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              {spoiler ? <SpoilerChip /> : null}
              {roleKey ? <Chip label={t(roleKey)} /> : null}
              {hasDescription ? <DisclosureChevron open={open} quiet /> : null}
            </View>
          </View>
          {open ? (
            <Text variant="body" className="mt-2">
              {character.description}
            </Text>
          ) : null}
        </View>
      </AnimatedPressable>
    </RowSurface>
  );
}

/** The heading of a recap ("Previously, in earlier books", "Before this book", "Up to
 * chapter 22"), from `recapDescriptor`: the book page's recap rows and the player's
 * Story so far say it the same way. */
export function recapHeading(t: TFunction, recap: BookMetaRecap): string {
  const d = recapDescriptor(recap);
  return d.kind === 'seriesPrior'
    ? t('book.meta.recapSeriesPrior')
    : d.kind === 'beforeBook'
      ? t('book.meta.recapBeforeBook')
      : t('book.meta.recapUpToChapter', { chapter: d.chapter });
}

/** One "story so far" recap: a collapsible row, closed by default (spoiler-safe)
 * until the reader opens it. */
function RecapRow({
  recap,
  first,
  spoiler,
}: {
  recap: BookMetaRecap;
  first: boolean;
  spoiler?: boolean;
}) {
  const { t } = useTranslation();
  const heading = recapHeading(t, recap);
  return (
    <Disclosure
      className={first ? '' : 'border-t border-border'}
      headerClassName="justify-between gap-2 px-3 py-2.5"
      header={
        <>
          <Text variant="label" className={`flex-1 ${spoiler ? 'opacity-70' : ''}`}>
            {heading}
          </Text>
          {spoiler ? <SpoilerChip /> : null}
        </>
      }
    >
      <Text variant="body" className="px-3 pb-3">
        {recap.text}
      </Text>
    </Disclosure>
  );
}

/** The quiet link out to a work on AudioSilo Meta, with an optional caption above
 * it. Used wherever a previous book has nothing to show (no recap, no cast, or the
 * fetch failed): the reader still gets somewhere to go. The url comes from the
 * series RAIL entry - the fetched work payload carries no `web_url`. */
function PreviousBookNote({ message, url }: { message: string; url: string }) {
  return (
    <View className="gap-1">
      <Text variant="caption">{message}</Text>
      <ViewOnMetaLink url={url} small />
    </View>
  );
}

/** What a previous-book row renders once its work has loaded: the Recaps or the
 * Characters body, so both tabs share ONE accordion scaffold (row chrome, lazy
 * fetch, loading + failure states). */
type PreviousBookBody = React.ComponentType<{ work: BookMetaWork; entry: BookMetaSeriesWork }>;

/** One earlier book: a closed accordion whose work is fetched only when it is
 * opened (never eagerly - a long series would otherwise fan out a request per
 * book). Every failure - a 404 from a server without the route, a down meta
 * service - is a quiet caption plus the link out, never an error banner. */
function PreviousBookRow({
  entry,
  first,
  body: Body,
}: {
  entry: BookMetaSeriesWork;
  first: boolean;
  body: PreviousBookBody;
}) {
  const { t } = useTranslation();
  // Open state lives here (not inside `Disclosure`) because the lazy fetch is
  // gated on it: a closed row must never request its work.
  const [open, setOpen] = useState(false);
  const { data, isError } = useMetaWork(entry.id, open);
  return (
    <Disclosure
      className={first ? '' : 'border-t border-border'}
      headerClassName="gap-3 px-3 py-2.5"
      accessibilityLabel={entry.title}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      header={
        <>
          <View className="w-10 overflow-hidden rounded-sm border border-black/10 dark:border-white/10">
            <Cover source={entry.cover_url ?? null} rounded="rounded-sm" />
          </View>
          <View className="flex-1">
            {entry.position ? (
              <Text variant="caption">
                {t('book.meta.seriesPosition', { position: entry.position })}
              </Text>
            ) : null}
            <Text variant="label" numberOfLines={2}>
              {entry.title}
            </Text>
          </View>
        </>
      }
    >
      <View className="gap-2 px-3 pb-3">
        {/* An answer in hand wins over a failed refetch: a downloaded book's kept work
            is stale offline, and its refetch fails there. */}
        {data ? (
          <Body work={data} entry={entry} />
        ) : isError ? (
          <PreviousBookNote message={t('book.meta.couldntLoad')} url={entry.web_url} />
        ) : (
          <SkeletonText lines={3} className="py-1" />
        )}
      </View>
    </Disclosure>
  );
}

/**
 * The "Previous books" catch-up block appended to the Recaps and Characters tabs:
 * one accordion row per earlier book in the series, most recent first. Renders
 * nothing when there is no earlier book (an unparsable position, book one, a
 * standalone).
 */
function PreviousBooksSection({
  works,
  body,
}: {
  works: BookMetaSeriesWork[];
  body: PreviousBookBody;
}) {
  const { t } = useTranslation();
  if (works.length === 0) return null;
  return (
    <View className="mt-2 gap-2">
      <SectionHeader title={t('book.meta.previousBooks')} />
      <View className="overflow-hidden rounded-xl border border-border">
        {works.map((w, i) => (
          <PreviousBookRow key={w.id} entry={w} first={i === 0} body={body} />
        ))}
      </View>
    </View>
  );
}

/** A spoiler paragraph behind its own deliberate tap: a bordered header row
 * (`label` + spoiler chip) whose `text` is only mounted once opened, so a closed
 * row leaks nothing to a screen reader or the web DOM. Used for a work's ending
 * (a previous book always; the current book only once finished) and for the
 * current book's whole-book summary while the listener is still in it. */
function SpoilerAccordion({ label, text }: { label: string; text: string }) {
  return (
    <Disclosure
      className="rounded-lg border border-border"
      headerClassName="gap-2 px-3 py-2"
      header={
        <>
          <Text variant="label" className="flex-1">
            {label}
          </Text>
          <SpoilerChip />
        </>
      }
    >
      <Text variant="body" className="px-3 pb-3">
        {text}
      </Text>
    </Disclosure>
  );
}

/** A work's whole-book summary. `in_short` contains the ending too, so `finished`
 * (the caller's decision: always true for a previous book, only a FINISHED current
 * book) governs both fields: once finished, "In short" renders inline followed by
 * the "How it ends" spoiler row; before that, `in_short` sits behind a collapsed
 * "Whole-book summary" spoiler row and the ending is not offered at all. Null when
 * there is nothing (see `summaryIsVisible`). */
export function RecapSummaryBlock({
  summary,
  finished,
}: {
  summary: BookMetaRecapSummary | undefined;
  finished: boolean;
}) {
  const { t } = useTranslation();
  const inShort = summary?.in_short?.trim();
  const ending = summary?.ending?.trim();
  // Same predicate the screen gates the Recaps TAB on, so the two can't disagree.
  if (!summaryIsVisible(summary, finished)) return null;
  return (
    <View className="gap-2">
      {inShort ? (
        finished ? (
          <View className="gap-1">
            <Text variant="caption" className="uppercase">
              {t('book.meta.inShort')}
            </Text>
            <Text variant="body">{inShort}</Text>
          </View>
        ) : (
          <SpoilerAccordion label={t('book.meta.wholeBookSummary')} text={inShort} />
        )
      ) : null}
      {ending && finished ? (
        <SpoilerAccordion label={t('book.meta.howItEnds')} text={ending} />
      ) : null}
    </View>
  );
}

/** A previous book's recap body: its whole-work summary (ending included - the
 * reader opened this earlier book's row deliberately), else its furthest
 * book-scope "story so far", else a quiet note. */
function PreviousRecapBody({ work, entry }: { work: BookMetaWork; entry: BookMetaSeriesWork }) {
  const { t } = useTranslation();
  // `finished` is true throughout: the reader opened this EARLIER book's row
  // deliberately, so its summary renders inline and its ending is fair game.
  if (summaryIsVisible(work.recap_summary, true))
    return <RecapSummaryBlock summary={work.recap_summary} finished />;
  const fallback = lastBookRecap(work.recaps);
  if (fallback) return <Text variant="body">{fallback.text}</Text>;
  return <PreviousBookNote message={t('book.meta.noRecap')} url={entry.web_url} />;
}

/** A previous book's character body: the same cards as the Characters tab, with
 * no spoiler gating (same reason). */
function PreviousCharactersBody({
  work,
  entry,
}: {
  work: BookMetaWork;
  entry: BookMetaSeriesWork;
}) {
  const { t } = useTranslation();
  const cast = work.characters ?? [];
  if (cast.length === 0)
    return <PreviousBookNote message={t('book.meta.noCharacters')} url={entry.web_url} />;
  return (
    <View className="gap-2">
      {cast.map((c) => (
        <CharacterCard key={c.id} character={c} />
      ))}
    </View>
  );
}

/** The spoiler reveal, held by the SCREEN and shared by both gated tabs, so
 * revealing in one and switching to the other does not re-hide everything. */
type SpoilerReveal = {
  showSpoilers: boolean;
  onToggleSpoilers: () => void;
};

/**
 * The Characters tab: spoiler-gated character cards, each an independent
 * accordion (the description reveals on tap). Cards for parts of the book the
 * listener has not reached are withheld behind the shared "show anyway" toggle.
 *
 * Takes plain data rather than fetching, so the screen keeps ONE `useBookMeta`;
 * the "catch up on previous books" block appended below is the sibling that
 * arrangement was for (its rows fetch their own work, lazily, on open).
 */
export function BookMetaCharactersTab({
  characters,
  progress,
  showSpoilers,
  onToggleSpoilers,
  previousBooks = [],
}: SpoilerReveal & {
  characters: BookMetaCharacter[];
  progress: ListeningProgress;
  /** Earlier books of the series, for the catch-up block (see `previousWorks`). */
  previousBooks?: BookMetaSeriesWork[];
}) {
  const split = splitCharacters(characters, progress);
  const rows = spoilerRows(split, showSpoilers);
  return (
    <View className="gap-2">
      {rows.map(({ item, spoiler }) => (
        <CharacterCard key={item.id} character={item} spoiler={spoiler} />
      ))}
      <HiddenNotice count={split.hidden.length} shown={showSpoilers} onToggle={onToggleSpoilers} />
      <PreviousBooksSection works={previousBooks} body={PreviousCharactersBody} />
    </View>
  );
}

/**
 * The Recaps tab: position-keyed "story so far" recaps as an accordion, ordered
 * by position and closed by default. Recaps covering chapters the listener has
 * not finished are withheld behind the shared "show anyway" toggle.
 * Data in, JSX out - see `BookMetaCharactersTab` for why.
 */
export function BookMetaRecapsTab({
  recaps,
  progress,
  summary,
  summaryVisible,
  showSpoilers,
  onToggleSpoilers,
  previousBooks = [],
}: SpoilerReveal & {
  recaps: BookMetaRecap[];
  progress: ListeningProgress;
  /** This book's own whole-work summary, when the service has one. Until the
   * listener has FINISHED, its `in_short` (which includes the ending) sits behind a
   * deliberate tap on its "Whole-book summary" row and its `ending` is not offered
   * at all - the position-keyed recaps below already cover where they are. */
  summary?: BookMetaRecapSummary;
  /** Whether that summary actually renders - the SCREEN's single predicate (it
   * decides whether this tab exists at all from the same flag), so a tab can never
   * open onto a panel that withholds everything. */
  summaryVisible: boolean;
  /** Earlier books of the series, for the catch-up block (see `previousWorks`). */
  previousBooks?: BookMetaSeriesWork[];
}) {
  const { t } = useTranslation();
  const split = splitRecaps(sortRecaps(recaps), progress);
  const rows = spoilerRows(split, showSpoilers);
  return (
    <View className="gap-3">
      {summaryVisible ? <RecapSummaryBlock summary={summary} finished={progress.finished} /> : null}
      {rows.length > 0 ? (
        <View className="gap-2">
          {summaryVisible ? <SectionHeader title={t('book.meta.storySoFar')} /> : null}
          <View className="overflow-hidden rounded-xl border border-border">
            {rows.map(({ item, spoiler }, i) => (
              <RecapRow
                key={`${item.through.chapter}-${i}`}
                recap={item}
                first={i === 0}
                spoiler={spoiler}
              />
            ))}
          </View>
        </View>
      ) : null}
      <HiddenNotice count={split.hidden.length} shown={showSpoilers} onToggle={onToggleSpoilers} />
      <PreviousBooksSection works={previousBooks} body={PreviousRecapBody} />
    </View>
  );
}

/** The toggle between a family's reading orders. Each segment is labelled with its
 * order (Publication / Chronological / Recommended), else the series' own name. */
function ReadingOrderToggle({
  rail,
  onSelectView,
}: {
  rail: SeriesRail;
  onSelectView?: (family: string, viewId: string) => void;
}) {
  const { t } = useTranslation();
  const options = rail.views.map((v) => {
    const key = orderingLabelKey(v.ordering);
    return { value: v.id, label: key ? t(key) : v.name };
  });
  return (
    <SegmentedControl
      options={options}
      value={rail.view.id}
      onChange={(id) => onSelectView?.(rail.family, id)}
      accessibilityLabel={t('book.meta.readingOrder')}
      scrollable
      className="max-w-full self-start"
    />
  );
}

/** The Series tab: one horizontal rail per series family the work belongs to
 * (covers open the work on AudioSilo Meta externally). A family with several
 * reading orders gets a toggle; the pick is the SCREEN's (remembered per family on
 * the device), reported through `onSelectView`, so the rail and "previous books"
 * always follow the same order. */
export function BookMetaSeriesTab({
  rails,
  onSelectView,
}: {
  rails: SeriesRail[];
  onSelectView?: (family: string, viewId: string) => void;
}) {
  const { t } = useTranslation();
  const multipleSeries = rails.length > 1;
  return (
    <View className="gap-6">
      {rails.map((rail) => (
        <View key={`${rail.family}:${rail.series.id}`} className="gap-2">
          {multipleSeries ? (
            <SectionHeader
              title={t('book.meta.moreInNamedSeries', {
                series: familyName(rail.series, rail.views),
              })}
            />
          ) : null}
          {rail.views.length > 1 ? (
            <ReadingOrderToggle rail={rail} onSelectView={onSelectView} />
          ) : null}
          {rail.holdsWork ? null : <Text variant="caption">{t('book.meta.notInOrder')}</Text>}
          <ScrollView
            horizontal
            style={HORIZONTAL_SCROLLER}
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-3 pb-1"
          >
            {rail.works.map((w) => (
              <AnimatedPressable
                key={w.id}
                onPress={() => void openExternalUrl(w.web_url)}
                accessibilityRole="link"
                accessibilityLabel={w.title}
                className="w-28"
              >
                <CoverFrame>
                  <Cover source={w.cover_url ?? null} label={w.title} />
                </CoverFrame>
                {w.position ? (
                  <Text variant="caption" className="mt-1.5">
                    {t('book.meta.seriesPosition', { position: w.position })}
                  </Text>
                ) : null}
                <Text variant="label" numberOfLines={2} className="mt-0.5">
                  {w.title}
                </Text>
              </AnimatedPressable>
            ))}
          </ScrollView>
        </View>
      ))}
    </View>
  );
}
