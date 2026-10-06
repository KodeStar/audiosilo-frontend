import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import { type MergedBook, useAllProgressAll } from '@/api/hooks';
import { useApis } from '@/api/provider';
import { useReachability } from '@/api/reachability';
import { roleLabelKey } from '@/components/library/book-meta';
import { gridMetrics } from '@/components/library/cover-layout';
import { CoverTile } from '@/components/library/cover-tile';
import { CoverTileSkeleton } from '@/components/library/cover-grid';
import { SeriesCard } from '@/components/series/series-card';
import type { ProgressLookup } from '@/components/series/series-model';
import { useProgressLookup } from '@/components/series/use-series-data';
import { matchRange } from '@/components/shell/palette-model';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { ErrorNote } from '@/components/ui/query-state';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { contentKey } from '@/lib/content-key';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { bookTitle } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { useSession } from '@/stores/session';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { NameToken } from './name-token';
import {
  alsoOnServers,
  type CharacterHit,
  type NamedHit,
  type PersonHit,
  type SeriesHit,
} from './search-model';
import type { GroupState, SearchResults } from './use-search';

/** Book tiles shown before "Show all": two rows (at least six). */
const BOOK_ROWS = 2;
/** Series, people and characters shown before "Show all". */
const NAMED_PREVIEW = 8;

/**
 * Search's results for a (debounced) query, grouped as the Stacks prototype does: a
 * results line, Books (a cover grid, deduplicated across servers), Series, People
 * (authors and narrators), Characters (only the ones the listener has met; the rest a
 * count). Each group shows its own loading and error state, so one failing group never
 * hides another. Opening any result remembers the query (`onOpened`).
 */
export function SearchResultsView({
  query,
  results,
  pending,
  onOpened,
}: {
  query: string;
  results: SearchResults;
  /** The field has changed since `query`: the results are about to be replaced. */
  pending: boolean;
  onOpened: () => void;
}) {
  const { t } = useTranslation();
  const apis = useApis();
  const online = useReachability((s) => s.online);
  const offline = apis.filter((a) => online[a.connection.id] === false);
  const { progressOf } = useProgressLookup();
  const r = results;
  const settled = r.settled && !pending;

  if (apis.length > 0 && offline.length === apis.length && r.total === 0) {
    return (
      <EmptyState icon="offline" title={t('search.offlineTitle')} hint={t('search.offlineHint')} />
    );
  }

  const peopleCount = r.authors.length + r.narrators.length;
  const nothing =
    settled &&
    r.total === 0 &&
    r.characters.hidden === 0 &&
    !r.booksState.isError &&
    !r.peopleState.isError &&
    !r.charactersState.isError;
  const servers = apis.map((a) => a.connection.name);

  return (
    <View className="gap-8 pt-1">
      {nothing ? null : settled ? (
        <Text variant="muted" accessibilityLiveRegion="polite" style={tabularNums}>
          {servers.length > 1
            ? t('search.resultsAcross', { count: r.total, query, servers: servers.join(' + ') })
            : t('search.resultsFor', { count: r.total, query })}
        </Text>
      ) : (
        <Text variant="muted" accessibilityLiveRegion="polite">
          {t('search.searching')}
        </Text>
      )}
      {offline.length > 0 && offline.length < apis.length ? (
        <Text variant="caption">
          {t('search.someOffline', { servers: offline.map((a) => a.connection.name).join(', ') })}
        </Text>
      ) : null}

      {nothing ? (
        <EmptyState
          icon="search"
          title={t('search.noMatchesTitle', { query })}
          hint={t('search.noMatchesHint')}
          className="py-8"
        />
      ) : null}

      <BooksGroup
        books={r.books}
        state={r.booksState}
        loading={(pending || r.booksState.isLoading) && r.books.length === 0}
        onOpened={onOpened}
      />

      {r.series.length > 0 ? (
        <Group title={t('search.groups.series')} count={r.series.length}>
          <Preview items={r.series} limit={NAMED_PREVIEW} label={t('search.groups.series')}>
            {(items) => (
              <View className="flex-row flex-wrap gap-3">
                {items.map((s) => (
                  <SeriesResult
                    key={`${s.source.connectionId}:${s.source.libraryId}:${s.name}`}
                    hit={s}
                    query={query}
                    progressOf={progressOf}
                    onOpened={onOpened}
                  />
                ))}
              </View>
            )}
          </Preview>
        </Group>
      ) : null}

      {peopleCount > 0 ? (
        <Group title={t('search.groups.people')} count={peopleCount}>
          <Preview
            items={[...r.authors, ...r.narrators]}
            limit={NAMED_PREVIEW}
            label={t('search.groups.people')}
          >
            {(items) => (
              <View className="flex-row flex-wrap gap-2.5">
                {items.map((p, i) => (
                  <PersonChip
                    key={`${i < r.authors.length ? 'a' : 'n'}:${p.name}`}
                    hit={p}
                    kind={r.authors.includes(p) ? 'author' : 'narrator'}
                    query={query}
                    onOpened={onOpened}
                  />
                ))}
              </View>
            )}
          </Preview>
        </Group>
      ) : null}
      <GroupError state={r.peopleState} message={t('search.peopleFailed')} />

      {r.characters.hits.length > 0 || r.characters.hidden > 0 ? (
        <Group
          title={t('search.groups.characters')}
          count={r.characters.hits.length || undefined}
          sub={t('search.charactersSub')}
        >
          <Preview
            items={r.characters.hits}
            limit={NAMED_PREVIEW}
            label={t('search.groups.characters')}
          >
            {(items) => (
              <View className="max-w-[640px] gap-2">
                {items.map((c) => (
                  <CharacterRow key={c.key} hit={c} query={query} onOpened={onOpened} />
                ))}
              </View>
            )}
          </Preview>
          {r.characters.hidden > 0 ? <HiddenStrip count={r.characters.hidden} /> : null}
          {r.characters.attributions.map((a) => (
            <Text
              key={`${a.credit}|${a.license}`}
              variant="caption"
              className="text-subtle-foreground"
            >
              {[a.credit, a.license].filter(Boolean).join(' · ')}
            </Text>
          ))}
        </Group>
      ) : null}
      <GroupError state={r.charactersState} message={t('search.charactersFailed')} />
    </View>
  );
}

/** A results group: a heading with its count (and a quiet sub line), then the body. */
function Group({
  title,
  count,
  sub,
  children,
}: {
  title: string;
  count?: number;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-3" role="group" aria-label={title}>
      <View className="flex-row flex-wrap items-baseline gap-x-2.5">
        <Text variant="heading" role="heading">
          {title}
        </Text>
        {count !== undefined ? (
          <Text variant="caption" style={tabularNums}>
            {count}
          </Text>
        ) : null}
        {sub ? <Text variant="caption">{sub}</Text> : null}
      </View>
      {children}
    </View>
  );
}

/** The first `limit` items, then a "Show all N" toggle. */
function Preview<T>({
  items,
  limit,
  label,
  children,
}: {
  items: T[];
  limit: number;
  label: string;
  children: (items: T[]) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, limit);
  return (
    <>
      {children(shown)}
      {items.length > limit ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          title={all ? t('search.showFewer') : t('search.showAll', { count: items.length })}
          accessibilityLabel={
            all
              ? `${t('search.showFewer')}, ${label}`
              : `${t('search.showAll', { count: items.length })}, ${label}`
          }
          onPress={() => setAll((v) => !v)}
        />
      ) : null}
    </>
  );
}

/** A group's failure: what went wrong and Retry, under whatever else did arrive. */
function GroupError({ state, message }: { state: GroupState; message: string }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  if (!state.isError || state.isLoading) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-3">
      <Icon name="circle-exclamation" size={16} color={themed.destructive} />
      <Text variant="muted" className="shrink">
        {message}
      </Text>
      <Button variant="outline" size="sm" title={t('common.retry')} onPress={state.retry} />
    </View>
  );
}

/** The query's first match in `text`, bold in `brand-ink` (as the palette does). */
function Highlighted({
  text,
  query,
  variant = 'label',
  numberOfLines = 1,
  display = false,
}: {
  text: string;
  query: string;
  variant?: 'label';
  numberOfLines?: number;
  /** Set in the display face (a series card's name), which is bold already. */
  display?: boolean;
}) {
  const range = matchRange(text, query);
  const face = display ? 'font-display text-[17px] tracking-tight' : undefined;
  return (
    <Text variant={variant} numberOfLines={numberOfLines} className={face}>
      {range ? (
        <>
          {text.slice(0, range[0])}
          <Text
            variant={variant}
            className={cn(face, display ? 'text-brand-ink' : 'font-sans-bold text-brand-ink')}
          >
            {text.slice(range[0], range[1])}
          </Text>
          {text.slice(range[1])}
        </>
      ) : (
        text
      )}
    </Text>
  );
}

// --- Books -----------------------------------------------------------------------

function BooksGroup({
  books,
  state,
  loading,
  onOpened,
}: {
  books: MergedBook[];
  state: GroupState;
  /** Nothing to show yet, and an answer is on its way. */
  loading: boolean;
  onOpened: () => void;
}) {
  const { t } = useTranslation();
  const layout = useLayout();
  const [width, setWidth] = useState(0);
  const [all, setAll] = useState(false);
  const { columns, tile, columnGap, rowGap } = gridMetrics(width, layout);
  const preview = Math.max(6, columns * BOOK_ROWS);
  const shown = all ? books : books.slice(0, preview);

  if (!loading && books.length === 0) {
    return state.isError ? (
      <ErrorNote message={t('search.booksFailed')} onRetry={state.retry} />
    ) : null;
  }
  return (
    <Group title={t('search.groups.books')} count={loading ? undefined : books.length}>
      <View
        testID="search-books"
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        className="flex-row flex-wrap"
        style={{ columnGap, rowGap }}
      >
        {width === 0
          ? null
          : loading
            ? Array.from({ length: columns }).map((_, i) => (
                <CoverTileSkeleton key={i} width={tile} />
              ))
            : shown.map((b) => (
                <BookTile
                  key={contentKey(b.connectionId, b.library_id, b.rel_path)}
                  book={b}
                  width={tile}
                  onOpened={onOpened}
                />
              ))}
      </View>
      {state.isError ? (
        <View className="flex-row flex-wrap items-center gap-3">
          <Text variant="muted" className="shrink">
            {t('search.booksPartial')}
          </Text>
          <Button variant="outline" size="sm" title={t('common.retry')} onPress={state.retry} />
        </View>
      ) : null}
      {books.length > preview ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          title={all ? t('search.showFewer') : t('search.showAll', { count: books.length })}
          onPress={() => setAll((v) => !v)}
        />
      ) : null}
    </Group>
  );
}

function BookTile({
  book,
  width,
  onOpened,
}: {
  book: MergedBook;
  width: number;
  onOpened: () => void;
}) {
  const { t } = useTranslation();
  const { openBook } = useOpen();
  const defaultId = useSession((s) => s.defaultConnectionId);
  const { progress } = useAllProgressAll({ refetchOnMount: false });
  const saved = progress.find(
    (p) =>
      p.connectionId === book.connectionId &&
      p.library_id === book.library_id &&
      p.path === book.rel_path,
  );
  const title = bookTitle(book.title, book.rel_path);
  const also = book.also.length
    ? t('search.alsoOn', { servers: book.also.map((a) => a.connectionName).join(', ') })
    : book.other_locations?.length
      ? t('search.alsoIn', {
          libraries: book.other_locations.map((l) => l.library_name).join(', '),
        })
      : undefined;
  return (
    <CoverTile
      connectionId={book.connectionId}
      libraryId={book.library_id}
      path={book.rel_path}
      title={title}
      book={book}
      author={book.author}
      caption={also ?? book.author}
      coverVersion={book.cover_version}
      width={width}
      progress={saved && saved.duration > 0 ? saved.position / saved.duration : undefined}
      finished={saved?.finished}
      server={book.connectionId !== defaultId ? book.connectionName : undefined}
      onPress={() => {
        onOpened();
        openBook(book.connectionId, book.library_id, book.rel_path);
      }}
    />
  );
}

// --- Series, people, characters ---------------------------------------------------

/** "Hearthside · Also on Maya's Shelf": where a person or series lives, when it isn't
 * only the one server. */
function useWhere(hit: NamedHit<object>) {
  const { t } = useTranslation();
  const many = useApis().length > 1;
  const others = alsoOnServers(hit);
  if (!many) return undefined;
  return [
    hit.source.connectionName,
    others.length ? t('search.alsoOn', { servers: others.join(', ') }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A series result: the Library's series card (its mini shelf fetches the series' books
 * once the card shows, so only the results on screen ask), with the match in bold. */
function SeriesResult({
  hit,
  query,
  progressOf,
  onOpened,
}: {
  hit: SeriesHit;
  query: string;
  progressOf: ProgressLookup;
  onOpened: () => void;
}) {
  const { t } = useTranslation();
  const where = useWhere(hit);
  return (
    // The prototype's `repeat(auto-fill, minmax(300px, 1fr))`, near enough: a lone card
    // doesn't stretch across a desktop page.
    <View style={{ flexBasis: 300, maxWidth: 520 }} className="grow">
      <SeriesCard
        series={hit}
        connectionId={hit.source.connectionId}
        connectionName={hit.source.connectionName}
        libraryId={hit.source.libraryId}
        progressOf={progressOf}
        heading={<Highlighted text={hit.name} query={query} numberOfLines={2} display />}
        kindLabel={t('search.seriesRole')}
        where={where}
        onOpened={onOpened}
      />
    </View>
  );
}

function PersonChip({
  hit,
  kind,
  query,
  onOpened,
}: {
  hit: PersonHit;
  kind: 'author' | 'narrator';
  query: string;
  onOpened: () => void;
}) {
  const { t } = useTranslation();
  const { openAuthor, openNarrator } = useOpen();
  const where = useWhere(hit);
  const role = kind === 'author' ? t('search.roleAuthor') : t('search.roleNarrator');
  const books = t('search.bookCount', { count: hit.books });
  return (
    <Pressable
      onPress={() => {
        onOpened();
        (kind === 'author' ? openAuthor : openNarrator)(
          hit.source.connectionId,
          hit.source.libraryId,
          hit.name,
        );
      }}
      accessibilityRole="button"
      accessibilityLabel={[hit.name, role, books, where].filter(Boolean).join(', ')}
      className={cn(
        'h-11 max-w-full flex-row items-center gap-2 rounded-full border border-border-strong bg-card pl-[5px] pr-3.5 active:bg-accent',
        Platform.select({
          web: `cursor-pointer transition-colors hover:bg-accent ${FOCUS_RING_OFFSET_CLASS}`,
        }),
      )}
    >
      <NameToken name={hit.name} kind={kind} size={34} />
      <View className="shrink">
        <Highlighted text={hit.name} query={query} />
      </View>
      <Text variant="caption" numberOfLines={1}>
        {role}
      </Text>
    </Pressable>
  );
}

function CharacterRow({
  hit,
  query,
  onOpened,
}: {
  hit: CharacterHit;
  query: string;
  onOpened: () => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const { openBook } = useOpen();
  const roleKey = roleLabelKey(hit.role);
  const line = [roleKey ? t(roleKey) : null, hit.bookTitle].filter(Boolean).join(' · ');
  return (
    <Pressable
      onPress={() => {
        onOpened();
        openBook(hit.connectionId, hit.libraryId, hit.path);
      }}
      accessibilityRole="button"
      accessibilityLabel={[hit.name, line].join(', ')}
      className={cn(
        'min-h-[64px] flex-row items-center gap-3 rounded-menu border border-border bg-card p-3 active:bg-accent',
        Platform.select({
          web: `cursor-pointer transition-colors hover:bg-accent ${FOCUS_RING_OFFSET_CLASS}`,
        }),
      )}
    >
      <NameToken name={hit.name} kind="character" size={40} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Highlighted text={hit.name} query={query} />
        <Text variant="caption" numberOfLines={1}>
          {line}
        </Text>
      </View>
      <Icon name="chevron-right" size={16} color={themed.subtleForeground} />
    </Pressable>
  );
}

/** The characters matching the query that the listener hasn't reached: counted, kindly,
 * never named (STYLEGUIDE section 9, spoiler safety). */
function HiddenStrip({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <View className="max-w-[640px] flex-row items-center gap-3 rounded-menu border-[1.5px] border-dashed border-border-strong bg-muted/60 px-3.5 py-3">
      <NameToken kind="character" size={30} hidden />
      <Text variant="muted" className="flex-1">
        {t('search.hiddenCharacters', { count })}
      </Text>
    </View>
  );
}
